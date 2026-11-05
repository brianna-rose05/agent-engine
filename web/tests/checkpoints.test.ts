import { describe, expect, it } from "vitest";
import { boardChangeTasks, features, initialState, reduce } from "../src/lib/reduce";
import { newestFirst } from "../src/lib/history";
import type { EngineEvent, ProjectState } from "../src/lib/types";
import { addCheckpoint, canRollback, checkpointPatch, commitUrl, mergedTasks, toCheckpoint } from "../convex/checkpoints";

const ev = (t: number, kind: EngineEvent["kind"], task_id: string | null, data: Record<string, unknown>): EngineEvent =>
  ({ t, kind, task_id, data });

const plan = { project: "x", contracts: [], tasks: [{ id: "T1", title: "Slots", module: "src/server/slots.ts", spec: "", depends_on: [] }] };
const change1 = { n: 1, change: { summary: "Time zones", tasks: [
  { id: "C1T1", kind: "change", title: "Store times in the salon's zone", module: "src/server/slots.ts", spec: "", depends_on: [] }] } };

/** Built (checkpoint 1), then change 1 merged and finished (checkpoint 2). */
function builtAndChanged(): ProjectState {
  const events = [
    ev(0, "plan_ready", null, { plan }),
    ev(1, "task_queued", "T1", { title: "Slots", role: "dev", depends_on: [] }),
    ev(2, "task_status", "T1", { status: "merged" }),
    ev(3, "checkpoint_created", null, { n: 1, tag: "checkpoint-1", sha: "aaaaaaa1111", label: "Build finished", merged: ["T1"] }),
    ev(4, "project_finished", null, { status: "done", repo: "https://github.com/me/studio-x" }),
    ev(5, "change_started", null, { n: 1, text: "Store times in the salon's time zone" }),
    ev(6, "change_plan_ready", null, change1),
    ev(7, "plan_decision", null, { approved: true }),
    ev(8, "task_queued", "C1T1-qa", { title: "Acceptance tests for x", role: "qa", depends_on: [] }),
    ev(9, "task_queued", "C1T1", { title: "x", role: "dev", depends_on: ["C1T1-qa"] }),
    ev(10, "task_status", "C1T1-qa", { status: "passed" }),
    ev(11, "task_status", "C1T1", { status: "merged" }),
    ev(12, "checkpoint_created", null, { n: 2, tag: "checkpoint-2", sha: "bbbbbbb2222", label: "Change 1: Store times", merged: ["C1T1", "T1"] }),
    ev(13, "project_finished", null, { status: "done", repo: "https://github.com/me/studio-x" }),
  ];
  return events.reduce(reduce, initialState());
}

describe("checkpoints in the app", () => {
  it("lists save points, marks the latest current and says so in the build channel", () => {
    const s = builtAndChanged();
    expect(newestFirst(s.history).map((c) => [c.n, c.label])).toEqual([[2, "Change 1: Store times"], [1, "Build finished"]]);
    expect(s.history!.current).toBe(2);
    expect(s.history!.repo).toBe("https://github.com/me/studio-x");
    const saved = s.feed.filter((f) => f.text.startsWith("Saved checkpoint"));
    expect(saved.map((f) => f.channel)).toEqual(["build", "build"]);
    // the other events still reduce as before
    expect(s.status).toBe("done");
    expect(s.feed.some((f) => f.text.startsWith("Finished:"))).toBe(true);
  });

  it("a stopped run means main is past the latest checkpoint", () => {
    let s = builtAndChanged();
    s = reduce(s, ev(20, "change_started", null, { n: 2, text: "Add reviews to the page" }));
    s = reduce(s, ev(21, "project_finished", null, { status: "failed" }));
    expect(s.history!.current).toBeNull();
  });

  it("rolling back takes the rolled-away change off the board, and rolling forward brings it back", () => {
    let s = builtAndChanged();
    expect(boardChangeTasks(s).map((t) => t.id)).toEqual(["C1T1"]);
    s = reduce(s, ev(20, "rollback_started", null, { n: 1 }));
    expect(s.status).toBe("building");
    expect(s.feed.at(-1)!.text).toBe("Roll back to checkpoint 1 (Build finished).");
    s = reduce(s, ev(21, "rollback_done", null, { to: 1, n: 3, sha: "ccccccc3333" }));
    s = reduce(s, ev(22, "checkpoint_created", null, { n: 3, tag: "checkpoint-3", sha: "ccccccc3333",
                                                          label: "Roll back to checkpoint 1: Build finished", merged: ["T1"] }));
    s = reduce(s, ev(23, "project_finished", null, { status: "done", repo: "https://github.com/me/studio-x" }));
    expect(s.status).toBe("done");
    expect(s.tasks.C1T1.status).toBe("rolled_back");
    expect(s.tasks["C1T1-qa"].status).toBe("rolled_back");
    expect(s.tasks.T1.status).toBe("merged");
    expect(s.changes[0].rolled_back).toBe(true);
    expect(features(s).map((f) => f.id)).toEqual(["T1"]);
    expect(s.history!.current).toBe(3);
    expect(s.feed.some((f) => f.text.startsWith("Rolled back to checkpoint 1") && f.text.includes("ccccccc"))).toBe(true);
    expect(s.feed.filter((f) => f.text.startsWith("Finished:"))).toHaveLength(2); // no tally for the rollback itself

    s = reduce(s, ev(30, "rollback_started", null, { n: 2 }));
    s = reduce(s, ev(31, "rollback_done", null, { to: 2, n: 4, sha: "ddddddd4444" }));
    expect(s.tasks.C1T1.status).toBe("merged");
    expect(s.tasks["C1T1-qa"].status).toBe("passed");
    expect(s.changes[0].rolled_back).toBe(false);
    expect(features(s).map((f) => f.id)).toEqual(["T1", "C1T1"]);
  });

  it("a failed rollback leaves the project as it was", () => {
    let s = builtAndChanged();
    s = reduce(s, ev(20, "rollback_started", null, { n: 1 }));
    s = reduce(s, ev(21, "rollback_failed", null, { n: 1, reason: "couldn't push the rollback" }));
    s = reduce(s, ev(22, "project_finished", null, { status: "failed" }));
    expect(s.status).toBe("done");
    expect(s.tasks.C1T1.status).toBe("merged");
    expect(s.history!.current).toBe(2);
    expect(s.feed.at(-1)!.tone).toBe("bad");
    expect(s.feed.at(-1)!.text).toContain("Nothing changed.");
  });
});

describe("checkpoint rules shared with Convex", () => {
  const row = (kind: string, taskId: string | null, data: Record<string, unknown>) => ({ kind, taskId, data });

  it("merged bookkeeping forgets tasks rolled away, then applies later task events", () => {
    const events = [
      row("task_status", "T1", { status: "merged" }),
      row("task_status", "INT", { status: "merged" }),
      row("checkpoint_created", null, { n: 1, sha: "a", merged: ["INT", "T1"] }),
      row("task_status", "C1T1", { status: "merged" }),
      row("checkpoint_created", null, { n: 2, sha: "b", merged: ["C1T1", "INT", "T1"] }),
      row("task_status", "C2T1", { status: "merged" }),
      row("task_status", "C2T2", { status: "failed" }),
    ];
    expect(mergedTasks(events)).toEqual(["C1T1", "C2T1", "INT", "T1"]);
    const back = [...events, row("rollback_done", null, { to: 1, n: 3, sha: "c" })];
    expect(mergedTasks(back)).toEqual(["INT", "T1"]);
    expect(mergedTasks([...back, row("task_status", "C3T1", { status: "merged" })])).toEqual(["C3T1", "INT", "T1"]);
    // rolling back to the rollback's own checkpoint keeps the same list
    expect(mergedTasks([...back, row("rollback_done", null, { to: 3, n: 4, sha: "d" })])).toEqual(["INT", "T1"]);
  });

  it("rollback is allowed only when the project has stopped", () => {
    expect(canRollback("done", false)).toBe(true);
    expect(canRollback("failed", false)).toBe(true);
    expect(canRollback("done", true)).toBe(false);
    for (const s of ["queued", "starting", "planning", "awaiting_approval", "building", "rejected", "draft"]) {
      expect(canRollback(s, false)).toBe(false);
    }
  });

  it("record keeps checkpoints on the row and restores the status after a failed rollback", () => {
    const c = toCheckpoint({ n: 1, tag: "checkpoint-1", sha: "abc1234", label: "Build finished", merged: ["T1"] }, 100.5)!;
    expect(c).toEqual({ n: 1, tag: "checkpoint-1", sha: "abc1234", label: "Build finished", at: 100500, merged: ["T1"] });
    expect(toCheckpoint({ n: "x" }, 1)).toBeNull();
    expect(addCheckpoint([c], { ...c, n: 2 }).map((x) => x.n)).toEqual([1, 2]);
    expect(addCheckpoint([c], c)).toHaveLength(1);
    const p = { status: "building", mode: "rollback", checkpoints: [c], rollback: { n: 1, from: "done" } };
    expect(checkpointPatch(p, "checkpoint_created", { n: 2, sha: "def5678", label: "x" }, 200).checkpoints).toHaveLength(2);
    expect(checkpointPatch(p, "rollback_started", { n: 1 }, 1)).toEqual({ status: "building" });
    expect(checkpointPatch(p, "project_finished", { status: "failed" }, 1)).toEqual({ status: "done" });
    expect(checkpointPatch(p, "project_finished", { status: "done" }, 1)).toEqual({});
    expect(checkpointPatch({ ...p, mode: "change" }, "project_finished", { status: "failed" }, 1)).toEqual({});
  });

  it("links a checkpoint to its commit on GitHub", () => {
    expect(commitUrl("https://github.com/me/studio-x", "abc1234")).toBe("https://github.com/me/studio-x/commit/abc1234");
    expect(commitUrl("https://github.com/me/studio-x.git", "abc1234")).toBe("https://github.com/me/studio-x/commit/abc1234");
    expect(commitUrl(null, "abc1234")).toBeNull();
    expect(commitUrl("https://evil.example/me/x", "abc1234")).toBeNull();
  });
});
