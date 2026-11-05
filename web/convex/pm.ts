/*
 * The PM's rules (first slice): plan priorities, features saved for later (`deferred` on the project row) and
 * "Build saved features". Pure functions only, so Convex (projects.decide / buildSaved), the app and the tests share
 * them. The suggestion of what to save (no model call) is src/lib/pm.ts; the engine skips deferred tasks.
 */

import { budgetOf, canSpendMore } from "./budget";

export type TaskPriority = "must" | "should" | "could";
export const PRIORITIES: TaskPriority[] = ["must", "should", "could"];

type PlanTaskLike = { id: string; depends_on?: string[]; priority?: unknown };

/** A task's priority; missing (old plans, the benchmark) or unknown counts as "must", like the engine's plan check. */
export function priorityOf(t: object): TaskPriority {
  const p = (t as { priority?: unknown }).priority;
  return p === "should" || p === "could" ? p : "must";
}

/** Every task that depends on `id`, directly or through other tasks. */
export function dependentsOf(tasks: PlanTaskLike[], id: string): Set<string> {
  const out = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const t of tasks) {
      if ((t.depends_on ?? []).includes(cur) && !out.has(t.id)) {
        out.add(t.id);
        stack.push(t.id);
      }
    }
  }
  return out;
}

/**
 * The deferred task ids to store when the owner approves with "Save these for later", or the message to show.
 * Each id must be a task of the plan, none may be a Must, and no task that will be built may depend on one.
 */
export function checkDeferred(plan: { tasks?: PlanTaskLike[] } | null | undefined, deferred: string[]):
    { ok: true; ids: string[] } | { ok: false; message: string } {
  const tasks = plan?.tasks ?? [];
  const ids = [...new Set(deferred)];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const unknown = ids.filter((id) => !byId.has(id));
  if (unknown.length) return { ok: false, message: `Those features aren't in the plan: ${unknown.join(", ")}.` };
  const musts = ids.filter((id) => priorityOf(byId.get(id)!) === "must");
  if (musts.length) return { ok: false, message: `Must features are never saved for later: ${musts.join(", ")}.` };
  const saved = new Set(ids);
  for (const id of ids) {
    const needed = [...dependentsOf(tasks, id)].filter((d) => !saved.has(d));
    if (needed.length) return { ok: false, message: `${id} can't be saved for later: ${needed.join(", ")} still needs it.` };
  }
  return { ok: true, ids };
}

/**
 * What a plan decision does with `deferred` (projects.decide): approving the first plan stores the checked list
 * (`ids`, empty = build everything and clear an earlier list); approving a change can't save features; sending back
 * leaves the row's list alone (`ids` undefined).
 */
export function decisionDeferred(approved: boolean, change: boolean, plan: { tasks?: PlanTaskLike[] } | null | undefined,
                                 deferred: string[] | undefined): { ok: true; ids?: string[] } | { ok: false; message: string } {
  if (!approved) return { ok: true };
  if (change) {
    return deferred?.length
      ? { ok: false, message: "Features can only be saved for later when you approve the plan, not a change." }
      : { ok: true };
  }
  return checkDeferred(plan, deferred ?? []);
}

type Row ={ status: string; plan?: unknown; costUsd: number; budgetUsd?: number; deferred?: string[] } | null;

/** Why "Build saved features" can't start now, or null when it can. Like retryBlocker, but also from "done". */
export function buildSavedBlocker(p: Row): string | null {
  if (!p) return "This project doesn't exist any more.";
  if (!p.deferred?.length) return "There are no saved features to build.";
  if (!["done", "failed", "stopped"].includes(p.status) || !p.plan) {
    return "The team is still working on this project. Build the saved features once it has finished.";
  }
  if (!canSpendMore(p.costUsd, budgetOf(p))) {
    return "This project has spent its limit. Raise the spending limit on the plan page, then build the saved features.";
  }
  return null;
}

/** What "Build saved features" sets on the row: nothing deferred any more, and a resume run (like a retry). */
export const BUILD_SAVED_PATCH = { status: "queued", resume: true, mode: undefined, error: undefined, deferred: undefined };
