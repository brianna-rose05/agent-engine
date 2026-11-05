/*
 * A project's spending limit: the rules Convex (projects.create / setBudget / retryFailed) and the app share.
 * The engine enforces it (engine/budget.py): once a project's spend reaches it, no new task or try starts.
 * Pure functions only, so the app and the tests can import them without a Convex backend.
 */

export const BUDGET_DEFAULT = 5; // $ per project; worker.py DEFAULT_PROJECT_BUDGET matches
export const BUDGET_MIN = 1;
export const BUDGET_MAX = 50;

/** The limit to store (rounded to cents), or the message to show the owner when it can't be used. */
export function checkBudget(usd: number): { ok: true; usd: number } | { ok: false; message: string } {
  if (!Number.isFinite(usd)) return { ok: false, message: "Enter a spending limit in dollars." };
  if (usd < BUDGET_MIN || usd > BUDGET_MAX) {
    return { ok: false, message: `Pick a spending limit between $${BUDGET_MIN} and $${BUDGET_MAX}.` };
  }
  return { ok: true, usd: Math.round(usd * 100) / 100 };
}

/** The project's limit, or the default for projects made before limits existed. */
export const budgetOf = (p: { budgetUsd?: number }) => p.budgetUsd ?? BUDGET_DEFAULT;

/** Whether a new run (retry, change) has anything to spend: less than this and it would stop at once. */
export const BUDGET_HEADROOM = 0.05;
export const canSpendMore = (spentUsd: number, budgetUsd: number) => budgetUsd - spentUsd >= BUDGET_HEADROOM;
