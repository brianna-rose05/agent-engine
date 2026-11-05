import { describe, expect, it } from "vitest";
import { initialState, reduce } from "../src/lib/reduce";
import { shipChecks, shipRunning, versionNotes } from "../src/lib/ship";
import type { EngineEvent, ProjectState } from "../src/lib/types";
import {
  SHIP_CHECKS, addVersion, allChecksPassed, canRollbackProduction, canShip, shipBlockedReason, shipForWorker, shipPatch,
  type Production, type Ship, type Version,
} from "../convex/ship";

/* ------------------------------------------------------------------ project row (convex/ship.ts) */

type Row = { mode?: string; status: string; ship?: Ship; versions?: Version[]; production?: Production };

/** Apply events to a row the way engine.record does: its own status for project_finished, then shipPatch on top. */
function play(row: Row, events: [string, Record<string, unknown>, number][]): Row {
  let p = { ...row };
  for (const [kind, data, ts] of events) {
    const patch: Record<string, unknown> = kind === "project_finished" ? { status: data.status } : {};
    Object.assign(patch, shipPatch(p, kind, data, ts));
    p = { ...p, ...patch } as Row;
  }
  return p;
}

const queued = (rollbackTo: number | null = null): Row => ({ mode: "ship", status: "queued", ship: { from: "done", rollbackTo } });
const passAll = (ts: number): [string, Record<string, unknown>, number][] =>
  SHIP_CHECKS.flatMap((c, i) => [
    ["ship_check", { name: c.name, label: c.label, status: "running" }, ts + i * 2] as [string, Record<string, unknown>, number],
    ["ship_check", { name: c.name, label: c.label, status: "passed" }, ts + i * 2 + 1] as [string, Record<string, unknown>, number],
  ]);
const live = (n: number, ts: number, rollback = false): [string, Record<string, unknown>, number] =>
  ["ship_live", { url: `https://pawfect-grooming.vercel.app`, version: n, tag: `v${n}`, sha: `abc123${n}`, rollback, database: "x-prod" }, ts];

describe("canShip and canRollbackProduction", () => {
  it("ships only a finished app with a repo while nothing runs", () => {
    expect(canShip("done", false, true)).toBe(true);
    expect(canShip("done", true, true)).toBe(false);
    expect(canShip("done", false, false)).toBe(false);
    for (const s of ["queued", "starting", "planning", "building", "shipping", "failed", "stopped", "rejected", "awaiting_approval"]) {
      expect(canShip(s, false, true)).toBe(false);
    }
  });

  it("has a plain reason exactly when shipping isn't allowed", () => {
    for (const s of ["done", "building", "shipping", "failed", "queued"]) {
      for (const running of [false, true]) {
        for (const repo of [false, true]) {
          expect(shipBlockedReason(s, running, repo) === null).toBe(canShip(s, running, repo));
        }
      }
    }
    expect(shipBlockedReason("done", false, false)).toMatch(/hasn't been built/);
    expect(shipBlockedReason("shipping", false, true)).toMatch(/being updated right now/);
    expect(shipBlockedReason("failed", false, true)).toMatch(/Only a finished app/);
    expect(shipBlockedReason("building", false, true, "rollback")).toMatch(/Roll production back once it has finished/);
  });

  it("rolls back only to an existing version that isn't live", () => {
    const versions = [{ n: 1 }, { n: 2 }];
    expect(canRollbackProduction("done", false, true, versions, 2, 1)).toBe(true);
    expect(canRollbackProduction("done", false, true, versions, 2, 2)).toBe(false); // already live
    expect(canRollbackProduction("done", false, true, versions, 2, 3)).toBe(false); // no such version
    expect(canRollbackProduction("building", false, true, versions, 2, 1)).toBe(false);
    expect(canRollbackProduction("done", false, true, undefined, null, 1)).toBe(false);
  });
});

describe("shipPatch: the project row", () => {
  it("goes checking -> deploying -> live, appends version 1 and sets production", () => {
    let p = play(queued(), [["ship_started", { version: null, rollback: false }, 100]]);
    expect(p.status).toBe("shipping");
    expect(p.ship).toEqual({ from: "done", rollbackTo: null, state: "checking", checks: [] });
    p = play(p, passAll(101).slice(0, 3));
    expect(p.ship!.state).toBe("checking");
    expect(p.ship!.checks!.map((c) => [c.name, c.status])).toEqual([["types", "passed"], ["lint", "running"]]);
    p = play(p, passAll(101));
    expect(p.ship!.state).toBe("deploying");
    expect(allChecksPassed(p.ship!.checks)).toBe(true);
    p = play(p, [live(1, 130), ["project_finished", { status: "done", repo: "r" }, 131]]);
    expect(p.ship!.state).toBe("live");
    expect(p.versions).toEqual([{ n: 1, tag: "v1", sha: "abc1231", url: "https://pawfect-grooming.vercel.app", at: 130000 }]);
    expect(p.production).toEqual({ url: "https://pawfect-grooming.vercel.app", version: 1, at: 130000 });
    expect(p.status).toBe("done");
  });

  it("a replayed ship_live or check doesn't duplicate anything", () => {
    let p = play(queued(), [["ship_started", { version: null, rollback: false }, 100], ...passAll(101), live(1, 130)]);
    const once = p;
    p = play(p, [live(1, 140), ...passAll(141)]);
    expect(p.versions).toHaveLength(1);
    expect(p.versions![0].at).toBe(130000); // the first time it went live
    expect(p.ship!.checks).toHaveLength(SHIP_CHECKS.length);
    expect(p.ship!.checks).toEqual(once.ship!.checks);
  });

  it("a failed check keeps its detail, stops the ship, and leaves versions and production alone", () => {
    const before: Row = { ...queued(), versions: [{ n: 1, tag: "v1", sha: "a", url: "https://x.vercel.app", at: 1 }],
                          production: { url: "https://x.vercel.app", version: 1, at: 1 } };
    let p = play(before, [
      ["ship_started", { version: null, rollback: false }, 100],
      ["ship_check", { name: "types", label: "Types check", status: "running" }, 101],
      ["ship_check", { name: "types", label: "Types check", status: "passed" }, 102],
      ["ship_check", { name: "lint", label: "Lint", status: "running" }, 103],
      ["ship_check", { name: "lint", label: "Lint", status: "failed", detail: "src/app/page.tsx\n  3:7  error  'x' is unused" }, 104],
    ]);
    expect(p.ship!.state).toBe("failed");
    expect(p.ship!.checks!.find((c) => c.name === "lint")).toEqual(
      { name: "lint", label: "Lint", status: "failed", detail: "src/app/page.tsx\n  3:7  error  'x' is unused" });
    p = play(p, [["ship_failed", { reason: "Lint found a problem.", check: "lint" }, 105],
                 ["project_finished", { status: "done", repo: "r" }, 106]]);
    expect(p.ship!.reason).toBe("Lint found a problem.");
    expect(p.ship!.checks!.find((c) => c.name === "lint")!.detail).toContain("is unused"); // ship_failed keeps the detail
    expect(p.versions).toEqual(before.versions);
    expect(p.production).toEqual(before.production);
    expect(p.status).toBe("done");
  });

  it("a rollback deploys without checks, moves production, and never appends a version", () => {
    const before: Row = { ...queued(1),
      versions: [{ n: 1, tag: "v1", sha: "a", url: "https://x.vercel.app", at: 1 }, { n: 2, tag: "v2", sha: "b", url: "https://x.vercel.app", at: 2 }],
      production: { url: "https://x.vercel.app", version: 2, at: 2000 } };
    let p = play(before, [["ship_started", { version: 1, rollback: true }, 200]]);
    expect(p.ship!.state).toBe("deploying");
    p = play(p, [live(1, 210, true), ["project_finished", { status: "done", repo: "r" }, 211]]);
    expect(p.versions).toEqual(before.versions);
    expect(p.production).toEqual({ url: "https://pawfect-grooming.vercel.app", version: 1, at: 210000 });
    expect(p.status).toBe("done");
  });

  it("project_finished restores the status from before, and a ship that never said how it ended counts as failed", () => {
    const p = play(queued(), [["ship_started", { version: null, rollback: false }, 100],
                              ["ship_check", { name: "types", label: "Types check", status: "running" }, 101],
                              ["project_finished", { status: "failed", repo: "r" }, 102]]);
    expect(p.status).toBe("done"); // shipping never changes whether the app is built
    expect(p.ship!.state).toBe("failed");
    expect(p.ship!.reason).toMatch(/stopped before it finished/);
  });

  it("leaves other runs' project_finished and other events alone", () => {
    expect(shipPatch({ mode: "change", status: "building" }, "project_finished", { status: "done" }, 1)).toEqual({});
    expect(shipPatch({ status: "done" }, "checkpoint_created", { n: 1 }, 1)).toEqual({});
    expect(shipPatch({ status: "done" }, "ship_live", { url: "http://insecure", version: 1 }, 1)).toEqual({});
  });

  it("addVersion keeps one entry per number, oldest first", () => {
    const v = (n: number, at = n) => ({ n, tag: `v${n}`, sha: "s", url: "https://x.vercel.app", at });
    expect(addVersion([v(2), v(1)], v(3)).map((x) => x.n)).toEqual([1, 2, 3]);
    expect(addVersion([v(1), v(2)], v(2, 99))).toEqual([v(1), v(2, 99)]);
  });

  it("projectForWorker gets the ship order and the versions", () => {
    const versions = [{ n: 1, tag: "v1", sha: "a", url: "https://x.vercel.app", at: 1 }];
    expect(shipForWorker({ ...queued(1), versions })).toEqual({ ship: { from: "done", rollbackTo: 1 }, versions, production: null });
    expect(shipForWorker({ mode: "change", status: "queued", ship: { from: "done", rollbackTo: null } }).ship).toBeNull();
    expect(shipForWorker({ status: "done" })).toEqual({ ship: null, versions: [], production: null });
  });
});

/* ------------------------------------------------------------------ the app (lib/ship.ts via reduce) */

const ev = (t: number, kind: EngineEvent["kind"], data: Record<string, unknown>, task_id: string | null = null): EngineEvent =>
  ({ t, kind, task_id, data });

const plan = { project: "x", contracts: [], tasks: [
  { id: "T1", title: "Book an appointment", module: "src/server/book.ts", spec: "", depends_on: [] },
  { id: "T2", title: "See your bookings", module: "src/server/list.ts", spec: "", depends_on: [] },
  { id: "T3", title: "Reviews", module: "src/server/reviews.ts", spec: "", depends_on: [] },
] };

/** Built with T1 and T2 merged (T3 failed), checkpoint 1, done. */
function built(): ProjectState {
  return [
    ev(0, "plan_ready", { plan }),
    ev(1, "task_queued", { title: "Book", role: "dev", depends_on: [] }, "T1"),
    ev(1, "task_queued", { title: "List", role: "dev", depends_on: [] }, "T2"),
    ev(1, "task_queued", { title: "Reviews", role: "dev", depends_on: [] }, "T3"),
    ev(2, "task_status", { status: "merged" }, "T1"),
    ev(3, "task_status", { status: "merged" }, "T2"),
    ev(4, "task_status", { status: "failed" }, "T3"),
    ev(5, "checkpoint_created", { n: 1, tag: "checkpoint-1", sha: "aaaaaaa", label: "Build finished", merged: ["T1", "T2"] }),
    ev(6, "project_finished", { status: "done", repo: "https://github.com/me/studio-x" }),
  ].reduce(reduce, initialState());
}

const checks = (t: number) => SHIP_CHECKS.flatMap((c, i) => [
  ev(t + i * 2, "ship_check", { name: c.name, label: c.label, status: "running" }),
  ev(t + i * 2 + 1, "ship_check", { name: c.name, label: c.label, status: "passed" }),
]);

function shipped(s: ProjectState, n: number, t: number): ProjectState {
  return [
    ev(t, "ship_started", { version: null, rollback: false }),
    ...checks(t + 1),
    ev(t + 20, "ship_live", { url: "https://x.vercel.app", version: n, tag: `v${n}`, sha: `sha${n}`, rollback: false, database: "x-prod" }),
    ev(t + 21, "project_finished", { status: "done", repo: "https://github.com/me/studio-x" }),
  ].reduce(reduce, s);
}

describe("shipping in the app", () => {
  it("ticks the checks in live and says the version is live, with no feature tally", () => {
    let s = reduce(built(), ev(10, "ship_started", { version: null, rollback: false }));
    expect(s.status).toBe("shipping");
    expect(shipRunning(s)).toBe(true);
    expect(shipChecks(s.ship!.run).map((c) => c.status)).toEqual(SHIP_CHECKS.map(() => "pending"));
    s = checks(11).slice(0, 3).reduce(reduce, s);
    expect(shipChecks(s.ship!.run).map((c) => c.status)).toEqual(["passed", "running", ...SHIP_CHECKS.slice(2).map(() => "pending")]);
    expect(shipChecks(s.ship!.run).map((c) => c.label)).toEqual(SHIP_CHECKS.map((c) => c.label));
    s = checks(11).reduce(reduce, s);
    expect(s.ship!.run!.state).toBe("deploying");
    const tallies = s.feed.filter((f) => f.text.startsWith("Finished:")).length;
    s = shipped(built(), 1, 10);
    expect(s.status).toBe("done");
    expect(shipRunning(s)).toBe(false);
    expect(s.ship!.production).toEqual({ url: "https://x.vercel.app", version: 1, t: 30 });
    expect(s.ship!.versions.map((v) => v.n)).toEqual([1]);
    expect(s.feed.some((f) => f.text === "Version 1 is live at https://x.vercel.app." && f.tone === "good" && f.channel === "build")).toBe(true);
    expect(s.feed.filter((f) => f.text.startsWith("Finished:"))).toHaveLength(tallies);
    expect(s.history!.repo).toBe("https://github.com/me/studio-x");
  });

  it("lists security, accessibility and speed after the page check", () => {
    expect(SHIP_CHECKS.map((c) => c.name)).toEqual(["types", "lint", "tests", "build", "pages", "security", "accessibility", "speed"]);
    expect(SHIP_CHECKS.slice(5).map((c) => c.label)).toEqual(["Security", "Accessibility", "Speed"]);
  });

  it("a warning keeps its notes, the ship goes on, and the live message names it", () => {
    const notes = "WARN [moderate] region: on /book phone\nPassed with warnings: 1 moderate problem.";
    const table = "Page  Response  JS (gzip)\n/     40 ms     102 kB";
    let s = reduce(built(), ev(10, "ship_started", { version: null, rollback: false }));
    s = checks(11).map((e) => (e.data as { name?: string }).name === "accessibility" && (e.data as { status?: string }).status === "passed"
      ? { ...e, data: { ...e.data, status: "warning", detail: notes } }
      : (e.data as { name?: string }).name === "speed" && (e.data as { status?: string }).status === "passed"
        ? { ...e, data: { ...e.data, detail: table } } : e).reduce(reduce, s);
    const list = shipChecks(s.ship!.run);
    expect(list.find((c) => c.name === "accessibility")).toEqual({ name: "accessibility", label: "Accessibility", status: "warning", detail: notes });
    expect(list.find((c) => c.name === "speed")).toEqual({ name: "speed", label: "Speed", status: "passed", detail: table });
    expect(s.ship!.run!.state).toBe("deploying");              // a warning counts as passed
    s = reduce(s, ev(40, "ship_live", { url: "https://x.vercel.app", version: 1, tag: "v1", sha: "s1", rollback: false, database: "x-prod" }));
    expect(s.feed.at(-1)!.text).toBe("Version 1 is live at https://x.vercel.app. Accessibility passed with warnings: see the Ship screen.");
    expect(s.feed.at(-1)!.tone).toBe("good");
  });

  it("the project row keeps a warning's notes and deploys after it", () => {
    const events = passAll(101).map(([k, d, t]) => (d.name === "speed" && d.status === "passed"
      ? [k, { ...d, status: "warning", detail: "WARN /book: 450 kB of JS" }, t] : [k, d, t]) as [string, Record<string, unknown>, number]);
    const p = play(queued(), [["ship_started", { version: null, rollback: false }, 100], ...events]);
    expect(p.ship!.state).toBe("deploying");
    expect(p.ship!.checks!.find((c) => c.name === "speed")).toEqual(
      { name: "speed", label: "Speed", status: "warning", detail: "WARN /book: 450 kB of JS" });
    expect(allChecksPassed(p.ship!.checks)).toBe(true);
    expect(allChecksPassed(p.ship!.checks!.map((c) => (c.name === "speed" ? { ...c, status: "running" } : c)))).toBe(false);
    // a running check carries no detail, and an unknown status counts as running
    const q = play(queued(), [["ship_started", { version: null, rollback: false }, 100],
                              ["ship_check", { name: "speed", label: "Speed", status: "weird", detail: "x" }, 101]]);
    expect(q.ship!.checks).toEqual([{ name: "speed", label: "Speed", status: "running" }]);
  });

  it("a failed check shows its detail and says which check failed", () => {
    let s = [
      ev(10, "ship_started", { version: null, rollback: false }),
      ev(11, "ship_check", { name: "types", label: "Types check", status: "running" }),
      ev(12, "ship_check", { name: "types", label: "Types check", status: "passed" }),
      ev(13, "ship_check", { name: "lint", label: "Lint", status: "running" }),
      ev(14, "ship_check", { name: "lint", label: "Lint", status: "failed", detail: "3:7  error  'x' is unused" }),
    ].reduce(reduce, built());
    const lint = shipChecks(s.ship!.run).find((c) => c.name === "lint")!;
    expect(lint).toEqual({ name: "lint", label: "Lint", status: "failed", detail: "3:7  error  'x' is unused" });
    expect(s.feed.some((f) => f.text.startsWith("Production check failed"))).toBe(false); // said once, by ship_failed
    s = reduce(s, ev(15, "ship_failed", { reason: "Lint found a problem", check: "lint" }));
    s = reduce(s, ev(16, "project_finished", { status: "done", repo: "https://github.com/me/studio-x" }));
    expect(s.feed.at(-1)!.text).toBe("Production check failed: Lint. Lint found a problem. Nothing was deployed.");
    expect(s.feed.at(-1)!.tone).toBe("bad");
    expect(s.status).toBe("done");
    expect(s.ship!.run!.state).toBe("failed");
    expect(s.ship!.versions).toEqual([]);
    expect(shipChecks(s.ship!.run).slice(2).map((c) => c.status)).toEqual(SHIP_CHECKS.slice(2).map(() => "pending"));
  });

  it("a failure that isn't a check says so, and mentions production is as it was", () => {
    let s = shipped(built(), 1, 10);
    s = [ev(40, "ship_started", { version: null, rollback: false }), ...checks(41),
         ev(60, "ship_failed", { reason: "The production database couldn't be set up" })].reduce(reduce, s);
    expect(s.feed.at(-1)!.text).toBe(
      "Couldn't ship to production: The production database couldn't be set up. Nothing was deployed, so production is as it was.");
    expect(s.ship!.production!.version).toBe(1);
  });

  it("rolling production back moves production but adds no version", () => {
    let s = shipped(shipped(built(), 1, 10), 2, 40);
    expect(s.ship!.versions.map((v) => v.n)).toEqual([1, 2]);
    s = [ev(70, "ship_started", { version: 1, rollback: true }),
         ev(80, "ship_live", { url: "https://x.vercel.app", version: 1, tag: "v1", sha: "sha1", rollback: true, database: "x-prod" }),
         ev(81, "project_finished", { status: "done", repo: "https://github.com/me/studio-x" })].reduce(reduce, s);
    expect(s.feed.some((f) => f.text.startsWith("Roll production back to version 1."))).toBe(true);
    expect(s.feed.some((f) => f.text === "Production is back on version 1 at https://x.vercel.app. Its database was kept as it is.")).toBe(true);
    expect(s.ship!.versions.map((v) => v.n)).toEqual([1, 2]);
    expect(s.ship!.production!.version).toBe(1);
    expect(s.status).toBe("done");
  });

  it("a replayed ship_live adds no second version", () => {
    let s = shipped(built(), 1, 10);
    s = reduce(s, ev(50, "ship_live", { url: "https://x.vercel.app", version: 1, tag: "v1", sha: "sha1", rollback: false }));
    expect(s.ship!.versions).toHaveLength(1);
    expect(s.ship!.versions[0].t).toBe(30);
  });

  it("a ship whose run ended without a result is marked failed", () => {
    const s = [ev(10, "ship_started", { version: null, rollback: false }),
               ev(11, "project_finished", { status: "done", repo: "https://github.com/me/studio-x" })].reduce(reduce, built());
    expect(s.status).toBe("done");
    expect(s.ship!.run!.state).toBe("failed");
    expect(s.feed.at(-1)!.text).toMatch(/stopped before it finished/);
  });

  it("lists what's in the version: everything first, then only what's new", () => {
    let s = built();
    expect(versionNotes(s)).toEqual({ since: null, features: ["Book an appointment", "See your bookings"], changes: [] });
    s = reduce(s, ev(7, "checkpoint_created", { n: 2, tag: "checkpoint-2", sha: "bbbbbbb", label: "Quick change 1: Make the button green", merged: ["T1", "T2"] }));
    expect(versionNotes(s).changes).toEqual(["Quick change 1: Make the button green"]);
    s = shipped(s, 1, 10);
    expect(versionNotes(s)).toEqual({ since: 1, features: [], changes: [] });
    s = [ev(40, "checkpoint_created", { n: 3, tag: "checkpoint-3", sha: "ccccccc", label: "Change 1: Add reviews", merged: ["T1", "T2"] }),
         ev(41, "checkpoint_created", { n: 4, tag: "checkpoint-4", sha: "ddddddd", label: "Retry finished", merged: ["T1", "T2", "T3"] })]
      .reduce(reduce, s);
    s = [ev(39, "task_status", { status: "merged" }, "T3")].reduce(reduce, s);
    expect(versionNotes(s)).toEqual({ since: 1, features: ["Reviews"], changes: ["Change 1: Add reviews"] });
  });

  it("other events still reduce as before with no ship state", () => {
    const s = built();
    expect(s.ship).toBeUndefined();
    expect(s.feed.some((f) => f.text.startsWith("Finished: 2 of 3 features"))).toBe(true);
  });
});
