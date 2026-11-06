import { describe, expect, it } from "vitest";
import { features, initialState, reduce } from "../src/lib/reduce";
import type { EngineEvent } from "../src/lib/types";
import { BUDGET_DEFAULT, budgetOf, canSpendMore, checkBudget } from "../convex/budget";
import { emailBody, notificationFor, notificationPath } from "../convex/notifications";
import { badgeText, freshUnread, shouldAlert, timeAgo, type NotificationItem } from "../src/lib/notify";

const ev = (t: number, kind: EngineEvent["kind"], task_id: string | null, data: Record<string, unknown>): EngineEvent =>
  ({ t, kind, task_id, data });
const plan = { project: "x", contracts: [], tasks: [
  { id: "T1", title: "Slots", module: "src/server/slots.ts", spec: "", depends_on: [] },
  { id: "T2", title: "Bookings", module: "src/server/bookings.ts", spec: "", depends_on: [] }] };

describe("reducer: spending limit", () => {
  const stopped = () => {
    let s = reduce(initialState(), ev(0, "plan_ready", null, { plan }));
    s = reduce(s, ev(1, "plan_decision", null, { approved: true }));
    s = reduce(s, ev(2, "task_queued", "T1", { title: "Slots", role: "dev", depends_on: [] }));
    s = reduce(s, ev(3, "task_queued", "T2", { title: "Bookings", role: "dev", depends_on: [] }));
    s = reduce(s, ev(4, "attempt_finished", "T1", { n: 1, passed: true, claim: "done", reason: "", cost_usd: 4.8,
                                                   seconds: 1, turns: 1, files_changed: [] }));
    s = reduce(s, ev(5, "task_status", "T1", { status: "merged" }));
    s = reduce(s, ev(6, "budget_reached", null, { spent: 5.02, budget: 5 }));
    s = reduce(s, ev(7, "task_status", "T2", { status: "stopped", error: "stopped at the project's spending limit" }));
    return reduce(s, ev(8, "project_finished", null, { status: "stopped" }));
  };

  it("says the limit was reached once, and the project ends stopped", () => {
    const s = stopped();
    expect(s.status).toBe("stopped");
    expect(s.budget_reached).toEqual({ spent: 5.02, budget: 5 });
    const notes = s.feed.filter((f) => f.text.includes("spending limit"));
    expect(notes[0].text).toContain("$5.02 of $5.00");
    expect(s.feed.at(-1)!.text).toMatch(/^Stopped at the spending limit: 1 of 2 features/);
    expect(s.feed.at(-1)!.tone).toBe("warn");
  });

  it("puts stopped tasks under Needs you, and a retry clears the limit notice", () => {
    let s = stopped();
    expect(features(s).find((f) => f.id === "T2")!.column).toBe("attention");
    s = reduce(s, ev(9, "build_resumed", null, { merged: ["PLAN", "T1"], retrying: ["T2"] }));
    expect(s.status).toBe("building");
    expect(s.budget_reached).toBeNull();
  });

  it("counts review costs in the total even though reviews are never queued", () => {
    let s = reduce(initialState(), ev(0, "plan_ready", null, { plan }));
    s = reduce(s, ev(1, "attempt_finished", "T1-review", { n: 1, passed: true, claim: "done", reason: "", cost_usd: 0.05,
                                                           seconds: 1, turns: 1, files_changed: [] }));
    expect(s.cost_usd).toBe(0.05);
  });
});

describe("budget rules", () => {
  it("accepts $1 to $50, rounded to cents", () => {
    expect(checkBudget(5)).toEqual({ ok: true, usd: 5 });
    expect(checkBudget(12.345)).toEqual({ ok: true, usd: 12.35 });
    expect(checkBudget(0.5).ok).toBe(false);
    expect(checkBudget(51).ok).toBe(false);
    expect(checkBudget(Number("abc")).ok).toBe(false);
  });
  it("defaults old projects and needs room left to start a run", () => {
    expect(budgetOf({})).toBe(BUDGET_DEFAULT);
    expect(budgetOf({ budgetUsd: 9 })).toBe(9);
    expect(canSpendMore(4.99, 5)).toBe(false);
    expect(canSpendMore(4, 5)).toBe(true);
  });
});

describe("notifications", () => {
  it("are written for approvals, finished builds, the limit and previews", () => {
    expect(notificationFor("plan_ready", {}, "Pawfect")).toMatchObject({ kind: "needs_approval", email: true });
    expect(notificationFor("change_plan_ready", { n: 2 }, "Pawfect")!.title).toBe("Pawfect: change 2 is planned");
    for (const status of ["done", "failed", "stopped"]) {
      expect(notificationFor("project_finished", { status }, "Pawfect")).toMatchObject({ kind: "finished", email: true });
    }
    expect(notificationFor("budget_reached", { spent: 5.02, budget: 5 }, "P")!.body).toContain("$5.02 of $5.00");
    expect(notificationFor("preview_ready", { url: "https://x.vercel.app" }, "P")).toMatchObject({ kind: "preview_ready", email: false });
  });
  it("are not written for everything else", () => {
    expect(notificationFor("project_finished", { status: "rejected" }, "P")).toBeNull();
    expect(notificationFor("preview_ready", { url: "javascript:alert(1)" }, "P")).toBeNull();
    expect(notificationFor("task_status", { status: "merged" }, "P")).toBeNull();
    expect(notificationFor("attempt_finished", null, "P")).toBeNull();
  });
  it("link to the plan when you're needed there, else the board", () => {
    expect(notificationPath("abc", "needs_approval")).toBe("/p/abc/plan");
    expect(notificationPath("abc", "budget_reached")).toBe("/p/abc/plan");
    expect(notificationPath("abc", "finished")).toBe("/p/abc/board");
  });
  it("email a link only when the app's URL is known", () => {
    expect(emailBody("T", "B", "/p/a/plan", "https://studio.app/").text).toContain("https://studio.app/p/a/plan");
    expect(emailBody("T", "B", "/p/a/plan", undefined).text).not.toContain("/p/a/plan");
  });
});

describe("browser alerts", () => {
  const item = (id: string, ts: number, read = false): NotificationItem =>
    ({ id, projectId: "p", kind: "finished", title: id, body: "", ts, read, href: "/p/p/board" });

  it("alert only for unread notifications that arrive after the page loaded", () => {
    const seen = new Set<string>();
    expect(freshUnread(seen, [item("a", 1)], true)).toEqual([]);          // already there on load
    const fresh = freshUnread(seen, [item("c", 3), item("b", 2), item("r", 4, true), item("a", 1)], false);
    expect(fresh.map((n) => n.id)).toEqual(["b", "c"]);
    expect(freshUnread(seen, [item("c", 3), item("b", 2)], false)).toEqual([]);   // never twice
  });
  it("only when granted and the tab is hidden", () => {
    expect(shouldAlert("granted", true)).toBe(true);
    expect(shouldAlert("granted", false)).toBe(false);
    expect(shouldAlert("default", true)).toBe(false);
    expect(shouldAlert(undefined, true)).toBe(false);
  });
  it("format the badge and the age", () => {
    expect(badgeText(0)).toBe("");
    expect(badgeText(3)).toBe("3");
    expect(badgeText(12)).toBe("9+");
    expect(timeAgo(0, 30_000)).toBe("just now");
    expect(timeAgo(0, 5 * 60_000)).toBe("5 min ago");
    expect(timeAgo(0, 3 * 3_600_000)).toBe("3 h ago");
    expect(timeAgo(0, 2 * 86_400_000)).toBe("2 d ago");
  });
});

describe("a run the worker refused to start", () => {
  it("notifies with the reason", () => {
    expect(notificationFor("project_finished", { status: "failed", reason: "the key can't be used" }, "Pawfect"))
      .toMatchObject({ kind: "finished", title: "Pawfect couldn't start", body: "the key can't be used" });
    expect(notificationFor("project_finished", { status: "failed" }, "Pawfect")!.title).toBe("Pawfect stopped with problems");
  });
});
