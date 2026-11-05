/*
 * The PM in the app (first slice): the budget guard at approval and what is saved for the next version. No model
 * call: the suggestion is worked out from the plan's priorities and the cost estimate (lib/estimate.ts). The rules
 * the server checks too (priorities, the dependency rule) are in convex/pm.ts. Pure, so it is unit-tested
 * (tests/pm.test.ts).
 */

import { budgetFit, estimateBuild, needsIntegration, type Estimate } from "./estimate";
import type { PlanTask, ProjectState } from "./types";
import { dependentsOf, priorityOf, type TaskPriority } from "../../convex/pm";

export type PmSuggestion =
  | { kind: "fits" }                                   // the estimate already fits what's left of the limit
  | { kind: "defer"; tasks: string[]; titles: string[]; saves: number; estimate: Estimate } // save these to fit
  | { kind: "cannot_fit"; deferrable: number };        // even saving every Should and Could feature isn't enough

const mid = (e: { low: number; high: number }) => (e.low + e.high) / 2;
const cents = (x: number) => Math.round(x * 100) / 100;

/** What one feature costs on its own (QA + dev tries), without the integrator. */
const taskCost = (t: PlanTask) => mid(estimateBuild([t], { integration: false }));

/**
 * The PM's suggestion when the estimate is over the limit (budgetFit "over"): save Could features for the next
 * version first, the most expensive first, then Shoulds, until the estimate fits. Musts are never saved for later.
 * A feature is only saved when nothing that will still be built depends on it (directly or through others).
 * The integrator still runs (it puts together whatever is built), so it stays in the estimate.
 */
export function pmSuggestion(tasks: PlanTask[], estimate: Estimate, spent: number, budget: number): PmSuggestion {
  if (budgetFit(estimate, spent, budget) !== "over") return { kind: "fits" };
  const integration = needsIntegration(tasks);
  const saved = new Set<string>();
  const rest = () => estimateBuild(tasks.filter((t) => !saved.has(t.id)), { integration });
  const tiers: TaskPriority[] = ["could", "should"];
  for (const tier of tiers) {
    for (;;) {
      const candidates = tasks.filter((t) => priorityOf(t) === tier && !saved.has(t.id) &&
                                             [...dependentsOf(tasks, t.id)].every((d) => saved.has(d)));
      if (!candidates.length) break;
      // most expensive first; equal costs keep the plan's order
      const pick = candidates.reduce((a, b) => (taskCost(b) > taskCost(a) ? b : a));
      saved.add(pick.id);
      const e = rest();
      if (budgetFit(e, spent, budget) !== "over") {
        const picked = tasks.filter((t) => saved.has(t.id));
        return { kind: "defer", tasks: picked.map((t) => t.id), titles: picked.map((t) => t.title),
                 saves: cents(mid(estimate) - mid(e)), estimate: e };
      }
    }
  }
  return { kind: "cannot_fit", deferrable: saved.size };
}

/** "A", "A and B", "A, B and C" */
export const listText = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/** The run has ended (nothing is being built): what isn't merged by now is waiting for a later version. */
const FINISHED = new Set(["done", "failed", "stopped", "shipping"]);

/**
 * Features saved for the next version, in plan order: the ones the PM saved at approval (deferred) and, once a run
 * has finished, every Should or Could feature that didn't merge (the ship gate's `saved`). Shoulds and Coulds never
 * block shipping.
 */
export function savedForLater(s: ProjectState): { id: string; title: string; deferred: boolean }[] {
  const deferred = new Set(s.deferred ?? []);
  const gate = new Set(s.ready_to_ship?.saved ?? []);
  const finished = FINISHED.has(s.status);
  return (s.plan?.tasks ?? [])
    .filter((t) => s.tasks[t.id]?.status !== "merged" &&
                   (deferred.has(t.id) || gate.has(t.id) || (finished && priorityOf(t) !== "must")))
    .map((t) => ({ id: t.id, title: t.title, deferred: deferred.has(t.id) }));
}

/** "Must", "Should", "Could": how a priority is named on screen. */
export const priorityName = (p: TaskPriority) => p[0].toUpperCase() + p.slice(1);
