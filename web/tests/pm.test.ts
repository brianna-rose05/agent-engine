import { describe, expect, it } from "vitest";
import { estimateBuild } from "../src/lib/estimate";
import { listText, pmSuggestion, savedForLater } from "../src/lib/pm";
import { features, initialState, reduce } from "../src/lib/reduce";
import type { EngineEvent, PlanTask, ProjectState } from "../src/lib/types";
import { BUILD_SAVED_PATCH, buildSavedBlocker, checkDeferred, decisionDeferred, dependentsOf, priorityOf } from "../convex/pm";
import { notificationFor, notificationPath } from "../convex/notifications";
import { composeSpec, type Wizard } from "../convex/wizard";

const ev = (t: number, kind: EngineEvent["kind"], task_id: string | null, data: Record<string, unknown>): EngineEvent =>
  ({ t, kind, task_id, data });

type P = PlanTask["priority"];
const server = (id: string, priority?: P, depends_on: string[] = []): PlanTask =>
  ({ id, title: `Feature ${id}`, module: `src/server/${id}.ts`, spec: "", depends_on, ...(priority ? { priority } : {}) });
const ui = (id: string, priority?: P, depends_on: string[] = []): PlanTask =>
  ({ ...server(id, priority, depends_on), module: `src/components/${id}.tsx` });

/** The suggestion for a plan against a limit, with its own estimate. */
const suggest = (tasks: PlanTask[], budget: number, spent = 0) => pmSuggestion(tasks, estimateBuild(tasks), spent, budget);

describe("pmSuggestion", () => {
  it("says nothing when the low estimate fits", () => {
    const tasks = [server("T1", "must"), server("T2", "could")];
    const e = estimateBuild(tasks);
    expect(pmSuggestion(tasks, e, 0, e.low)).toEqual({ kind: "fits" });
    expect(pmSuggestion(tasks, e, 0, e.high + 1)).toEqual({ kind: "fits" });
  });

  it("saves Coulds before Shoulds, and the most expensive Could first", () => {
    // T3 (a screen) costs more than T2 (server); both Coulds go before the Should
    const tasks = [server("T1", "must"), server("T2", "could"), ui("T3", "could"), server("T4", "should")];
    const full = estimateBuild(tasks);
    const withoutT3 = estimateBuild(tasks.filter((t) => t.id !== "T3"), { integration: true });
    // just enough room once T3 is saved
    const s = pmSuggestion(tasks, full, 0, withoutT3.low);
    expect(s).toMatchObject({ kind: "defer", tasks: ["T3"], titles: ["Feature T3"] });
    if (s.kind !== "defer") throw new Error("expected defer");
    expect(s.saves).toBeGreaterThan(0);
    expect(s.estimate.low).toBeCloseTo(withoutT3.low);

    // less room: both Coulds, then the Should
    const twoCoulds = estimateBuild([tasks[0], tasks[3]], { integration: true });
    expect(pmSuggestion(tasks, full, 0, twoCoulds.low)).toMatchObject({ kind: "defer", tasks: ["T2", "T3"] });
    const onlyMust = estimateBuild([tasks[0]], { integration: true });
    expect(pmSuggestion(tasks, full, 0, onlyMust.low)).toMatchObject({ kind: "defer", tasks: ["T2", "T3", "T4"] });
  });

  it("counts what was already spent", () => {
    const tasks = [server("T1", "must"), ui("T2", "could")];
    const e = estimateBuild(tasks);
    expect(pmSuggestion(tasks, e, 0, e.low)).toEqual({ kind: "fits" });
    expect(pmSuggestion(tasks, e, 0.05, e.low)).toMatchObject({ kind: "defer", tasks: ["T2"] });
    expect(pmSuggestion(tasks, e, 0.5, e.low)).toEqual({ kind: "cannot_fit", deferrable: 1 });
  });

  it("never saves a Must, and old plans without priorities are all Musts", () => {
    const tasks = [server("T1"), ui("T2"), ui("T3", "must")];
    expect(suggest(tasks, 0.5)).toEqual({ kind: "cannot_fit", deferrable: 0 });
  });

  it("only saves a feature when nothing still built depends on it", () => {
    // T2 (could) is used by T3 (could): T3 has to go first even though T2 costs more
    const tasks = [server("T1", "must"), ui("T2", "could"), server("T3", "could", ["T2"])];
    const withoutT3 = estimateBuild([tasks[0], tasks[1]], { integration: true });
    expect(pmSuggestion(tasks, estimateBuild(tasks), 0, withoutT3.low)).toMatchObject({ kind: "defer", tasks: ["T3"] });
    // and transitively: a Should used by a Could used by nothing is saved only after the Could
    const chain = [server("T1", "must"), ui("T2", "should"), server("T3", "could", ["T2"])];
    const onlyMust = estimateBuild([chain[0]], { integration: true });
    expect(pmSuggestion(chain, estimateBuild(chain), 0, onlyMust.low)).toMatchObject({ kind: "defer", tasks: ["T2", "T3"] });
    // a Could a Must depends on is never saved (the planner refuses that plan, but the PM stays safe anyway)
    const used = [server("T1", "must", ["T2"]), ui("T2", "could")];
    expect(suggest(used, 0.1)).toEqual({ kind: "cannot_fit", deferrable: 0 });
  });

  it("says so when even every Should and Could isn't enough", () => {
    const tasks = [ui("T1", "must"), ui("T2", "must"), server("T3", "could"), server("T4", "should")];
    expect(suggest(tasks, 0.2)).toEqual({ kind: "cannot_fit", deferrable: 2 });
  });
});

describe("priorities and saved features (convex/pm.ts)", () => {
  const plan = { tasks: [server("T1", "must"), server("T2", "should"), server("T3", "could", ["T2"]), server("T4")] };

  it("reads a missing or unknown priority as must", () => {
    expect(priorityOf({})).toBe("must");
    expect(priorityOf({ priority: "urgent" })).toBe("must");
    expect(priorityOf({ priority: "could" })).toBe("could");
  });

  it("finds dependents transitively", () => {
    const tasks = [server("A"), server("B", undefined, ["A"]), server("C", undefined, ["B"]), server("D")];
    expect([...dependentsOf(tasks, "A")].sort()).toEqual(["B", "C"]);
    expect(dependentsOf(tasks, "D").size).toBe(0);
  });

  it("accepts Should and Could ids of the plan (deduplicated)", () => {
    expect(checkDeferred(plan, ["T3", "T2", "T3"])).toEqual({ ok: true, ids: ["T3", "T2"] });
    expect(checkDeferred(plan, [])).toEqual({ ok: true, ids: [] });
  });

  it("refuses unknown ids, Musts (also without a priority) and a feature something built still needs", () => {
    expect(checkDeferred(plan, ["T9"])).toMatchObject({ ok: false, message: expect.stringContaining("aren't in the plan: T9") });
    expect(checkDeferred(plan, ["T1"])).toMatchObject({ ok: false, message: expect.stringContaining("never saved for later: T1") });
    expect(checkDeferred(plan, ["T4"])).toMatchObject({ ok: false, message: expect.stringContaining("T4") });
    expect(checkDeferred(plan, ["T2"])).toMatchObject({ ok: false, message: "T2 can't be saved for later: T3 still needs it." });
    expect(checkDeferred(null, ["T2"])).toMatchObject({ ok: false });
  });

  it("approval: first plan stores the checked list, a change can't save features, sending back leaves it", () => {
    expect(decisionDeferred(true, false, plan, ["T3"])).toEqual({ ok: true, ids: ["T3"] });
    expect(decisionDeferred(true, false, plan, undefined)).toEqual({ ok: true, ids: [] }); // build everything: clears
    expect(decisionDeferred(true, false, plan, ["T1"])).toMatchObject({ ok: false });
    expect(decisionDeferred(true, true, plan, ["T3"])).toMatchObject({ ok: false, message: expect.stringContaining("not a change") });
    expect(decisionDeferred(true, true, plan, undefined)).toEqual({ ok: true });
    expect(decisionDeferred(false, false, plan, ["T1"])).toEqual({ ok: true });
  });

  it("buildSaved: only with saved features, a plan, a finished team (done too) and room in the limit", () => {
    const row = { status: "done", plan, costUsd: 1, budgetUsd: 5, deferred: ["T3"] };
    expect(buildSavedBlocker(row)).toBeNull();
    expect(buildSavedBlocker({ ...row, status: "failed" })).toBeNull();
    expect(buildSavedBlocker({ ...row, status: "stopped" })).toBeNull();
    expect(buildSavedBlocker(null)).toContain("doesn't exist");
    expect(buildSavedBlocker({ ...row, deferred: [] })).toContain("no saved features");
    expect(buildSavedBlocker({ ...row, deferred: undefined })).toContain("no saved features");
    for (const status of ["building", "queued", "starting", "shipping", "awaiting_approval"]) {
      expect(buildSavedBlocker({ ...row, status })).toContain("still working");
    }
    expect(buildSavedBlocker({ ...row, plan: undefined })).toContain("still working");
    expect(buildSavedBlocker({ ...row, costUsd: 4.99 })).toContain("spent its limit");
    expect(BUILD_SAVED_PATCH).toMatchObject({ status: "queued", resume: true, deferred: undefined, mode: undefined });
  });
});

describe("composeSpec: priorities", () => {
  const w: Wizard = {
    step: "team", locked: { design: true },
    requirements: { assumptions: [], features: [{ id: "F1", name: "Booking", summary: "Book a slot", stories: [
      { id: "S1", text: "A customer can book", criteria: ["a", "b"], priority: "must" },
      { id: "S2", text: "A customer can reschedule", criteria: ["c", "d"], priority: "should" },
      { id: "S3", text: "A customer can add a note", criteria: ["e", "f"], priority: "could" },
      { id: "S4", text: "A customer can pay a deposit", criteria: ["g", "h"], priority: "out" }] }] },
    design: { tables: [], pages: [], flows: [], actions: [], looks: [] },
  };
  const s = composeSpec("Groomer", "A grooming app", w);

  it("sends Must, Should and Could stories with their tests, never Out", () => {
    expect(s).toContain("- [MUST] S1: A customer can book");
    expect(s).toContain("- [SHOULD] S2: A customer can reschedule");
    expect(s).toContain("- [COULD] S3: A customer can add a note");
    expect(s).toContain("  - Test: e");
    expect(s).not.toContain("pay a deposit");
    expect(s).toContain("## Requirements (build Must, Should and Could; skip Out)");
  });

  it("asks the planner for each task's stories and priority", () => {
    expect(s).toContain("Plan tasks for every Must, Should and Could story. Give each task the story ids it serves and its " +
                        "priority (the highest priority among those stories).");
  });
});

const plan = { project: "x", contracts: [], tasks: [
  server("T1", "must"), server("T2", "should"), ui("T3", "could"), ui("T4", "must", ["T1"])] };

/** Approved with T2 and T3 saved for later; T1 and T4 built and merged; the PM's ship gate and retro. */
function built(): ProjectState {
  let s = reduce(initialState(), ev(0, "plan_ready", null, { plan }));
  s = reduce(s, ev(1, "plan_decision", null, { approved: true }));
  s = reduce(s, ev(2, "pm_deferred", null, { tasks: ["T2", "T3"], titles: ["Feature T2", "Feature T3"] }));
  for (const id of ["T1", "T4"]) {
    s = reduce(s, ev(3, "task_queued", id, { title: `Feature ${id}`, role: "dev", depends_on: [] }));
    s = reduce(s, ev(4, "task_status", id, { status: "working", attempt: 1 }));
    s = reduce(s, ev(5, "task_status", id, { status: "merged" }));
  }
  s = reduce(s, ev(6, "task_queued", "INT", { title: "Put it together", role: "dev", depends_on: ["T1", "T2", "T3", "T4"] }));
  s = reduce(s, ev(7, "task_status", "INT", { status: "merged" }));
  return reduce(s, ev(8, "project_finished", null, { status: "done" }));
}

describe("reducer: the PM", () => {
  it("pm_deferred: a PM line in the feed, the features saved, and Saved for later on the board (not Needs you)", () => {
    let s = reduce(initialState(), ev(0, "plan_ready", null, { plan }));
    s = reduce(s, ev(1, "plan_decision", null, { approved: true }));
    s = reduce(s, ev(2, "pm_deferred", null, { tasks: ["T2", "T3"], titles: ["Feature T2", "Feature T3"] }));
    expect(s.deferred).toEqual(["T2", "T3"]);
    expect(s.feed.at(-1)).toMatchObject({ who: "PM", channel: "build" });
    expect(s.feed.at(-1)!.text).toBe("Saving 2 features for the next version, as you chose: Feature T2 and Feature T3. " +
                                     "Every Must feature is built now; build the saved ones later from the board.");
    const cards = features(s);
    expect(cards.find((f) => f.id === "T2")).toMatchObject({ column: "saved", priority: "should" });
    expect(cards.find((f) => f.id === "T3")).toMatchObject({ column: "saved", priority: "could" });
    expect(cards.find((f) => f.id === "T1")).toMatchObject({ column: "queued", priority: "must" });
    expect(cards.some((f) => f.column === "attention")).toBe(false);
  });

  it("an empty pm_deferred says nothing; titles fall back to the plan's", () => {
    let s = reduce(initialState(), ev(0, "plan_ready", null, { plan }));
    const n = s.feed.length;
    s = reduce(s, ev(1, "pm_deferred", null, { tasks: [] }));
    expect(s.feed.length).toBe(n);
    s = reduce(s, ev(2, "pm_deferred", null, { tasks: ["T3"] }));
    expect(s.feed.at(-1)!.text).toContain("Saving 1 feature for the next version, as you chose: Feature T3.");
  });

  it("the finished line counts the saved features, and the integrator doesn't wait for them", () => {
    const s = built();
    expect(s.status).toBe("done");
    expect(s.feed.at(-1)!.text).toBe("Finished: 3 of 3 features verified and merged, 2 saved for the next version, $0.00 in total.");
    expect(features(s).find((f) => f.id === "INT")!.waitingOn).toEqual([]);
  });

  it("ready_to_ship: the PM says every Must passes and what's saved; the Ship page lists them", () => {
    const s = reduce(built(), ev(9, "ready_to_ship", null, { saved: ["T2", "T3"], musts: 2 }));
    expect(s.ready_to_ship).toEqual({ saved: ["T2", "T3"], musts: 2, t: 9 });
    expect(s.feed.at(-1)).toMatchObject({ who: "PM", tone: "good" });
    expect(s.feed.at(-1)!.text).toBe("Ready to ship: every Must feature passes (2 of 2). Saved for the next version: " +
                                     "Feature T2 and Feature T3. Ship it from the Ship page when you're ready.");
    expect(savedForLater(s)).toEqual([{ id: "T2", title: "Feature T2", deferred: true },
                                      { id: "T3", title: "Feature T3", deferred: true }]);
  });

  it("Saved for the next version also lists Shoulds and Coulds that didn't merge once a run finished", () => {
    let s = reduce(initialState(), ev(0, "plan_ready", null, { plan }));
    expect(savedForLater(s)).toEqual([]); // nothing has run yet
    s = reduce(s, ev(1, "plan_decision", null, { approved: true }));
    s = reduce(s, ev(2, "task_queued", "T3", { title: "Feature T3", role: "dev", depends_on: [] }));
    s = reduce(s, ev(3, "task_status", "T3", { status: "failed" }));
    s = reduce(s, ev(4, "project_finished", null, { status: "failed" }));
    expect(savedForLater(s)).toEqual([{ id: "T2", title: "Feature T2", deferred: false },
                                      { id: "T3", title: "Feature T3", deferred: false }]);
  });

  it("retro_written: a PM line with the summary, kept for History", () => {
    const s = reduce(built(), ev(10, "retro_written", null, { summary: "Feature T4 needed 2 tries: the date format." }));
    expect(s.retros).toEqual([{ summary: "Feature T4 needed 2 tries: the date format.", t: 10 }]);
    expect(s.feed.at(-1)).toMatchObject({ who: "PM", text: "Retro notes for the next run: Feature T4 needed 2 tries: the date format." });
    const long = reduce(built(), ev(10, "retro_written", null, { summary: "x".repeat(900) }));
    expect(long.retros![0].summary.length).toBe(600);
    expect(reduce(built(), ev(10, "retro_written", null, {})).retros).toEqual([]);
  });

  it("Build saved features: the resumed run moves them back onto the board and clears the ship gate", () => {
    let s = reduce(built(), ev(9, "ready_to_ship", null, { saved: ["T2", "T3"], musts: 2 }));
    s = reduce(s, ev(20, "build_resumed", null, { merged: ["T1", "T4"], retrying: ["T2-qa", "T2", "T3-qa", "T3", "INT"] }));
    expect(s.deferred).toEqual([]);
    expect(s.ready_to_ship).toBeNull();
    expect(features(s).find((f) => f.id === "T2")!.column).toBe("queued");
  });

  it("a saved feature that starts working leaves Saved for later", () => {
    let s = reduce(initialState(), ev(0, "plan_ready", null, { plan }));
    s = reduce(s, ev(1, "pm_deferred", null, { tasks: ["T2", "T3"] }));
    s = reduce(s, ev(2, "task_queued", "T2-qa", { title: "Acceptance tests for Feature T2", role: "qa", depends_on: [] }));
    s = reduce(s, ev(3, "task_status", "T2-qa", { status: "working", attempt: 1 }));
    expect(s.deferred).toEqual(["T3"]);
    expect(features(s).find((f) => f.id === "T2")!.column).toBe("tests");
  });

  it("lists names in plain English", () => {
    expect(listText([])).toBe("");
    expect(listText(["A"])).toBe("A");
    expect(listText(["A", "B", "C"])).toBe("A, B and C");
  });
});

describe("notification: ready to ship", () => {
  it("says every Must feature passes and links to the Ship page", () => {
    const n = notificationFor("ready_to_ship", { saved: ["T2", "T3"], musts: 2 }, "Groomer")!;
    expect(n).toMatchObject({ kind: "ready_to_ship", title: "Groomer: ready to ship", email: true });
    expect(n.body).toBe("Ready to ship: every Must feature passes. 2 features are saved for the next version. " +
                        "Ship it to production when you're ready.");
    expect(notificationFor("ready_to_ship", { saved: [], musts: 3 }, "Groomer")!.body)
      .toBe("Ready to ship: every Must feature passes. Ship it to production when you're ready.");
    expect(notificationPath("p1", "ready_to_ship")).toBe("/p/p1/ship");
    expect(notificationPath("p1", "finished")).toBe("/p/p1/board");
  });

  it("pm_deferred and retro_written don't notify", () => {
    expect(notificationFor("pm_deferred", { tasks: ["T2"] }, "Groomer")).toBeNull();
    expect(notificationFor("retro_written", { summary: "x" }, "Groomer")).toBeNull();
  });
});
