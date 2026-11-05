import { anyApi, mutationGeneric } from "convex/server";
import { ConvexError, v } from "convex/values";
import { checkOwner } from "./owner";

/*
 * Checkpoints and rollback (docs/checkpoints.md). Every finished build or change is a save point (a
 * `checkpoint-<n>` tag in the project's repo); the owner can roll the project back to one. The pure helpers
 * below are shared by Convex (engine.ts, this file) and the app, and are tested without a backend.
 */

/** One save point as stored on the project row. `at` is milliseconds since epoch; `merged` the task ids
 *  merged at that point (what a later retry keeps after rolling back to it). */
export type Checkpoint = { n: number; tag: string; sha: string; label: string; at: number; merged?: string[] };

/** An event as Convex stores it (engine.ts record). */
type StoredEvent = { kind: string; taskId: string | null; data: Record<string, unknown> | null | undefined };

/** Rolling back is allowed when the project has finished (done) or stopped (failed) and nothing is running. */
export function canRollback(status: string, running: boolean): boolean {
  return !running && (status === "done" || status === "failed");
}

/** A checkpoint_created event's data as a stored checkpoint, or null if it isn't one. */
export function toCheckpoint(data: unknown, ts: number): Checkpoint | null {
  const d = (data ?? {}) as Record<string, unknown>;
  const n = Number(d.n);
  if (!Number.isInteger(n) || n < 1 || typeof d.sha !== "string") return null;
  return { n, tag: typeof d.tag === "string" ? d.tag : `checkpoint-${n}`, sha: d.sha, label: String(d.label ?? ""),
           at: Math.round(ts * 1000), ...(Array.isArray(d.merged) ? { merged: d.merged.map(String) } : {}) };
}

/** The list with this checkpoint added (a replayed event replaces its own entry), oldest first. */
export function addCheckpoint(list: Checkpoint[] | undefined, c: Checkpoint): Checkpoint[] {
  return [...(list ?? []).filter((x) => x.n !== c.n), c].sort((a, b) => a.n - b.n);
}

/**
 * Task ids whose latest status is merged, as retries and changes use them, with the rollback rule: a
 * rollback_done {to} replaces everything before it with the merged list saved on checkpoint `to`, so tasks
 * that were rolled away are never claimed as merged. Task events after the rollback apply as usual.
 */
export function mergedTasks(events: StoredEvent[]): string[] {
  let last: Record<string, string> = {};
  const saved: Record<number, string[] | undefined> = {};
  for (const e of events) {
    if (e.kind === "task_status" && e.taskId) last[e.taskId] = String(e.data?.status ?? "");
    if (e.kind === "checkpoint_created" && Array.isArray(e.data?.merged)) saved[Number(e.data.n)] = e.data.merged.map(String);
    if (e.kind === "rollback_done") {
      const kept = saved[Number(e.data?.to)];
      // a checkpoint saved without its list (never, from this worker) keeps the bookkeeping as it was
      if (kept) last = Object.fromEntries(kept.map((id) => [id, "merged"]));
      // the new checkpoint made by the rollback holds the same work as its target
      if (kept && e.data?.n != null) saved[Number(e.data.n)] = kept;
    }
  }
  return Object.keys(last).filter((k) => last[k] === "merged").sort();
}

/** What engine.record changes on the project row for the checkpoint events; merged into its patch last. */
export function checkpointPatch(p: { mode?: string; status: string; checkpoints?: Checkpoint[]; rollback?: { from?: string } },
                                kind: string, data: Record<string, unknown> | null | undefined, ts: number): Record<string, unknown> {
  if (kind === "checkpoint_created") {
    const c = toCheckpoint(data, ts);
    return c ? { checkpoints: addCheckpoint(p.checkpoints, c) } : {};
  }
  if (kind === "rollback_started") return { status: "building" };
  // a rollback that failed changed nothing on main: the project is as it was (done or failed), like a sent-back change
  if (kind === "project_finished" && p.mode === "rollback" && data?.status === "failed" && p.rollback?.from) {
    return { status: p.rollback.from };
  }
  return {};
}

/** Link to a checkpoint's commit on GitHub, or null when the repo isn't a GitHub URL. */
export function commitUrl(repo: string | null | undefined, sha: string): string | null {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(repo ?? "");
  return m && /^[0-9a-f]{7,40}$/.test(sha) ? `https://github.com/${m[1]}/${m[2]}/commit/${sha}` : null;
}

/** Roll the project back to checkpoint n: one new commit on main with that checkpoint's files, then a redeploy. */
export const rollbackTo = mutationGeneric({
  args: { key: v.string(), id: v.id("projects"), n: v.number() },
  handler: async (ctx, { key, id, n }) => {
    checkOwner(key);
    const p = await ctx.db.get(id);
    if (!p) throw new ConvexError("This project doesn't exist any more.");
    if (!canRollback(p.status, false)) {
      throw new ConvexError("The team is still working on this project. Roll back once it has finished.");
    }
    if (!p.repo) throw new ConvexError("This project has no repo yet, so there's nothing to roll back.");
    if (!((p.checkpoints ?? []) as Checkpoint[]).some((c) => c.n === n)) throw new ConvexError(`There is no checkpoint ${n}.`);
    await ctx.db.patch(id, { status: "queued", mode: "rollback", resume: false, error: undefined, planNote: undefined,
                             rollback: { n, from: p.status } });
    await ctx.scheduler.runAfter(0, anyApi.projects.startWorker, { projectId: id });
  },
});
