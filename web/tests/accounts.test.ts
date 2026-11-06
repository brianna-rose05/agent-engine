import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DUMMY_HASH, INVITE_PREFIX, PBKDF2_ITERATIONS, SESSION_MS, SESSION_PREFIX, SIGNIN_MAX_FAILURES, SIGNIN_WINDOW_MS,
  afterFailure, checkEmail, checkName, checkPassword, hashPassword, hashToken, newToken, roleAtLeast, sameString,
  signInBlockedFor, verifyPassword, type Role,
} from "../convex/credentials";
import { requireRole, resolveKey } from "../convex/owner";
import * as accounts from "../convex/accounts";
import * as projects from "../convex/projects";
import * as comments from "../convex/comments";
import * as quick from "../convex/quick";
import * as settings from "../convex/settings";
import * as ship from "../convex/ship";
import * as checkpoints from "../convex/checkpoints";
import * as projectKeys from "../convex/projectKeys";
import * as notifications from "../convex/notifications";
import * as wizard from "../convex/wizard";
import { fakeCtx, type AnyFn } from "./fake-db";

const run = (fn: unknown, ctx: unknown, args: Record<string, unknown>) => (fn as AnyFn)._handler(ctx, args);

const FUNCTIONS: Record<string, AnyFn> = {
  "accounts:access": accounts.access, "accounts:signInState": accounts.signInState, "accounts:recordFailure": accounts.recordFailure,
  "accounts:startSession": accounts.startSession, "accounts:storeInvite": accounts.storeInvite,
  "accounts:redeemInvite": accounts.redeemInvite, "settings:webhook": settings.webhook,
};

const built = () => ({ _id: "p1", name: "Pawfect", description: "A booking app for a vet clinic.", model: "haiku", status: "done",
                       costUsd: 0.5, budgetUsd: 10, plan: { tasks: [] }, repo: "https://github.com/x/pawfect",
                       setupCodes: { preview: "K7PQ-M2XR-9TVD", production: "A2B3-C4D5-E6F7" } });

/** A Studio with one project and one signed-in person per role. Passwords use few PBKDF2 rounds, to keep tests fast. */
async function studio() {
  const f = fakeCtx({ projects: [built()] }, FUNCTIONS);
  const keys = {} as Record<Role, string>;
  for (const role of ["viewer", "editor", "owner"] as Role[]) {
    const uid = await f.ctx.db.insert("users", { email: `${role}@example.com`, name: `${role[0].toUpperCase()}${role.slice(1)} Person`,
                                                 passwordHash: await hashPassword("correct horse", 1000), role, createdAt: Date.now() });
    keys[role] = newToken(SESSION_PREFIX);
    await f.ctx.db.insert("sessions", { userId: uid, tokenHash: await hashToken(keys[role]), expiresAt: Date.now() + SESSION_MS,
                                        createdAt: Date.now() });
  }
  return { ...f, keys };
}

const env = { ...process.env };
beforeEach(() => {
  process.env.OWNER_PASSPHRASE = "pass";
  delete process.env.RESEND_API_KEY;
});
afterEach(() => {
  process.env = { ...env };
  vi.useRealTimers();
});

describe("passwords and tokens", () => {
  it("hashes with PBKDF2-SHA256, at least 210k rounds, a salt per hash, and verifies", async () => {
    expect(PBKDF2_ITERATIONS).toBeGreaterThanOrEqual(210_000);
    const h = await hashPassword("a long password");
    expect(h).toMatch(/^pbkdf2-sha256\$210000\$[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}$/);
    expect(h).not.toContain("a long password");
    expect(await hashPassword("a long password")).not.toBe(h); // fresh salt
    expect(await verifyPassword("a long password", h)).toBe(true);
    expect(await verifyPassword("a long passwore", h)).toBe(false);
    expect(await verifyPassword("", h)).toBe(false);
  });
  it("never matches a malformed hash or the stand-in for unknown emails", async () => {
    for (const bad of ["", "plain", "md5$1$a$b", "pbkdf2-sha256$x$a$b", "pbkdf2-sha256$1000$!!$b"]) {
      expect(await verifyPassword("whatever", bad)).toBe(false);
    }
    expect(await verifyPassword("", DUMMY_HASH)).toBe(false);
  });
  it("makes random prefixed tokens and stores only their SHA-256", async () => {
    const a = newToken(SESSION_PREFIX);
    expect(a).toMatch(/^sst_[A-Za-z0-9_-]{43}$/);
    expect(newToken(SESSION_PREFIX)).not.toBe(a);
    expect(newToken(INVITE_PREFIX)).toMatch(/^inv_/);
    expect(await hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashToken(a)).toBe(await hashToken(a));
  });
  it("checks what people type", () => {
    expect(checkEmail("  Ana@Example.COM ")).toEqual({ ok: true, value: "ana@example.com" });
    expect(checkEmail("not an email").ok).toBe(false);
    expect(checkName("  Ana   Lopez ")).toEqual({ ok: true, value: "Ana Lopez" });
    expect(checkName(" ").ok).toBe(false);
    expect(checkPassword("123456789").ok).toBe(false);
    expect(checkPassword("1234567890").ok).toBe(true);
    expect(sameString("abc", "abc")).toBe(true);
    expect(sameString("abc", "abd")).toBe(false);
    expect(sameString("abc", "abcd")).toBe(false);
  });
  it("orders roles viewer < editor < owner", () => {
    expect(roleAtLeast("owner", "editor")).toBe(true);
    expect(roleAtLeast("editor", "editor")).toBe(true);
    expect(roleAtLeast("editor", "owner")).toBe(false);
    expect(roleAtLeast("viewer", "editor")).toBe(false);
  });
});

describe("sessions", () => {
  it("the passphrase is always the owner; a session is its person's role", async () => {
    const s = await studio();
    expect(await resolveKey(s.ctx, "pass")).toEqual({ role: "owner", via: "passphrase", user: null });
    const a = await resolveKey(s.ctx, s.keys.editor);
    expect(a).toMatchObject({ role: "editor", via: "account", user: { name: "Editor Person", email: "editor@example.com" } });
    await expect(resolveKey(s.ctx, "wrong")).rejects.toThrow("Wrong passphrase.");
    await expect(resolveKey(s.ctx, newToken(SESSION_PREFIX))).rejects.toThrow("Please sign in again.");
  });
  it("expires after 30 days", async () => {
    const s = await studio();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + SESSION_MS - 60_000);
    expect((await resolveKey(s.ctx, s.keys.viewer)).role).toBe("viewer");
    vi.setSystemTime(Date.now() + 120_000);
    await expect(resolveKey(s.ctx, s.keys.viewer)).rejects.toThrow("Please sign in again.");
  });
  it("signs in with email + password, returns the token once, and signs out", async () => {
    const s = await studio();
    const r = await run(accounts.signIn, s.actionCtx, { email: " Editor@Example.com ", password: "correct horse" });
    expect(r).toMatchObject({ name: "Editor Person", role: "editor" });
    expect(r.token).toMatch(/^sst_/);
    const stored = s.tables.sessions.find((x) => x.tokenHash === undefined || x.tokenHash === r.token);
    expect(stored).toBeUndefined(); // the raw token is never stored
    expect((await resolveKey(s.ctx, r.token)).role).toBe("editor");
    await run(accounts.signOut, s.ctx, { key: r.token });
    await expect(resolveKey(s.ctx, r.token)).rejects.toThrow("Please sign in again.");
    await run(accounts.signOut, s.ctx, { key: "pass" }); // nothing to do, no error
    expect((await resolveKey(s.ctx, "pass")).role).toBe("owner");
  });
  it("refuses a wrong password or unknown email with the same message", async () => {
    const s = await studio();
    await expect(run(accounts.signIn, s.actionCtx, { email: "editor@example.com", password: "wrong horse" }))
      .rejects.toThrow("That email and password don't match.");
    await expect(run(accounts.signIn, s.actionCtx, { email: "nobody@example.com", password: "correct horse" }))
      .rejects.toThrow("That email and password don't match.");
  });
});

describe("sign-in rate limit", () => {
  it("counts failures per email in a 15-minute window", () => {
    let row = afterFailure(null, 0);
    for (let i = 1; i < SIGNIN_MAX_FAILURES; i++) row = afterFailure(row, i * 1000);
    expect(row.failures).toBe(SIGNIN_MAX_FAILURES);
    expect(signInBlockedFor(row, 60_000)).toBe(14);
    expect(signInBlockedFor(row, SIGNIN_WINDOW_MS)).toBe(0);
    expect(afterFailure(row, SIGNIN_WINDOW_MS)).toEqual({ failures: 1, windowStart: SIGNIN_WINDOW_MS });
    expect(signInBlockedFor({ failures: 9, windowStart: 0 }, 1)).toBe(0);
  });
  it("after 10 wrong passwords even the right one waits; other emails don't; success clears the counter", async () => {
    const s = await studio();
    vi.useFakeTimers();
    const t0 = Date.now();
    for (let i = 0; i < SIGNIN_MAX_FAILURES; i++) {
      await expect(run(accounts.signIn, s.actionCtx, { email: "editor@example.com", password: `wrong ${i}` })).rejects.toThrow("don't match");
    }
    await expect(run(accounts.signIn, s.actionCtx, { email: "editor@example.com", password: "correct horse" }))
      .rejects.toThrow(/Too many sign-in attempts.*15 minutes/);
    expect((await run(accounts.signIn, s.actionCtx, { email: "viewer@example.com", password: "correct horse" })).role).toBe("viewer");
    vi.setSystemTime(t0 + SIGNIN_WINDOW_MS + 1000);
    expect((await run(accounts.signIn, s.actionCtx, { email: "editor@example.com", password: "correct horse" })).role).toBe("editor");
    expect(s.tables.signInAttempts.find((a) => a.email === "editor@example.com")).toBeUndefined();
  });
});

describe("invites", () => {
  const invite = async (s: Awaited<ReturnType<typeof studio>>, email = "New@Example.com", role: Role = "editor", key = "pass") =>
    (await run(accounts.createInvite, s.actionCtx, { key, email, role })) as { path: string; expiresAt: number; emailed: boolean };
  const tokenOf = (path: string) => new URL(path, "https://studio.test").searchParams.get("token")!;

  it("owner invites, the link works once and signs the person in", async () => {
    const s = await studio();
    const inv = await invite(s);
    expect(inv.path).toMatch(/^\/join\?token=inv_/);
    expect(inv.emailed).toBe(false);
    const token = tokenOf(inv.path);
    expect(JSON.stringify(s.tables.invites)).not.toContain(token);
    expect(await run(accounts.inviteInfo, s.ctx, { token })).toEqual({ state: "open", email: "new@example.com", role: "editor" });

    await expect(run(accounts.acceptInvite, s.actionCtx, { token, name: "New", password: "short" })).rejects.toThrow("at least 10");
    const r = await run(accounts.acceptInvite, s.actionCtx, { token, name: " New  Person ", password: "a good long one" });
    expect(r).toMatchObject({ name: "New Person", role: "editor" });
    expect((await resolveKey(s.ctx, r.token)).user?.email).toBe("new@example.com");
    expect(await run(accounts.inviteInfo, s.ctx, { token })).toMatchObject({ state: "used" });
    await expect(run(accounts.acceptInvite, s.actionCtx, { token, name: "Again", password: "a good long one" }))
      .rejects.toThrow("already used");
    expect((await run(accounts.signIn, s.actionCtx, { email: "new@example.com", password: "a good long one" })).role).toBe("editor");
  });
  it("expires after 7 days", async () => {
    const s = await studio();
    vi.useFakeTimers();
    const token = tokenOf((await invite(s)).path);
    vi.setSystemTime(Date.now() + 7 * 24 * 3600 * 1000 + 1);
    expect(await run(accounts.inviteInfo, s.ctx, { token })).toMatchObject({ state: "expired" });
    await expect(run(accounts.acceptInvite, s.actionCtx, { token, name: "Late", password: "a good long one" })).rejects.toThrow("expired");
  });
  it("can be revoked, and a new invite for the same email replaces the old link", async () => {
    const s = await studio();
    const first = tokenOf((await invite(s)).path);
    const second = tokenOf((await invite(s)).path);
    expect(await run(accounts.inviteInfo, s.ctx, { token: first })).toEqual({ state: "unknown" });
    const list = await run(accounts.people, s.ctx, { key: "pass" });
    expect(list.invites).toHaveLength(1);
    await run(accounts.revokeInvite, s.ctx, { key: "pass", inviteId: list.invites[0].id });
    expect(await run(accounts.inviteInfo, s.ctx, { token: second })).toEqual({ state: "unknown" });
    await expect(run(accounts.acceptInvite, s.actionCtx, { token: second, name: "X", password: "a good long one" }))
      .rejects.toThrow("doesn't work");
  });
  it("only owners invite, and not someone who already has an account", async () => {
    const s = await studio();
    await expect(invite(s, "a@example.com", "viewer", s.keys.editor)).rejects.toThrow("Only the owner");
    await expect(invite(s, "editor@example.com")).rejects.toThrow("already has an account");
    expect((await invite(s, "b@example.com", "owner", s.keys.owner)).path).toMatch(/^\/join/);
    expect(s.tables.invites.find((i) => i.email === "b@example.com")?.createdBy).toBe("Owner Person");
  });
  it("is emailed when Resend and APP_URL are set", async () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.APP_URL = "https://studio.example.com/";
    const s = await studio();
    const inv = await invite(s, "c@example.com");
    expect(inv.emailed).toBe(true);
    expect(s.scheduled[0].name).toBe("notifications:sendEmail");
    expect(s.scheduled[0].args.to).toBe("c@example.com");
    expect(String(s.scheduled[0].args.body)).toContain(`https://studio.example.com${inv.path}`);
  });
});

describe("people", () => {
  it("owner changes roles and removes people, which signs them out everywhere", async () => {
    const s = await studio();
    const list = await run(accounts.people, s.ctx, { key: "pass" });
    const viewer = list.users.find((u: { role: string }) => u.role === "viewer");
    await run(accounts.setRole, s.ctx, { key: "pass", userId: viewer.id, role: "editor" });
    expect((await resolveKey(s.ctx, s.keys.viewer)).role).toBe("editor");
    await run(accounts.removePerson, s.ctx, { key: s.keys.owner, userId: viewer.id });
    await expect(resolveKey(s.ctx, s.keys.viewer)).rejects.toThrow("Please sign in again.");
    expect(s.tables.sessions.some((x) => x.userId === viewer.id)).toBe(false);
  });
  it("an account can't demote or remove itself; editors can't manage people", async () => {
    const s = await studio();
    const me = (await run(accounts.people, s.ctx, { key: s.keys.owner })).me;
    await expect(run(accounts.removePerson, s.ctx, { key: s.keys.owner, userId: me })).rejects.toThrow("yourself");
    await expect(run(accounts.setRole, s.ctx, { key: s.keys.owner, userId: me, role: "viewer" })).rejects.toThrow("yourself");
    await expect(run(accounts.people, s.ctx, { key: s.keys.editor })).rejects.toThrow("Only the owner");
    await expect(run(accounts.setRole, s.ctx, { key: s.keys.editor, userId: me, role: "viewer" })).rejects.toThrow("Only the owner");
  });
});

describe("roles on Studio functions", () => {
  // [function, args, minimum role]; each is run as viewer, editor, owner and the passphrase
  const cases: [string, unknown, Record<string, unknown>, Role][] = [
    ["projects.list", projects.list, {}, "viewer"],
    ["projects.get", projects.get, { id: "p1" }, "viewer"],
    ["quick.forProject", quick.forProject, { id: "p1" }, "viewer"],
    ["comments.forProject", comments.forProject, { id: "p1" }, "viewer"],
    ["projectKeys.status", projectKeys.status, { id: "p1" }, "viewer"],
    ["notifications.recent", notifications.recent, {}, "viewer"],
    ["projects.create", projects.create, { name: "New", description: "A small app that does one thing well.", model: "haiku" }, "editor"],
    ["quick.requestQuickChange", quick.requestQuickChange, { id: "p1", text: "Make the header blue" }, "editor"],
    ["projects.requestChange", projects.requestChange, { id: "p1", text: "Add a page for opening hours" }, "editor"],
    ["comments.add", comments.add, { id: "p1", path: "/", pathKnown: true, x: 0.5, y: 0.5, viewport: "desktop", text: "Bigger" }, "editor"],
    ["ship.shipNow", ship.shipNow, { id: "p1" }, "editor"],
    ["projects.rebuild", projects.rebuild, { id: "p1" }, "editor"],
    ["notifications.markAllRead", notifications.markAllRead, {}, "viewer"],
    ["projects.ensureSetupCodes", projects.ensureSetupCodes, { id: "p1" }, "owner"],
    ["projects.setBudget", projects.setBudget, { id: "p1", budgetUsd: 12 }, "owner"],
    ["settings.get", settings.get, {}, "owner"],
    ["settings.setSlackWebhook", settings.setSlackWebhook, { url: "https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXXXXXXXXXX" }, "owner"],
    ["projectKeys.remove", projectKeys.remove, { id: "p1" }, "owner"],
    ["accounts.people", accounts.people, {}, "owner"],
  ];
  const callers: { who: string; role: Role; key: (s: Awaited<ReturnType<typeof studio>>) => string }[] = [
    { who: "viewer", role: "viewer", key: (s) => s.keys.viewer },
    { who: "editor", role: "editor", key: (s) => s.keys.editor },
    { who: "owner account", role: "owner", key: (s) => s.keys.owner },
    { who: "passphrase", role: "owner", key: () => "pass" },
  ];
  for (const [name, fn, args, need] of cases) {
    for (const c of callers) {
      const allowed = roleAtLeast(c.role, need);
      it(`${name}: ${c.who} ${allowed ? "allowed" : "refused"}`, async () => {
        const s = await studio();
        const p = run(fn, s.ctx, { key: c.key(s), ...args });
        if (allowed) await expect(p).resolves.not.toThrow();
        else await expect(p).rejects.toThrow(need === "owner" ? "Only the owner" : "Ask the owner for edit access");
      });
    }
  }
  it("actions check roles too (wizard, project key, Slack test)", async () => {
    const s = await studio();
    await expect(run(wizard.addStory, s.actionCtx, { key: s.keys.viewer, id: "p1", featureId: "F1", text: "x" }))
      .rejects.toThrow("Ask the owner for edit access");
    await expect(run(projectKeys.set, s.actionCtx, { key: s.keys.editor, id: "p1", apiKey: "sk-ant-x" })).rejects.toThrow("Only the owner");
    await expect(run(settings.testSlack, s.actionCtx, { key: s.keys.editor })).rejects.toThrow("Only the owner");
    await expect(run(settings.testSlack, s.actionCtx, { key: newToken(SESSION_PREFIX) })).rejects.toThrow("Please sign in again.");
    expect(await run(settings.testSlack, s.actionCtx, { key: "pass" })).toEqual({ ok: false, message: "Save a webhook URL first." });
  });
  it("a viewer can't roll back; an unknown or expired key is asked to sign in again", async () => {
    const s = await studio();
    await expect(run(checkpoints.rollbackTo, s.ctx, { key: s.keys.viewer, id: "p1", n: 1 })).rejects.toThrow("edit access");
    await expect(requireRole(s.ctx, newToken(SESSION_PREFIX), "viewer")).rejects.toThrow("Please sign in again.");
    await expect(requireRole(s.ctx, "nope", "viewer")).rejects.toThrow("Wrong passphrase.");
  });
  it("every public function that takes `key` checks a role (static scan of convex/)", () => {
    const dir = join(__dirname, "..", "convex");
    const missing: string[] = [];
    let checked = 0;
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src.includes("checkOwner("), `${f} still uses checkOwner`).toBe(false);
      const parts = src.split(/export const (\w+) = (query|mutation|action)Generic\(/).slice(1);
      for (let i = 0; i < parts.length; i += 3) {
        const [name, , body] = [parts[i], parts[i + 1], parts[i + 2].split(/\nexport /)[0]];
        if (!/\bkey\b|\.\.\.owner|args: owner/.test(body.split("handler")[0])) continue; // takes no key (signIn, inviteInfo, engine:secret)
        checked++;
        if (!/requireRole(InAction)?\(|resolveKey\(|edit\(ctx/.test(body)) missing.push(`${f}:${name}`);
      }
    }
    // signOut needs no role: it only deletes the session its own key is
    expect(missing).toEqual(["accounts.ts:signOut"]);
    expect(checked).toBeGreaterThan(40);
  });
});

describe("who did what, and what never leaves the backend", () => {
  it("records the account on projects, quick changes, change requests and pins; not for the passphrase", async () => {
    const s = await studio();
    const id = await run(projects.create, s.ctx, { key: s.keys.editor, name: "Mine", description: "A small app that does one thing.", model: "haiku" });
    expect(s.tables.projects.find((p) => p._id === id)?.createdBy).toMatchObject({ name: "Editor Person" });
    await run(projects.create, s.ctx, { key: "pass", name: "Owner's", description: "A small app that does one thing.", model: "haiku" });
    const list = await run(projects.list, s.ctx, { key: s.keys.viewer });
    expect(list.map((p: { name: string; by: string | null }) => [p.name, p.by])).toEqual(
      expect.arrayContaining([["Mine", "Editor Person"], ["Owner's", null], ["Pawfect", null]]));

    await run(quick.requestQuickChange, s.ctx, { key: s.keys.editor, id: "p1", text: "Make the header blue" });
    expect((await run(quick.forProject, s.ctx, { key: s.keys.viewer, id: "p1" })).quicks[0].by).toMatchObject({ name: "Editor Person" });
    s.tables.projects[0].status = "done";
    await run(projects.requestChange, s.ctx, { key: s.keys.owner, id: "p1", text: "Add a page for opening hours" });
    expect((await run(projects.get, s.ctx, { key: s.keys.viewer, id: "p1" })).project.changes[0].by).toMatchObject({ name: "Owner Person" });
    s.tables.projects[0].status = "done";
    await run(comments.add, s.ctx, { key: s.keys.editor, id: "p1", path: "/", pathKnown: true, x: 0.1, y: 0.2, viewport: "phone", text: "Bigger" });
    expect((await run(comments.forProject, s.ctx, { key: s.keys.viewer, id: "p1" })).comments[0].by).toMatchObject({ name: "Editor Person" });
  });
  it("setup codes are for owners only", async () => {
    const s = await studio();
    expect((await run(projects.get, s.ctx, { key: s.keys.owner, id: "p1" })).project.setupCodes.preview).toBe("K7PQ-M2XR-9TVD");
    expect((await run(projects.get, s.ctx, { key: "pass", id: "p1" })).project.setupCodes.preview).toBe("K7PQ-M2XR-9TVD");
    expect((await run(projects.get, s.ctx, { key: s.keys.editor, id: "p1" })).project.setupCodes).toEqual({});
  });
  it("no client query returns a password hash, a token hash or a token", async () => {
    const s = await studio();
    const inv = (await run(accounts.createInvite, s.actionCtx, { key: "pass", email: "d@example.com", role: "viewer" })) as { path: string };
    const inviteToken = new URL(inv.path, "https://x.test").searchParams.get("token")!;
    const out = JSON.stringify([
      await run(projects.checkKey, s.ctx, { key: s.keys.owner }),
      await run(projects.checkKey, s.ctx, { key: "pass" }),
      await run(accounts.people, s.ctx, { key: "pass" }),
      await run(accounts.inviteInfo, s.ctx, { token: inviteToken }),
      await run(projects.list, s.ctx, { key: s.keys.owner }),
      await run(projects.get, s.ctx, { key: s.keys.owner, id: "p1" }),
    ]);
    expect(out).not.toMatch(/passwordHash|tokenHash|pbkdf2|sst_|inv_/);
    for (const row of [...s.tables.sessions, ...s.tables.invites]) expect(out).not.toContain(String(row.tokenHash));
    expect(out).toContain("Owner Person");
  });
  it("checkKey tells the screen who is signed in, and never throws", async () => {
    const s = await studio();
    expect(await run(projects.checkKey, s.ctx, { key: s.keys.viewer }))
      .toEqual({ ok: true, role: "viewer", via: "account", name: "Viewer Person", email: "viewer@example.com" });
    expect(await run(projects.checkKey, s.ctx, { key: "pass" })).toEqual({ ok: true, role: "owner", via: "passphrase", name: null, email: null });
    expect(await run(projects.checkKey, s.ctx, { key: newToken(SESSION_PREFIX) })).toEqual({ ok: false, message: "Please sign in again." });
  });
});
