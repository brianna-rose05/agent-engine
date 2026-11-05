import { describe, expect, it } from "vitest";
import { features, initialState, isQuick, quickId, reduce } from "../src/lib/reduce";
import {
  QUICK_TEXT_MAX, canRequestQuickChange, checkQuickText, nextQuickNumber, quickForWorker, quickPatch, type QuickChange,
} from "../convex/quick";
import type { EngineEvent, ProjectState } from "../src/lib/types";

const ev = (t: number, kind: EngineEvent["kind"], task_id: string | null, data: Record<string, unknown>): EngineEvent =>
  ({ t, kind, task_id, data });

const plan = { project: "x", contracts: [], tasks: [
  { id: "T1", title: "Slots", module: "src/server/slots.ts", spec: "", depends_on: [] }] };

/** A finished build: T1 and INT merged. */
function built(): ProjectState {
  let s = reduce(initialState(), ev(0, "plan_ready", null, { plan }));
  s = reduce(s, ev(1, "plan_decision", null, { approved: true }));
  s = reduce(s, ev(2, "task_queued", "T1", { title: "Slots", role: "dev", depends_on: [] }));
  s = reduce(s, ev(3, "task_status", "T1", { status: "merged" }));
  s = reduce(s, ev(4, "task_queued", "INT", { title: "Integrate", role: "dev", depends_on: ["T1"] }));
  s = reduce(s, ev(5, "task_status", "INT", { status: "merged" }));
  return reduce(s, ev(6, "project_finished", null, { status: "done" }));
}

const TEXT = "Make the Book button green";

/** built(), then quick change 1 started and its task queued and working. */
function started(): ProjectState {
  let s = reduce(built(), ev(10, "quick_started", null, { n: 1, text: TEXT }));
  s = reduce(s, ev(11, "task_queued", "Q1", { title: "Quick change 1", role: "dev", depends_on: [] }));
  return reduce(s, ev(12, "task_status", "Q1", { status: "working", attempt: 1 }));
}

const attempt = (passed: boolean, claim: string, reason: string) =>
  ({ n: 1, passed, claim, reason, cost_usd: 0.03, seconds: 60, turns: 9, files_changed: [], output: "" });

describe("quick changes in the reducer", () => {
  it("runs one Q card after the integration card, then merges and the project is done", () => {
    let s = started();
    expect(s.status).toBe("building");
    expect(s.quicks).toEqual([{ n: 1, text: TEXT, result: "running", before: "done" }]);
    expect(features(s).map((f) => f.id)).toEqual(["T1", "INT", "Q1"]);
    const card = features(s).at(-1)!;
    expect(card.column).toBe("building");
    expect(card.spec).toContain(TEXT);
    expect(s.feed.map((f) => f.text)).toContain(`Quick change 1 requested: ${TEXT}`);
    expect(s.feed.at(-1)!.text).toBe("Quick change 1: building the pages and components.");

    s = reduce(s, ev(13, "attempt_finished", "Q1", attempt(true, "done", "")));
    s = reduce(s, ev(14, "task_status", "Q1", { status: "merged" }));
    s = reduce(s, ev(15, "project_finished", null, { status: "done" }));
    expect(s.status).toBe("done");
    expect(s.quicks[0].result).toBe("done");
    expect(features(s).at(-1)!.column).toBe("done");
    expect(s.cost_usd).toBeCloseTo(0.03);
    expect(s.feed.at(-1)!).toMatchObject({ tone: "good", task_id: "Q1" });
    expect(s.feed.at(-1)!.text).toContain("Quick change 1 is live in the repo");
    expect(s.feed.filter((f) => f.text.startsWith("Finished:")).length).toBe(1);   // only the first build's
  });

  it("a blocked quick change leaves the app as it was and says to send a change request", () => {
    const reason = "needs a change request: a pet's breed has to be stored";
    let s = reduce(started(), ev(13, "attempt_finished", "Q1", attempt(false, `blocked: ${reason}`, reason)));
    s = reduce(s, ev(14, "task_status", "Q1", { status: "blocked", error: reason }));
    s = reduce(s, ev(15, "quick_blocked", null, { n: 1, reason }));
    s = reduce(s, ev(16, "project_finished", null, { status: "blocked" }));
    expect(s.status).toBe("done");
    expect(s.quicks[0]).toMatchObject({ result: "blocked", reason });
    expect(features(s).at(-1)!.column).toBe("attention");
    const texts = s.feed.map((f) => f.text);
    expect(texts.filter((t) => t.includes("rejected") || t.startsWith("Paused"))).toEqual([]);
    expect(texts.at(-1)).toBe("Quick change 1 is bigger than a quick change (a pet's breed has to be stored). " +
                              "Nothing was changed. Send it as a change request instead, and the planner will plan it.");
  });

  it("a pre-screened request has no card, and a failed one says the app is as it was", () => {
    let s = reduce(built(), ev(10, "quick_started", null, { n: 1, text: "Take card payments" }));
    s = reduce(s, ev(11, "quick_blocked", null, { n: 1, reason: "needs a change request: it asks for payments" }));
    s = reduce(s, ev(12, "project_finished", null, { status: "blocked" }));
    expect(s.status).toBe("done");
    expect(features(s).map((f) => f.id)).toEqual(["T1", "INT"]);
    expect(s.feed.at(-1)!.text).toContain("(it asks for payments)");

    let f = reduce(started(), ev(13, "attempt_finished", "Q1", attempt(false, "done", "the app doesn't build")));
    f = reduce(f, ev(14, "task_status", "Q1", { status: "failed" }));
    f = reduce(f, ev(15, "project_finished", null, { status: "failed" }));
    expect(f.status).toBe("done");
    expect(f.quicks[0].result).toBe("failed");
    expect(f.feed.map((x) => x.text)).toContain("Quick change 1 needs you: 2 tries, still not passing the whole-app check.");
    expect(f.feed.at(-1)!.text).toBe("Quick change 1 didn't pass the whole-app check, so nothing was merged. The app is as it was.");
  });

  it("quick ids", () => {
    expect(quickId(3)).toBe("Q3");
    expect([isQuick("Q12"), isQuick("QA"), isQuick("C1T1"), isQuick("T1-qa")]).toEqual([true, false, false, false]);
  });
});

describe("quick change rules (convex/quick.ts)", () => {
  it("can be asked for only on a built app with a repo and nothing running", () => {
    expect(canRequestQuickChange("done", true, false)).toBe(true);
    expect(canRequestQuickChange("done", false, false)).toBe(false);
    expect(canRequestQuickChange("done", true, true)).toBe(false);
    for (const s of ["failed", "building", "queued", "awaiting_approval", "rejected"]) {
      expect(canRequestQuickChange(s, true, false)).toBe(false);
    }
  });

  it("checks the text: 5 to 1000 characters, trimmed", () => {
    expect(checkQuickText("  Bigger  ")).toEqual({ ok: true, text: "Bigger" });
    expect(checkQuickText("abcd").ok).toBe(false);
    expect(checkQuickText("x".repeat(QUICK_TEXT_MAX)).ok).toBe(true);
    expect(checkQuickText("x".repeat(QUICK_TEXT_MAX + 1)).ok).toBe(false);
    expect(nextQuickNumber(undefined)).toBe(1);
    expect(nextQuickNumber([{ n: 1, text: "a", at: 0 }, { n: 4, text: "b", at: 0 }])).toBe(5);
  });

  it("tells the worker the latest quick change only in quick mode", () => {
    const quicks: QuickChange[] = [{ n: 1, text: "a", at: 0, result: "done" }, { n: 2, text: "Green button", at: 1 }];
    expect(quickForWorker({ mode: "quick", quicks })).toEqual({ n: 2, text: "Green button" });
    expect(quickForWorker({ mode: "change", quicks })).toBeNull();
    expect(quickForWorker({ mode: "quick" })).toBeNull();
  });

  it("patches the project row from the engine's events", () => {
    const row = { mode: "quick", quicks: [{ n: 1, text: "a", at: 0 }] as QuickChange[] };
    expect(quickPatch(row, "quick_started", { n: 1, text: "a" })).toEqual({ status: "building" });
    const blocked = quickPatch(row, "quick_blocked", { n: 1, reason: "needs a change request: data" });
    expect(blocked).toEqual({ quicks: [{ n: 1, text: "a", at: 0, result: "blocked", reason: "needs a change request: data" }] });
    expect(quickPatch({ ...row, ...blocked }, "project_finished", { status: "blocked" }))
      .toEqual({ status: "done", quicks: [{ n: 1, text: "a", at: 0, result: "blocked", reason: "needs a change request: data" }] });
    expect(quickPatch(row, "project_finished", { status: "done" })).toEqual({ status: "done", quicks: [{ n: 1, text: "a", at: 0, result: "done" }] });
    expect(quickPatch(row, "project_finished", { status: "failed" })).toEqual({ status: "done", quicks: [{ n: 1, text: "a", at: 0, result: "failed" }] });
    expect(quickPatch({ ...row, mode: "change" }, "project_finished", { status: "failed" })).toEqual({});
    expect(quickPatch(row, "task_status", { status: "merged" })).toEqual({});
  });
});
