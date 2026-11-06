import { describe, expect, it } from "vitest";
import { boardChangeTasks, currentPlanner, featureId, features, initialState, isChangePlanner, reduce } from "../src/lib/reduce";
import { canRequestChange, checkChangeText, nextChangeNumber, CHANGE_TEXT_MAX } from "../convex/changes";
import type { EngineEvent, ProjectState } from "../src/lib/types";

const ev = (t: number, kind: EngineEvent["kind"], task_id: string | null, data: Record<string, unknown>): EngineEvent =>
  ({ t, kind, task_id, data });

const plan = { project: "x", contracts: [], tasks: [
  { id: "T1", title: "Slots", module: "src/server/slots.ts", spec: "", depends_on: [] },
  { id: "T2", title: "Bookings", module: "src/server/bookings.ts", spec: "", depends_on: ["T1"] }] };

const change = {
  n: 1, request: "Store times in the salon's time zone and add reviews",
  summary: "Bookings keep the salon's time zone; customers can leave a review.",
  contracts: ["supabase/migrations/0003_timezone.sql"],
  tasks: [
    { id: "C1T1", kind: "change", title: "Salon time zone", module: "src/server/bookings.ts", spec: "tz", depends_on: [] },
    { id: "C1T2", kind: "new", title: "Reviews", module: "src/server/reviews.ts", spec: "reviews", depends_on: ["C1T1"] },
  ],
  pages: ["/", "/book"],
};

/** A finished first build: T1, T2 and INT merged. */
function built(): ProjectState {
  let s = reduce(initialState(), ev(0, "plan_ready", null, { plan }));
  s = reduce(s, ev(1, "plan_decision", null, { approved: true }));
  for (const id of ["T1", "T2"]) {
    s = reduce(s, ev(2, "task_queued", id, { title: id, role: "dev", depends_on: [] }));
    s = reduce(s, ev(3, "task_status", id, { status: "merged" }));
  }
  s = reduce(s, ev(4, "task_queued", "INT", { title: "Integrate", role: "dev", depends_on: ["T1", "T2"] }));
  s = reduce(s, ev(5, "task_status", "INT", { status: "merged" }));
  return reduce(s, ev(6, "project_finished", null, { status: "done" }));
}

/** built(), then change 1 started and planned. */
function planned(): ProjectState {
  let s = reduce(built(), ev(10, "change_started", null, { n: 1, text: change.request }));
  s = reduce(s, ev(11, "task_queued", "C1PLAN", { title: "Plan change 1", role: "planner", depends_on: [] }));
  return reduce(s, ev(12, "change_plan_ready", null, { n: 1, change }));
}

describe("change events", () => {
  it("change_started puts the project back to planning and says what was asked, in the planning channel", () => {
    const s = reduce(built(), ev(10, "change_started", null, { n: 1, text: "Show the heading once" }));
    expect(s.status).toBe("planning");
    expect(s.change).toMatchObject({ n: 1, text: "Show the heading once", decision: "planning", before: "done" });
    expect(s.feed.at(-1)).toMatchObject({ who: "you", channel: "planning", text: "Change 1 requested: Show the heading once" });
  });

  it("treats C1PLAN as the planner: planning channel, and the planning screen follows its notes", () => {
    let s = reduce(built(), ev(10, "change_started", null, { n: 1, text: "Show the heading once" }));
    s = reduce(s, ev(11, "task_queued", "C1PLAN", { title: "Plan change 1", role: "planner", depends_on: [] }));
    expect(s.feed.at(-1)).toMatchObject({ who: "planner", channel: "planning" });
    expect(s.feed.at(-1)!.text).toContain("change request");
    s = reduce(s, ev(12, "task_status", "C1PLAN", { status: "working", attempt: 1 }));
    s = reduce(s, ev(13, "agent_activity", "C1PLAN", { note: "Read src/server/bookings.ts" }));
    expect(isChangePlanner("C1PLAN")).toBe(true);
    expect(isChangePlanner("PLAN")).toBe(false);
    expect(currentPlanner(s)?.id).toBe("C1PLAN");
    expect(currentPlanner(s)?.notes).toEqual(["Read src/server/bookings.ts"]);
  });

  it("change_plan_ready stores the change and waits for approval", () => {
    const s = planned();
    expect(s.status).toBe("awaiting_approval");
    expect(s.change).toMatchObject({ n: 1, summary: change.summary, decision: "pending", pages: ["/", "/book"] });
    expect(s.change!.tasks.map((t) => [t.id, t.kind])).toEqual([["C1T1", "change"], ["C1T2", "new"]]);
    expect(s.changes).toHaveLength(1);
    expect(s.feed.at(-1)).toMatchObject({ who: "planner", channel: "planning" });
    expect(s.feed.at(-1)!.text).toContain("Change 1 planned: 2 tasks");
    // the original plan is untouched
    expect(s.plan).toEqual(plan);
  });

  it("an approved change says so and goes back to building", () => {
    const s = reduce(planned(), ev(13, "plan_decision", null, { approved: true, note: "" }));
    expect(s.status).toBe("building");
    expect(s.change!.decision).toBe("approved");
    expect(s.feed.at(-1)!.text).toBe("Approved change 1. Building started.");
  });

  it("a sent-back change restores the earlier status when the run finishes", () => {
    let s = reduce(planned(), ev(13, "plan_decision", null, { approved: false, note: "only the time zone" }));
    expect(s.status).toBe("rejected");
    expect(s.feed.at(-1)!.text).toBe("Sent change 1 back: only the time zone");
    s = reduce(s, ev(14, "project_finished", null, { status: "rejected", repo: "r" }));
    expect(s.status).toBe("done");
    expect(features(s).map((f) => f.id)).toEqual(["T1", "T2", "INT"]);
  });
});

describe("change tasks on the board", () => {
  it("are not on the board while the change waits for approval", () => {
    expect(features(planned()).map((f) => f.id)).toEqual(["T1", "T2", "INT"]);
    expect(boardChangeTasks(planned())).toEqual([]);
  });

  it("appear after the original cards and before INT once approved, with the change's titles and modules", () => {
    let s = reduce(planned(), ev(13, "plan_decision", null, { approved: true }));
    s = reduce(s, ev(14, "task_queued", "C1T1-qa", { title: "Acceptance tests for Salon time zone", role: "qa", depends_on: [] }));
    s = reduce(s, ev(14, "task_queued", "C1T1", { title: "Salon time zone", role: "dev", depends_on: ["C1T1-qa"] }));
    s = reduce(s, ev(15, "task_queued", "INT", { title: "Integrate", role: "dev", depends_on: ["C1T1", "C1T2"] }));
    const fs = features(s);
    expect(fs.map((f) => f.id)).toEqual(["T1", "T2", "C1T1", "C1T2", "INT"]);
    const c1 = fs.find((f) => f.id === "C1T1")!;
    expect(c1).toMatchObject({ title: "Salon time zone", module: "src/server/bookings.ts", column: "queued" });
    expect(c1.qa?.id).toBe("C1T1-qa");
    expect(fs.find((f) => f.id === "C1T2")!.waitingOn).toEqual(["C1T1"]);
    // the new INT run starts over and waits for the change
    expect(fs.at(-1)!.column).toBe("queued");
    expect(fs.at(-1)!.waitingOn).toEqual(["C1T1", "C1T2"]);
    // the original features stay done
    expect(fs.filter((f) => f.column === "done").map((f) => f.id)).toEqual(["T1", "T2"]);
  });

  it("maps a change's QA id to its card and names it in the feed", () => {
    expect(featureId("C1T1-qa")).toBe("C1T1");
    expect(featureId("C12T3-qa")).toBe("C12T3");
    let s = reduce(planned(), ev(13, "plan_decision", null, { approved: true }));
    s = reduce(s, ev(14, "task_queued", "C1T1-qa", { title: "Acceptance tests for Salon time zone", role: "qa", depends_on: [] }));
    s = reduce(s, ev(15, "task_status", "C1T1-qa", { status: "working", attempt: 1 }));
    expect(features(s).find((f) => f.id === "C1T1")!.column).toBe("tests");
    expect(s.feed.at(-1)).toMatchObject({ channel: "tests", text: "Salon time zone: writing acceptance tests." });
    s = reduce(s, ev(16, "task_status", "C1T1-qa", { status: "passed" }));
    expect(s.feed.at(-1)!.text).toContain("fails on the current code");
    s = reduce(s, ev(17, "task_queued", "C1T1", { title: "Salon time zone", role: "dev", depends_on: [] }));
    s = reduce(s, ev(18, "task_status", "C1T1", { status: "working", attempt: 1 }));
    expect(s.feed.at(-1)!.text).toBe("Salon time zone: building src/server/bookings.ts.");
  });

  it("keeps several changes in order", () => {
    let s = reduce(planned(), ev(13, "plan_decision", null, { approved: true }));
    s = reduce(s, ev(20, "project_finished", null, { status: "done" }));
    s = reduce(s, ev(30, "change_started", null, { n: 2, text: "Add a footer link" }));
    s = reduce(s, ev(31, "change_plan_ready", null, { n: 2, change: { n: 2, summary: "Footer", contracts: [], pages: [],
      tasks: [{ id: "C2T1", kind: "new", title: "Footer links", module: "src/server/links.ts", spec: "", depends_on: [] }] } }));
    s = reduce(s, ev(32, "plan_decision", null, { approved: true }));
    expect(s.changes.map((c) => c.n)).toEqual([1, 2]);
    expect(s.change!.n).toBe(2);
    expect(features(s).map((f) => f.id)).toEqual(["T1", "T2", "C1T1", "C1T2", "C2T1", "INT"]);
  });
});

describe("change request rules", () => {
  it("allows a change when done, or failed with a plan, and nothing runs", () => {
    expect(canRequestChange("done", true, false)).toBe(true);
    expect(canRequestChange("failed", true, false)).toBe(true);
    expect(canRequestChange("failed", false, false)).toBe(false);
    expect(canRequestChange("done", true, true)).toBe(false);
    for (const st of ["queued", "starting", "planning", "awaiting_approval", "approved", "building", "rejected", "draft"]) {
      expect(canRequestChange(st, true, false)).toBe(false);
    }
  });

  it("trims the text and keeps it between 10 and 4000 characters", () => {
    expect(checkChangeText("  Show the heading once  ")).toEqual({ ok: true, text: "Show the heading once" });
    expect(checkChangeText("   too short ".slice(0, 9)).ok).toBe(false);
    expect(checkChangeText("x".repeat(CHANGE_TEXT_MAX)).ok).toBe(true);
    const long = checkChangeText("x".repeat(CHANGE_TEXT_MAX + 1));
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.message).toContain("4000");
  });

  it("numbers changes 1, 2, ...", () => {
    expect(nextChangeNumber(undefined)).toBe(1);
    expect(nextChangeNumber([{ n: 1, text: "a", at: 0 }, { n: 2, text: "b", at: 1 }])).toBe(3);
  });
});

describe("a change that already holds", () => {
  it("is reported in the build channel as needing no code", () => {
    const plan = { project: "x", contracts: [], tasks: [{ id: "T1", title: "Salon", module: "src/server/salon.ts", spec: "", depends_on: [] }] };
    let s = reduce(initialState(), { t: 0, kind: "plan_ready", task_id: null, data: { plan } });
    s = reduce(s, { t: 1, kind: "task_queued", task_id: "C1T2", data: { title: "Slots in Pacific time", role: "dev", depends_on: [] } });
    s = reduce(s, { t: 2, kind: "task_status", task_id: "C1T2", data: { status: "already_done" } });
    expect(s.feed.at(-1)!.text).toContain("already holds on the current code");
    expect(s.feed.at(-1)!.tone).toBe("good");
  });
});

describe("changeForWorker", () => {
  it("passes the template upgrade opt-in to the worker only when the owner asked for it", async () => {
    const { changeForWorker } = await import("../convex/changes");
    expect(changeForWorker(undefined)).toBeNull();
    expect(changeForWorker({ n: 2, text: "Add a waitlist", at: 1 })).toEqual({ n: 2, text: "Add a waitlist" });
    expect(changeForWorker({ n: 3, text: "x".repeat(20), at: 1, upgradeTemplate: true }))
      .toEqual({ n: 3, text: "x".repeat(20), upgradeTemplate: true });
  });
});
