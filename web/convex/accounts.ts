import {
  actionGeneric, anyApi, internalMutationGeneric, internalQueryGeneric, mutationGeneric, queryGeneric,
} from "convex/server";
import { ConvexError, v, type GenericId } from "convex/values";
import {
  DUMMY_HASH, INVITE_MS, INVITE_PREFIX, SESSION_MS, SESSION_PREFIX, afterFailure, checkEmail, checkName, checkPassword,
  hashPassword, hashToken, newToken, normalizeEmail, signInBlockedFor, tooManyTries, verifyPassword, type Role,
} from "./credentials";
import { requireRole, requireRoleInAction, resolveKey } from "./owner";

/*
 * Studio accounts (docs/accounts.md). The owner passphrase keeps working as it always has; on top of it, the owner
 * invites people by email with a role (owner, editor, viewer). An invite is a one-time link /join?token=..., valid
 * for 7 days, where the person sets their name and password. Signing in gives the browser a session token (30 days)
 * that it sends as `key`, exactly where the passphrase goes. The db keeps only SHA-256 hashes of tokens and
 * PBKDF2 hashes of passwords, and no client query ever returns either.
 *
 * Hashing runs in actions (signIn, acceptInvite): PBKDF2 is slow on purpose and actions have the time for it.
 */

const roleV = v.union(v.literal("owner"), v.literal("editor"), v.literal("viewer"));
type Row = Record<string, unknown> & { _id: string };

// --------------------------------------------------------------------- who am I

/** For actions: who a session key is, without throwing (requireRoleInAction turns a refusal into an error). */
export const access = internalQueryGeneric({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    try {
      return { ok: true as const, access: await resolveKey(ctx, key) };
    } catch (e) {
      return { ok: false as const, message: e instanceof ConvexError ? String(e.data) : "Something went wrong." };
    }
  },
});

// --------------------------------------------------------------------- sign in and out

export const signInState = internalQueryGeneric({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const attempts = await ctx.db.query("signInAttempts").withIndex("by_email", (q) => q.eq("email", email)).first();
    const u = await ctx.db.query("users").withIndex("by_email", (q) => q.eq("email", email)).first();
    return { blockedFor: signInBlockedFor(attempts as never, Date.now()),
             user: u ? { id: String(u._id), passwordHash: u.passwordHash as string } : null };
  },
});

export const recordFailure = internalMutationGeneric({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const row = await ctx.db.query("signInAttempts").withIndex("by_email", (q) => q.eq("email", email)).first();
    const next = afterFailure(row as never, Date.now());
    if (row) await ctx.db.patch(row._id, next);
    else await ctx.db.insert("signInAttempts", { email, ...next });
  },
});

/** A successful sign-in: clears the failure counter and stores the new session (its hash only). */
export const startSession = internalMutationGeneric({
  args: { userId: v.string(), tokenHash: v.string() },
  handler: async (ctx, { userId, tokenHash }) => {
    const uid = ctx.db.normalizeId("users", userId);
    const u = uid && (await ctx.db.get(uid));
    if (!uid || !u) throw new ConvexError("That email and password don't match.");
    const row = await ctx.db.query("signInAttempts").withIndex("by_email", (q) => q.eq("email", u.email)).first();
    if (row) await ctx.db.delete(row._id);
    const now = Date.now();
    await ctx.db.insert("sessions", { userId: uid, tokenHash, expiresAt: now + SESSION_MS, createdAt: now });
    return { name: u.name as string, role: u.role as Role };
  },
});

/** Email + password -> a session token, given to the browser once. */
export const signIn = actionGeneric({
  args: { email: v.string(), password: v.string() },
  handler: async (ctx, args): Promise<{ token: string; name: string; role: Role }> => {
    const email = normalizeEmail(args.email);
    if (!email || !args.password) throw new ConvexError("Enter your email and password.");
    const state = (await ctx.runQuery(anyApi.accounts.signInState, { email })) as
      { blockedFor: number; user: { id: string; passwordHash: string } | null };
    if (state.blockedFor > 0) throw new ConvexError(tooManyTries(state.blockedFor));
    const ok = await verifyPassword(args.password, state.user?.passwordHash ?? DUMMY_HASH);
    if (!ok || !state.user) {
      await ctx.runMutation(anyApi.accounts.recordFailure, { email });
      throw new ConvexError("That email and password don't match.");
    }
    const token = newToken(SESSION_PREFIX);
    const who = (await ctx.runMutation(anyApi.accounts.startSession,
                                       { userId: state.user.id, tokenHash: await hashToken(token) })) as { name: string; role: Role };
    return { token, ...who };
  },
});

/** Deletes this browser's session. Signing out with the passphrase (or an expired session) does nothing. */
export const signOut = mutationGeneric({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    if (!key.startsWith(SESSION_PREFIX)) return;
    const tokenHash = await hashToken(key);
    const s = await ctx.db.query("sessions").withIndex("by_token", (q) => q.eq("tokenHash", tokenHash)).first();
    if (s) await ctx.db.delete(s._id);
  },
});

// --------------------------------------------------------------------- invites

export type InviteState = "open" | "used" | "expired";
export const inviteState = (i: { usedAt?: number; expiresAt: number }, now: number): InviteState =>
  i.usedAt ? "used" : i.expiresAt <= now ? "expired" : "open";

export const storeInvite = internalMutationGeneric({
  args: { email: v.string(), role: roleV, tokenHash: v.string(), createdBy: v.optional(v.string()) },
  handler: async (ctx, { email, role, tokenHash, createdBy }) => {
    if (await ctx.db.query("users").withIndex("by_email", (q) => q.eq("email", email)).first()) {
      throw new ConvexError("That person already has an account. Change their role under People instead.");
    }
    // a new invite replaces any open one for the same email, so only the latest link works
    const old = await ctx.db.query("invites").withIndex("by_email", (q) => q.eq("email", email)).collect();
    for (const i of old) if (!i.usedAt) await ctx.db.delete(i._id);
    const expiresAt = Date.now() + INVITE_MS;
    await ctx.db.insert("invites", { email, role, tokenHash, expiresAt, ...(createdBy ? { createdBy } : {}) });
    return { expiresAt };
  },
});

/**
 * Invite someone (owner only). Returns the join path with its token, shown once for the owner to copy; Studio also
 * emails the link when Resend is set up (RESEND_API_KEY and APP_URL, the same sender as notification emails).
 */
export const createInvite = actionGeneric({
  args: { key: v.string(), email: v.string(), role: roleV },
  handler: async (ctx, { key, email, role }): Promise<{ path: string; expiresAt: number; emailed: boolean }> => {
    const a = await requireRoleInAction(ctx as never, key, "owner");
    const checked = checkEmail(email);
    if (!checked.ok) throw new ConvexError(checked.message);
    const token = newToken(INVITE_PREFIX);
    const { expiresAt } = (await ctx.runMutation(anyApi.accounts.storeInvite, {
      email: checked.value, role, tokenHash: await hashToken(token), ...(a.user ? { createdBy: a.user.name } : {}),
    })) as { expiresAt: number };
    const path = `/join?token=${token}`;
    const appUrl = process.env.APP_URL;
    let emailed = false;
    if (process.env.RESEND_API_KEY && appUrl) {
      const link = `${appUrl.replace(/\/$/, "")}${path}`;
      await ctx.scheduler.runAfter(0, anyApi.notifications.sendEmail, {
        to: checked.value, title: "You're invited to Studio", path: "",
        body: `${a.user ? a.user.name : "The owner"} invited you to Studio as ${role === "owner" ? "an owner" : `a ${role}`}. ` +
              `Open this link within 7 days to set your password:\n\n${link}`,
      });
      emailed = true;
    }
    return { path, expiresAt, emailed };
  },
});

async function inviteByToken(ctx: { db: { query: (t: "invites") => never } }, token: string): Promise<Row | null> {
  if (!token.startsWith(INVITE_PREFIX)) return null;
  const tokenHash = await hashToken(token);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await (ctx.db.query("invites") as any).withIndex("by_token", (q: any) => q.eq("tokenHash", tokenHash)).first()) as Row | null;
}

/** What /join shows for a link: who it's for and whether it still works. Never the token or its hash. */
export const inviteInfo = queryGeneric({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const i = await inviteByToken(ctx as never, token);
    if (!i) return { state: "unknown" as const };
    return { state: inviteState(i as never, Date.now()), email: i.email as string, role: i.role as Role };
  },
});

export const redeemInvite = internalMutationGeneric({
  args: { token: v.string(), name: v.string(), passwordHash: v.string(), sessionHash: v.string() },
  handler: async (ctx, { token, name, passwordHash, sessionHash }) => {
    const i = await inviteByToken(ctx as never, token);
    const now = Date.now();
    if (!i) throw new ConvexError("This invite link doesn't work. Ask the owner for a new one.");
    const state = inviteState(i as never, now);
    if (state === "used") throw new ConvexError("This invite was already used. Sign in instead.");
    if (state === "expired") throw new ConvexError("This invite has expired. Ask the owner for a new one.");
    const email = i.email as string;
    if (await ctx.db.query("users").withIndex("by_email", (q) => q.eq("email", email)).first()) {
      throw new ConvexError("There's already an account for this email. Sign in instead.");
    }
    const userId = await ctx.db.insert("users", { email, name, passwordHash, role: i.role as Role, createdAt: now });
    await ctx.db.patch(i._id as GenericId<"invites">, { usedAt: now });
    await ctx.db.insert("sessions", { userId, tokenHash: sessionHash, expiresAt: now + SESSION_MS, createdAt: now });
    return { name, role: i.role as Role };
  },
});

/** Accept an invite: set name + password, create the account, and sign in. The invite works once. */
export const acceptInvite = actionGeneric({
  args: { token: v.string(), name: v.string(), password: v.string() },
  handler: async (ctx, args): Promise<{ token: string; name: string; role: Role }> => {
    const name = checkName(args.name);
    if (!name.ok) throw new ConvexError(name.message);
    const pw = checkPassword(args.password);
    if (!pw.ok) throw new ConvexError(pw.message);
    const token = newToken(SESSION_PREFIX);
    const who = (await ctx.runMutation(anyApi.accounts.redeemInvite, {
      token: args.token, name: name.value, passwordHash: await hashPassword(pw.value), sessionHash: await hashToken(token),
    })) as { name: string; role: Role };
    return { token, ...who };
  },
});

// --------------------------------------------------------------------- people (owner only)

/** Everyone with an account and every invite not yet used (newest first). No hashes, no tokens. */
export const people = queryGeneric({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const a = await requireRole(ctx, key, "owner");
    const now = Date.now();
    const users = await ctx.db.query("users").collect();
    const invites = await ctx.db.query("invites").collect();
    return {
      me: a.user?.id ?? null,
      users: users.map((u) => ({ id: String(u._id), email: u.email as string, name: u.name as string, role: u.role as Role,
                                 createdAt: u.createdAt as number }))
        .sort((x, y) => x.createdAt - y.createdAt),
      invites: invites.filter((i) => !i.usedAt)
        .map((i) => ({ id: String(i._id), email: i.email as string, role: i.role as Role, expiresAt: i.expiresAt as number,
                       createdBy: (i.createdBy as string | undefined) ?? null, state: inviteState(i as never, now) }))
        .sort((x, y) => y.expiresAt - x.expiresAt),
    };
  },
});

async function otherUser(ctx: { db: { normalizeId: (t: "users", id: string) => GenericId<"users"> | null; get: (id: GenericId<"users">) => Promise<unknown> } },
                         me: string | undefined, userId: string, doing: string) {
  const uid = ctx.db.normalizeId("users", userId);
  const u = uid && ((await ctx.db.get(uid)) as Row | null);
  if (!uid || !u) throw new ConvexError("That person doesn't have an account any more.");
  if (me && me === String(uid)) throw new ConvexError(`You can't ${doing} yourself. Ask another owner, or use the owner passphrase.`);
  return uid;
}

export const setRole = mutationGeneric({
  args: { key: v.string(), userId: v.string(), role: roleV },
  handler: async (ctx, { key, userId, role }) => {
    const a = await requireRole(ctx, key, "owner");
    const uid = await otherUser(ctx as never, a.user?.id, userId, "change the role of");
    await ctx.db.patch(uid, { role });
  },
});

/** Remove a person: their account and every session they have, so they're signed out everywhere at once. */
export const removePerson = mutationGeneric({
  args: { key: v.string(), userId: v.string() },
  handler: async (ctx, { key, userId }) => {
    const a = await requireRole(ctx, key, "owner");
    const uid = await otherUser(ctx as never, a.user?.id, userId, "remove");
    const sessions = await ctx.db.query("sessions").withIndex("by_user", (q) => q.eq("userId", uid)).collect();
    for (const s of sessions) await ctx.db.delete(s._id);
    await ctx.db.delete(uid);
  },
});

export const revokeInvite = mutationGeneric({
  args: { key: v.string(), inviteId: v.string() },
  handler: async (ctx, { key, inviteId }) => {
    await requireRole(ctx, key, "owner");
    const iid = ctx.db.normalizeId("invites", inviteId);
    const i = iid && (await ctx.db.get(iid));
    if (!iid || !i) return;
    if (i.usedAt) throw new ConvexError("This invite was already used. Remove the person instead.");
    await ctx.db.delete(iid);
  },
});

