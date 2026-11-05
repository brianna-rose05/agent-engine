import { anyApi, mutationGeneric } from "convex/server";
import { ConvexError, v } from "convex/values";
import { checkOwner } from "./owner";

/*
 * Ship to production. "Ship now" runs five checks on main in one sandbox, tags the version (`v<n>`), and deploys
 * it to production: its own Vercel project and its own database, separate from the preview. Rolling production
 * back redeploys an earlier version's code; the production database is kept as it is. The worker side is
 * worker.py + engine/ship.py; both sides follow the same events (ship_started, ship_check, ship_live, ship_failed).
 *
 * The rules below are pure functions, so the app and the tests can import them without a Convex backend.
 */

/** The checks a new ship runs, in order. The worker stops at the first failure. */
export const SHIP_CHECKS = [
  { name: "types", label: "Types check" },
  { name: "lint", label: "Lint" },
  { name: "tests", label: "All tests pass" },
  { name: "build", label: "Production build" },
  { name: "pages", label: "Every page loads" },
] as const;

export type ShipCheckStatus = "running" | "passed" | "failed";
export type ShipCheck = { name: string; label: string; status: ShipCheckStatus; detail?: string };
export type ShipRunState = "checking" | "deploying" | "live" | "failed";

/** The running or last ship on the project row. `from` is the status before it (always "done"), restored after. */
export type Ship = { from: string; rollbackTo: number | null; state?: ShipRunState; checks?: ShipCheck[]; reason?: string };
/** One shipped version: the `v<n>` tag. `at` is milliseconds since epoch. */
export type Version = { n: number; tag: string; sha: string; url: string; at: number; label?: string };
/** What production runs now (set on every ship_live, a rollback too). `at` in milliseconds. */
export type Production = { url: string; version: number; at: number };

type Row = { mode?: string; status: string; ship?: Ship; versions?: Version[]; production?: Production };

/** Shipping needs a built app (done, with a repo) and nothing running. */
export function canShip(status: string, running: boolean, hasRepo: boolean): boolean {
  return hasRepo && !running && status === "done";
}

/** Why shipping (or rolling production back) can't be done now, in one line, or null when it can.
 *  Null exactly when canShip is true. */
export function shipBlockedReason(status: string, running: boolean, hasRepo: boolean, action: "ship" | "rollback" = "ship"): string | null {
  const doIt = action === "ship" ? "Ship" : "Roll production back";
  if (!hasRepo) return "There's nothing to ship yet: the app hasn't been built.";
  if (status === "shipping") return "Production is being updated right now. Wait for it to finish.";
  if (running || status !== "done") {
    return status === "failed" || status === "stopped" || status === "rejected"
      ? "Only a finished app can go to production. Retry or fix the build first."
      : `The team is still working on this project. ${doIt} once it has finished.`;
  }
  return null;
}

/** Production can go back to version n when shipping is allowed, n exists, and n isn't what's live now. */
export function canRollbackProduction(status: string, running: boolean, hasRepo: boolean, versions: { n: number }[] | undefined,
                                      liveVersion: number | null | undefined, n: number): boolean {
  return canShip(status, running, hasRepo) && (versions ?? []).some((x) => x.n === n) && liveVersion !== n;
}

/** The list with this version added (a replayed event replaces its own entry), oldest first. */
export function addVersion(list: Version[] | undefined, x: Version): Version[] {
  return [...(list ?? []).filter((y) => y.n !== x.n), x].sort((a, b) => a.n - b.n);
}

/** The checks with this one set (a replayed event replaces its own entry), in the order they ran. */
function setCheck(list: ShipCheck[] | undefined, c: ShipCheck): ShipCheck[] {
  const checks = list ?? [];
  return checks.some((x) => x.name === c.name) ? checks.map((x) => (x.name === c.name ? c : x)) : [...checks, c];
}

const labelOf = (name: string) => SHIP_CHECKS.find((c) => c.name === name)?.label ?? name;

/** Whether every one of the five checks has passed. */
export const allChecksPassed = (checks: { name: string; status: string }[] | undefined) =>
  SHIP_CHECKS.every((c) => (checks ?? []).some((x) => x.name === c.name && x.status === "passed"));

/**
 * What engine.record changes on the project row for the ship events; merged into its patch last.
 * ship_started: shipping (checks for a new ship, straight to deploying for a rollback). ship_check: that check's state;
 * once all five passed it is deploying. ship_live: production, plus a new version unless it was a rollback.
 * ship_failed: the reason (and the failing check). The ship run's project_finished puts the status back to ship.from
 * (shipping never changes whether the app is built), and a ship that never said how it ended counts as failed.
 */
export function shipPatch(p: Row, kind: string, data: Record<string, unknown> | null | undefined, ts: number): Record<string, unknown> {
  const d = data ?? {};
  const ship: Ship = p.ship ?? { from: "done", rollbackTo: null };
  const at = Math.round(ts * 1000);
  switch (kind) {
    case "ship_started": {
      const rollback = Boolean(d.rollback);
      return { status: "shipping",
               ship: { from: ship.from, rollbackTo: ship.rollbackTo, state: rollback ? "deploying" : "checking", checks: [] } };
    }
    case "ship_check": {
      const name = String(d.name ?? "");
      if (!name) return {};
      const status: ShipCheckStatus = d.status === "passed" || d.status === "failed" ? d.status : "running";
      const check: ShipCheck = { name, label: String(d.label ?? labelOf(name)), status,
                                 ...(status === "failed" && typeof d.detail === "string" ? { detail: d.detail } : {}) };
      const checks = setCheck(ship.checks, check);
      const state: ShipRunState = status === "failed" ? "failed" : allChecksPassed(checks) ? "deploying" : "checking";
      return { ship: { ...ship, state, checks } };
    }
    case "ship_live": {
      const url = typeof d.url === "string" && d.url.startsWith("https://") ? d.url : null;
      const n = Number(d.version);
      if (!url || !Number.isInteger(n) || n < 1) return {};
      const patch: Record<string, unknown> = { ship: { ...ship, state: "live" }, production: { url, version: n, at } };
      if (!d.rollback) {
        patch.versions = addVersion(p.versions, { n, tag: typeof d.tag === "string" ? d.tag : `v${n}`, sha: String(d.sha ?? ""), url,
                                                  at: p.versions?.find((x) => x.n === n)?.at ?? at });
      }
      return patch;
    }
    case "ship_failed": {
      const name = typeof d.check === "string" ? d.check : null;
      const checks = name
        ? (ship.checks ?? []).some((x) => x.name === name)
          ? (ship.checks ?? []).map((x) => (x.name === name ? { ...x, status: "failed" as const } : x))
          : setCheck(ship.checks, { name, label: labelOf(name), status: "failed" })
        : ship.checks;
      return { ship: { ...ship, state: "failed", reason: String(d.reason ?? "The ship didn't finish.").slice(0, 300),
                       ...(checks ? { checks } : {}) } };
    }
    case "project_finished": {
      if (p.mode !== "ship") return {};
      const unfinished = ship.state !== "live" && ship.state !== "failed";
      return { status: ship.from || "done",
               ...(unfinished ? { ship: { ...ship, state: "failed", reason: ship.reason ?? "The ship stopped before it finished. Production is as it was." } } : {}) };
    }
    default:
      return {};
  }
}

/** What projectForWorker adds: the ship order (in mode "ship") and the versions shipped so far. */
export function shipForWorker(p: Row): { ship: { from: string; rollbackTo: number | null } | null; versions: Version[];
                                          production: Production | null } {
  const ship = p.mode === "ship" && p.ship ? { from: p.ship.from, rollbackTo: p.ship.rollbackTo ?? null } : null;
  return { ship, versions: p.versions ?? [], production: p.production ?? null };
}

/** Run the five checks, tag the next version and deploy it to production. */
export const shipNow = mutationGeneric({
  args: { key: v.string(), id: v.id("projects") },
  handler: async (ctx, { key, id }) => {
    checkOwner(key);
    const p = await ctx.db.get(id);
    if (!p) throw new ConvexError("This project doesn't exist any more.");
    const blocked = shipBlockedReason(p.status, false, Boolean(p.repo));
    if (blocked) throw new ConvexError(blocked);
    await ctx.db.patch(id, { status: "queued", mode: "ship", resume: false, error: undefined, planNote: undefined,
                             ship: { from: p.status, rollbackTo: null } });
    await ctx.scheduler.runAfter(0, anyApi.projects.startWorker, { projectId: id });
  },
});

/** Put production back on an earlier version's code. The production database is kept as it is. */
export const rollbackProduction = mutationGeneric({
  args: { key: v.string(), id: v.id("projects"), n: v.number() },
  handler: async (ctx, { key, id, n }) => {
    checkOwner(key);
    const p = await ctx.db.get(id);
    if (!p) throw new ConvexError("This project doesn't exist any more.");
    const blocked = shipBlockedReason(p.status, false, Boolean(p.repo), "rollback");
    if (blocked) throw new ConvexError(blocked);
    const versions = (p.versions ?? []) as Version[];
    if (!versions.some((x) => x.n === n)) throw new ConvexError(`There is no version ${n} to roll back to.`);
    if ((p.production as Production | undefined)?.version === n) throw new ConvexError(`Version ${n} is already live in production.`);
    await ctx.db.patch(id, { status: "queued", mode: "ship", resume: false, error: undefined, planNote: undefined,
                             ship: { from: p.status, rollbackTo: n } });
    await ctx.scheduler.runAfter(0, anyApi.projects.startWorker, { projectId: id });
  },
});
