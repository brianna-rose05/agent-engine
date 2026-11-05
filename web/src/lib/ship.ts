import { SHIP_CHECKS } from "../../convex/ship";
import type { EngineEvent, FeedItem, ProjectState, ShipCheckState, ShipRun, ShipState } from "./types";

/*
 * Ship to production in the app (convex/ship.ts has the rules and the project-row side). Kept apart from reduce.ts:
 * `reduce` hands every event through withShip, which handles the four ship events and the ship run's
 * project_finished itself and lets the rest of the reducer run otherwise. Pure, like the reducer.
 */

export const emptyShip = (): ShipState => ({ run: null, versions: [], production: null });

/** A sentence ends with a full stop. */
const sentence = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

const labelOf = (name: string) => SHIP_CHECKS.find((c) => c.name === name)?.label ?? name;

function setCheck(list: ShipCheckState[], c: ShipCheckState): ShipCheckState[] {
  return list.some((x) => x.name === c.name) ? list.map((x) => (x.name === c.name ? c : x)) : [...list, c];
}

export function withShip(s: ProjectState, e: EngineEvent, inner: (s: ProjectState, e: EngineEvent) => ProjectState): ProjectState {
  const sh = s.ship ?? emptyShip();
  const d = (e.data ?? {}) as Record<string, unknown>;
  const now = Math.max(s.now, e.t);
  const say = (item: Omit<FeedItem, "t" | "channel">) => [...s.feed, { t: e.t, channel: "build" as const, ...item }];
  const run = sh.run;
  const setRun = (next: Partial<ShipRun>): ShipState => ({ ...sh, run: run ? { ...run, ...next } : null });

  switch (e.kind) {
    case "ship_started": {
      const rollback = Boolean(d.rollback);
      const version = d.version == null ? null : Number(d.version);
      // a replayed start keeps the status from before the first one
      const before = run && !run.finished && run.rollback === rollback ? run.before : s.status;
      const next: ShipRun = { version, rollback, state: rollback ? "deploying" : "checking", checks: [], before, t: e.t, finished: false };
      return { ...s, now, status: "shipping", ship: { ...sh, run: next },
               feed: say({ who: "you", text: rollback
                 ? `Roll production back to version ${version}. Only the code goes back; the production database is kept as it is.`
                 : "Ship to production: running the five checks, then deploying the next version." }) };
    }
    case "ship_check": {
      if (!run || typeof d.name !== "string") return { ...s, now };
      const status = d.status === "passed" || d.status === "failed" ? d.status : "running";
      const check: ShipCheckState = { name: d.name, label: String(d.label ?? labelOf(d.name)), status,
                                      ...(status === "failed" && typeof d.detail === "string" ? { detail: d.detail } : {}) };
      const checks = setCheck(run.checks, check);
      const passedAll = SHIP_CHECKS.every((c) => checks.some((x) => x.name === c.name && x.status === "passed"));
      // a failed check is said once, by ship_failed, with the reason
      return { ...s, now, ship: setRun({ checks, state: status === "failed" ? "failed" : passedAll ? "deploying" : "checking",
                                         ...(status === "failed" ? { failed_check: d.name } : {}) }) };
    }
    case "ship_live": {
      const url = typeof d.url === "string" && d.url.startsWith("https://") ? d.url : null;
      const n = Number(d.version);
      if (!url || !Number.isInteger(n) || n < 1) return { ...s, now };
      const rollback = Boolean(d.rollback);
      const versions = rollback ? sh.versions : [
        ...sh.versions.filter((x) => x.n !== n),
        { n, tag: typeof d.tag === "string" ? d.tag : `v${n}`, sha: String(d.sha ?? ""), url,
          t: sh.versions.find((x) => x.n === n)?.t ?? e.t },
      ].sort((a, b) => a.n - b.n);
      const ship: ShipState = { run: run ? { ...run, state: "live", version: n } : null, versions,
                                production: { url, version: n, t: e.t } };
      return { ...s, now, ship,
               feed: say({ who: "engine", tone: "good", text: rollback
                 ? `Production is back on version ${n} at ${url}. Its database was kept as it is.`
                 : `Version ${n} is live at ${url}.` }) };
    }
    case "ship_failed": {
      const reason = String(d.reason ?? "the ship didn't finish").slice(0, 300);
      const name = typeof d.check === "string" ? d.check : run?.failed_check;
      const checks = run && name
        ? run.checks.some((x) => x.name === name)
          ? run.checks.map((x) => (x.name === name ? { ...x, status: "failed" as const } : x))
          : [...run.checks, { name, label: labelOf(name), status: "failed" as const }]
        : run?.checks ?? [];
      const asWas = sh.production ? "Nothing was deployed, so production is as it was." : "Nothing was deployed.";
      const label = name ? (checks.find((x) => x.name === name)?.label ?? labelOf(name)) : null;
      const text = label
        ? `Production check failed: ${label}. ${sentence(reason)} ${asWas}`
        : run?.rollback
          ? `Couldn't roll production back to version ${run.version}: ${sentence(reason)} Production is as it was.`
          : `Couldn't ship to production: ${sentence(reason)} ${asWas}`;
      return { ...s, now, ship: setRun({ state: "failed", reason, checks, ...(name ? { failed_check: name } : {}) }),
               feed: say({ who: "engine", tone: "bad", text }) };
    }
    case "project_finished": {
      if (!run || run.finished) return keep(inner(s, e), s);
      // the ship's own run: no feature tally, and the app is as built as it was (Convex record does the same)
      const unfinished = run.state !== "live" && run.state !== "failed";
      const reason = "The ship stopped before it finished. Production is as it was.";
      return { ...s, now, status: run.before === "shipping" ? "done" : run.before,
               ship: setRun({ finished: true, ...(unfinished ? { state: "failed", reason } : {}) }),
               feed: unfinished ? say({ who: "engine", tone: "bad", text: reason }) : s.feed };
    }
    default:
      return keep(inner(s, e), s);
  }
}

/** The rest of the reducer doesn't know about `ship`: carry it over. */
const keep = (next: ProjectState, s: ProjectState): ProjectState => (s.ship ? { ...next, ship: s.ship } : next);

/** The five checks as the Ship screen lists them: what each has reported, pending for the rest. */
export function shipChecks(run: ShipRun | null | undefined): ShipCheckState[] {
  const ran = run && !run.rollback ? run.checks : [];
  const known = SHIP_CHECKS.map((c) => ran.find((x) => x.name === c.name) ?? { name: c.name, label: c.label, status: "pending" as const });
  return [...known, ...ran.filter((x) => !SHIP_CHECKS.some((c) => c.name === x.name))];
}

/** Whether a ship (or production rollback) is running now. */
export const shipRunning = (s: ProjectState) => Boolean(s.ship?.run && !s.ship.run.finished && s.status === "shipping");

/** Checkpoint labels that only say a build finished: the features list covers those. */
const BUILD_LABEL = /^(Build|Retry) finished$/;

/**
 * What the next version holds, in plain English: the planned features that merged and the changes and quick
 * changes saved since the last version (checkpoint labels after its time). The first version holds everything.
 */
export function versionNotes(s: ProjectState): { since: number | null; features: string[]; changes: string[] } {
  const last = s.ship?.versions.at(-1);
  const after = (t: number) => !last || t > last.t;
  const features = (s.plan?.tasks ?? []).filter((p) => s.tasks[p.id]?.status === "merged" && after(s.tasks[p.id].since)).map((p) => p.title);
  const changes = (s.history?.checkpoints ?? []).filter((c) => after(c.t) && c.label && !BUILD_LABEL.test(c.label)).map((c) => c.label);
  return { since: last?.n ?? null, features, changes };
}
