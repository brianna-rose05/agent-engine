import { anyApi } from "convex/server";
import { ConvexError } from "convex/values";
import { SESSION_PREFIX, SIGN_IN_AGAIN, hashToken, isRole, roleAtLeast, sameString, type Role } from "./credentials";

/*
 * Who is calling (docs/accounts.md). Every app call carries `key`: either the owner passphrase (OWNER_PASSPHRASE in
 * Convex, which always acts as role "owner", so the owner can never be locked out) or a session token from signing
 * in with an account (convex/accounts.ts), resolved to that person's role. requireRole replaces the old
 * passphrase-only check in every query and mutation; requireRoleInAction does the same for actions.
 */

export type Actor = { id: string; name: string };
export type Access = { role: Role; via: "passphrase" | "account"; user: (Actor & { email: string }) | null };

const PASSPHRASE_ACCESS: Access = { role: "owner", via: "passphrase", user: null };

/** The passphrase rule as it always was: the app isn't set up without it, and a wrong one says so. */
function passphraseAccess(key: string): Access | null {
  const expected = process.env.OWNER_PASSPHRASE;
  if (!expected) throw new ConvexError("The app isn't set up yet: OWNER_PASSPHRASE is missing in Convex.");
  return sameString(key, expected) ? PASSPHRASE_ACCESS : null;
}

const NEEDS: Record<Role, string> = {
  viewer: "You don't have access to this.",
  editor: "You can look but not change things. Ask the owner for edit access.",
  owner: "Only the owner can do this.",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbCtx = { db: { query: (t: any) => any; get: (id: any) => Promise<any> } };

/** Who `key` is, or throws: "Wrong passphrase." for a wrong passphrase, "Please sign in again." for a bad session. */
export async function resolveKey(ctx: DbCtx, key: string): Promise<Access> {
  const pass = passphraseAccess(key);
  if (pass) return pass;
  if (!key.startsWith(SESSION_PREFIX)) throw new ConvexError("Wrong passphrase.");
  const tokenHash = await hashToken(key);
  const s = await ctx.db.query("sessions").withIndex("by_token", (q: { eq: (f: string, v: string) => unknown }) => q.eq("tokenHash", tokenHash)).first();
  if (!s || s.expiresAt <= Date.now()) throw new ConvexError(SIGN_IN_AGAIN);
  const u = await ctx.db.get(s.userId);
  if (!u || !isRole(u.role)) throw new ConvexError(SIGN_IN_AGAIN);
  return { role: u.role, via: "account", user: { id: String(u._id), name: u.name, email: u.email } };
}

/** The caller's access if their role is at least `role`, else a ConvexError saying what's missing. */
export async function requireRole(ctx: DbCtx, key: string, role: Role): Promise<Access> {
  const a = await resolveKey(ctx, key);
  if (!roleAtLeast(a.role, role)) throw new ConvexError(NEEDS[role]);
  return a;
}

/** requireRole for actions (no db): the passphrase is checked here, a session through accounts.access. */
export async function requireRoleInAction(
  ctx: { runQuery: (ref: never, args: { key: string }) => Promise<unknown> }, key: string, role: Role,
): Promise<Access> {
  const pass = passphraseAccess(key);
  if (pass) return pass;
  const r = (await ctx.runQuery(anyApi.accounts.access as never, { key })) as { ok: true; access: Access } | { ok: false; message: string };
  if (!r.ok) throw new ConvexError(r.message);
  if (!roleAtLeast(r.access.role, role)) throw new ConvexError(NEEDS[role]);
  return r.access;
}

/** Who to record on what they made ("by Name" in history lists): only accounts, never the passphrase. */
export const actorOf = (a: Access): Actor | undefined => (a.user ? { id: a.user.id, name: a.user.name } : undefined);
