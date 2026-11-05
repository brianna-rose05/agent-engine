import type { ChangeState, CheckpointState, EngineEvent, FeedItem, HistoryState, ProjectState, TaskState } from "./types";
import { cleanLabel } from "../../convex/checkpoints";

/*
 * Checkpoints and rollbacks in the app (docs/checkpoints.md). Kept apart from reduce.ts: `reduce` hands every
 * event through withHistory, which handles the four checkpoint events itself and otherwise lets the rest of
 * the reducer run, only noting the repo and whether main is still at the latest checkpoint.
 */

export const emptyHistory = (): HistoryState => ({ checkpoints: [], current: null, rolling: null, repo: null });

/** Short commit id as GitHub shows it. */
export const shortSha = (sha: string) => sha.slice(0, 7);

/** Checkpoints newest first, for the History view. */
export const newestFirst = (h: HistoryState | undefined) => [...(h?.checkpoints ?? [])].sort((a, b) => b.n - a.n);

const plainId = (taskId: string) => taskId.replace(/-qa$/, "");

/**
 * After rolling back to a checkpoint, only the tasks merged at that point count as merged. Rolled-away work
 * is marked rolled_back (and changes whose work all went leave the board); rolling forward again restores it.
 */
function applyKept(tasks: Record<string, TaskState>, changes: ChangeState[], kept: Set<string>, t: number) {
  const next = { ...tasks };
  for (const task of Object.values(tasks)) {
    if (task.role === "planner") continue;
    const id = plainId(task.id);
    const done = task.role === "qa" ? "passed" : "merged";
    if (kept.has(id) && task.status === "rolled_back") next[task.id] = { ...task, status: done, since: t };
    else if (!kept.has(id) && task.status === done) next[task.id] = { ...task, status: "rolled_back", since: t };
  }
  const everMerged = (id: string) => ["merged", "rolled_back"].includes(next[id]?.status ?? "");
  const nextChanges = changes.map((c) => {
    const touched = c.tasks.some((x) => everMerged(x.id));
    const rolled = touched && !c.tasks.some((x) => kept.has(x.id));
    return rolled === Boolean(c.rolled_back) ? c : { ...c, rolled_back: rolled };
  });
  return { tasks: next, changes: nextChanges };
}

export function withHistory(s: ProjectState, e: EngineEvent, inner: (s: ProjectState, e: EngineEvent) => ProjectState): ProjectState {
  const h = s.history ?? emptyHistory();
  const d = e.data as Record<string, unknown>;
  const now = Math.max(s.now, e.t);
  const say = (item: Omit<FeedItem, "t" | "channel">) => [...s.feed, { t: e.t, channel: "build" as const, ...item }];
  const labelOf = (n: number) => h.checkpoints.find((c) => c.n === n)?.label;

  switch (e.kind) {
    case "checkpoint_created": {
      const n = Number(d.n);
      if (!Number.isInteger(n) || typeof d.sha !== "string") return { ...s, now };
      const c: CheckpointState = { n, tag: String(d.tag ?? `checkpoint-${n}`), sha: d.sha, label: cleanLabel(d.label), t: e.t,
                                   merged: Array.isArray(d.merged) ? d.merged.map(String) : null };
      const checkpoints = [...h.checkpoints.filter((x) => x.n !== n), c].sort((a, b) => a.n - b.n);
      return { ...s, now, history: { ...h, checkpoints, current: n },
               feed: say({ who: "engine", tone: "good", text: `Saved checkpoint ${n}: ${c.label}. You can roll back to it from History.` }) };
    }
    case "rollback_started": {
      const n = Number(d.n);
      const label = labelOf(n);
      return { ...s, now, status: "building", history: { ...h, rolling: { n, before: s.status } },
               feed: say({ who: "you", text: `Roll back to checkpoint ${n}${label ? ` (${label})` : ""}.` }) };
    }
    case "rollback_done": {
      const to = Number(d.to);
      const target = h.checkpoints.find((c) => c.n === to);
      const kept = target?.merged ? applyKept(s.tasks, s.changes, new Set(target.merged), e.t) : { tasks: s.tasks, changes: s.changes };
      const sha = typeof d.sha === "string" ? ` (${shortSha(d.sha)})` : "";
      return { ...s, now, ...kept, change: kept.changes.at(-1) ?? null,
               feed: say({ who: "engine", tone: "good",
                           text: `Rolled back to checkpoint ${to}: main has its files again in one new commit${sha}. ` +
                                 "Nothing was deleted from the history, so you can roll forward the same way." }) };
    }
    case "rollback_failed": {
      return { ...s, now, feed: say({ who: "engine", tone: "bad",
        text: `Couldn't roll back to checkpoint ${Number(d.n)}: ${String(d.reason ?? "the repo refused it")}. Nothing changed.` }) };
    }
    case "project_finished": {
      const repo = typeof d.repo === "string" ? d.repo : h.repo;
      if (h.rolling) {
        // a rollback is not a build: no feature tally; a failed one leaves the project as it was
        return { ...s, now, status: d.status === "done" ? "done" : h.rolling.before, history: { ...h, rolling: null, repo } };
      }
      const next = inner(s, e);
      // a stopped run may have merged some work: main is no longer exactly the latest checkpoint
      const current = d.status === "failed" ? null : h.current;
      return { ...next, history: { ...h, repo, current } };
    }
    default: {
      const next = inner(s, e);
      return s.history ? { ...next, history: s.history } : next;
    }
  }
}
