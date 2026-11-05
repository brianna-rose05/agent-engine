/*
 * What a build (or a change) will probably cost, shown before you approve it next to the project's spending limit.
 * Pure, so it is unit-tested (tests/estimate.test.ts).
 *
 * Rates per agent run, from the live Haiku builds of the Pawfect web app (Next.js + Supabase stack):
 *   planner ~$0.30-0.50 a plan; QA ~$0.02 per feature; dev $0.03-0.10 per try, ~1.5 tries on average;
 *   referee ~$0.05 a review when a dev keeps failing tests; integrator ~$1-2 (it wires every page).
 * UI features (src/components/) take more tries: the owner screens failed their tests in Pawfect builds 3-7 and
 * were retried to the limit, so they are counted at 2 tries instead of 1.5. The recorded Python run in
 * src/demo/garden.json is far cheaper (under $0.02 a task), so these rates overestimate non-web projects.
 */

export const RATES = {
  planner: { low: 0.3, high: 0.5 },
  qa: 0.02,
  devPerTry: { low: 0.03, high: 0.1 },
  tries: { server: 1.5, ui: 2 },
  referee: 0.05,
  integrator: { low: 1, high: 2 },
};

export type EstimateLine = { label: string; low: number; high: number };
export type Estimate = { low: number; high: number; lines: EstimateLine[] };

/** Screens (src/components/) take more tries than server modules; matches NextSupabaseStack.is_ui_module. */
export const isUiModule = (module: string) => module.startsWith("src/components/");

/** A web app (modules under src/) ends with the integrator wiring the pages; Python projects don't. */
export const needsIntegration = (tasks: { module: string }[]) => tasks.some((t) => t.module.startsWith("src/"));

const cents = (x: number) => Math.round(x * 100) / 100;

/**
 * Estimated cost of building `tasks` (the plan's features, or a change's tasks).
 * planner: include the planner (false at approval time: it has already run, and what it cost is known).
 * integration: include the integrator (default: when the modules are a web app's).
 */
export function estimateBuild(tasks: { module: string }[],
                              { planner = false, integration }: { planner?: boolean; integration?: boolean } = {}): Estimate {
  const lines: EstimateLine[] = [];
  const ui = tasks.filter((t) => isUiModule(t.module)).length;
  const server = tasks.length - ui;
  const feature = (tries: number) => ({
    low: RATES.qa + RATES.devPerTry.low * tries,
    high: RATES.qa + RATES.devPerTry.high * tries + RATES.referee,   // the high end allows one review each
  });
  if (planner) lines.push({ label: "Planner", ...RATES.planner });
  if (server) {
    const f = feature(RATES.tries.server);
    lines.push({ label: `${server} server feature${server === 1 ? "" : "s"}`, low: f.low * server, high: f.high * server });
  }
  if (ui) {
    const f = feature(RATES.tries.ui);
    lines.push({ label: `${ui} screen${ui === 1 ? "" : "s"}`, low: f.low * ui, high: f.high * ui });
  }
  if (integration ?? needsIntegration(tasks)) lines.push({ label: "Putting the app together", ...RATES.integrator });
  const rounded = lines.map((l) => ({ ...l, low: cents(l.low), high: cents(l.high) }));
  return {
    low: cents(lines.reduce((s, l) => s + l.low, 0)),
    high: cents(lines.reduce((s, l) => s + l.high, 0)),
    lines: rounded,
  };
}

/** "$1.10–$2.80" */
export const rangeText = (e: { low: number; high: number }) => `$${e.low.toFixed(2)}–$${e.high.toFixed(2)}`;

/**
 * How the estimate sits against the limit, counting what the project has already spent:
 * "ok" (even the high end fits), "tight" (the high end doesn't), "over" (not even the low end fits).
 */
export function budgetFit(e: { low: number; high: number }, spentUsd: number, budgetUsd: number): "ok" | "tight" | "over" {
  const left = budgetUsd - spentUsd;
  if (e.low > left) return "over";
  if (e.high > left) return "tight";
  return "ok";
}
