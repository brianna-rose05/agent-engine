import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Db } from "./db";
import { AppError } from "./errors";

/**
 * Sign-in for pages and server actions. Template file: do not edit. Use it through src/lib/session.ts.
 * Server functions never see passwords or cookies: pages sign people in here, then pass an Actor.
 *
 * Two backends with the same behavior:
 * - Supabase Auth, when NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are set (production).
 * - Local accounts stored in the app database, otherwise (local mode, automated checks, and previews on
 *   their own Postgres). The session cookie is signed with APP_SESSION_SECRET when set (the deployer sets
 *   it), otherwise with a secret kept in the database.
 */
export interface Auth {
  /** Creates the login and signs the person in. Returns their user id (the id in auth.users). */
  signUp(email: string, password: string): Promise<{ userId: string }>;
  /** Throws AppError("unauthenticated", "Wrong email or password.") on any mismatch. */
  signIn(email: string, password: string): Promise<{ userId: string }>;
  signOut(): Promise<void>;
  /** The signed-in user's id, or null. */
  currentUserId(): Promise<string | null>;
  /** Changes the signed-in user's password. */
  changePassword(newPassword: string): Promise<void>;
  /** Changes the signed-in user's login email. */
  changeEmail(newEmail: string): Promise<void>;
  /** Sends a reset link (Supabase) or does nothing visible (local mode). Never reveals if the email exists. */
  requestPasswordReset(email: string, redirectTo: string): Promise<void>;
}

/** The part of Next's cookie store auth needs (matches `await cookies()` from next/headers). */
export interface CookieJar {
  get(name: string): { value: string } | undefined;
  set(name: string, value: string, options?: Record<string, unknown>): unknown;
  delete(name: string): unknown;
}

const cleanEmail = (email: string) => email.trim().toLowerCase();
const SESSION = "app_session";
const WEEK_S = 7 * 24 * 3600;

function requirePassword(password: string) {
  if (password.length < 6) throw new AppError("invalid", "Password must be at least 6 characters.");
}

// --------------------------------------------------------------------------------------------- local
const LOCAL_SETUP = `
  create schema if not exists app_local_auth;
  create table if not exists app_local_auth.accounts (
    user_id uuid primary key, email text unique not null, salt text not null, hash text not null);
  create table if not exists app_local_auth.secret (id int primary key, value text not null);
`;

const hash = (password: string, salt: string) => scryptSync(password, salt, 32).toString("hex");

/** Local accounts in the app database, with an HMAC-signed session cookie. */
export function localAuth(db: Db, jar: CookieJar, now: () => number = Date.now): Auth {
  let ready: Promise<string> | null = null;
  const secret = () =>
    (ready ??= (async () => {
      for (const stmt of LOCAL_SETUP.split(";").map((s) => s.trim()).filter(Boolean)) await db.query(stmt);
      if (process.env.APP_SESSION_SECRET) return process.env.APP_SESSION_SECRET;
      await db.query("insert into app_local_auth.secret (id, value) values (1, $1) on conflict (id) do nothing",
                     [randomBytes(32).toString("hex")]);
      return (await db.query<{ value: string }>("select value from app_local_auth.secret where id = 1")).rows[0].value;
    })());
  const sign = async (body: string) => createHmac("sha256", await secret()).update(body).digest("hex");

  const startSession = async (userId: string) => {
    const body = `${userId}.${Math.floor(now() / 1000) + WEEK_S}`;
    jar.set(SESSION, `${body}.${await sign(body)}`, {
      httpOnly: true, sameSite: "lax", path: "/", maxAge: WEEK_S, secure: process.env.NODE_ENV === "production",
    });
  };

  const auth: Auth = {
    async signUp(email, password) {
      await secret();
      const e = cleanEmail(email);
      if (!e.includes("@")) throw new AppError("invalid", "Please enter a valid email address.");
      requirePassword(password);
      const taken = await db.query("select 1 from app_local_auth.accounts where email = $1", [e]);
      if (taken.rows.length) throw new AppError("conflict", "An account with this email already exists.");
      const userId = randomUUID();
      const salt = randomBytes(16).toString("hex");
      await db.transaction(async (tx) => {
        await tx.query("insert into auth.users (id, email) values ($1, $2)", [userId, e]);
        await tx.query("insert into app_local_auth.accounts (user_id, email, salt, hash) values ($1, $2, $3, $4)",
                       [userId, e, salt, hash(password, salt)]);
      });
      await startSession(userId);
      return { userId };
    },
    async signIn(email, password) {
      await secret();
      const { rows } = await db.query<{ user_id: string; salt: string; hash: string }>(
        "select user_id, salt, hash from app_local_auth.accounts where email = $1", [cleanEmail(email)]);
      const row = rows[0];
      const ok = row && timingSafeEqual(Buffer.from(hash(password, row.salt), "hex"), Buffer.from(row.hash, "hex"));
      if (!ok) throw new AppError("unauthenticated", "Wrong email or password.");
      await startSession(row.user_id);
      return { userId: row.user_id };
    },
    async signOut() {
      jar.delete(SESSION);
    },
    async currentUserId() {
      const raw = jar.get(SESSION)?.value;
      if (!raw) return null;
      const [userId, exp, mac] = raw.split(".");
      if (!userId || !exp || !mac) return null;
      const expected = await sign(`${userId}.${exp}`);
      if (mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
      if (Number(exp) * 1000 < now()) return null;
      return userId;
    },
    async changePassword(newPassword) {
      const userId = await auth.currentUserId();
      if (!userId) throw new AppError("unauthenticated", "Please sign in again.");
      requirePassword(newPassword);
      const salt = randomBytes(16).toString("hex");
      await db.query("update app_local_auth.accounts set salt = $2, hash = $3 where user_id = $1",
                     [userId, salt, hash(newPassword, salt)]);
    },
    async changeEmail(newEmail) {
      const userId = await auth.currentUserId();
      if (!userId) throw new AppError("unauthenticated", "Please sign in again.");
      const e = cleanEmail(newEmail);
      const taken = await db.query("select 1 from app_local_auth.accounts where email = $1 and user_id <> $2", [e, userId]);
      if (taken.rows.length) throw new AppError("conflict", "An account with this email already exists.");
      await db.transaction(async (tx) => {
        await tx.query("update app_local_auth.accounts set email = $2 where user_id = $1", [userId, e]);
        await tx.query("update auth.users set email = $2 where id = $1", [userId, e]);
      });
    },
    async requestPasswordReset() {
      // Local mode sends no email. Same visible result as Supabase, which never reveals whether the email exists.
    },
  };
  return auth;
}

// ------------------------------------------------------------------------------------------ supabase
/** Supabase Auth through a server client from @supabase/ssr (see src/lib/session.ts). */
export function supabaseAuth(client: SupabaseClient): Auth {
  const fail = (e: { message: string } | null, fallback: AppError) => {
    if (e) throw fallback;
  };
  return {
    async signUp(email, password) {
      requirePassword(password);
      const { data, error } = await client.auth.signUp({ email: cleanEmail(email), password });
      if (error?.message.toLowerCase().includes("registered")) {
        throw new AppError("conflict", "An account with this email already exists.");
      }
      fail(error, new AppError("invalid", error?.message ?? "Sign-up failed."));
      if (!data.user) throw new AppError("invalid", "Sign-up failed.");
      return { userId: data.user.id };
    },
    async signIn(email, password) {
      const { data, error } = await client.auth.signInWithPassword({ email: cleanEmail(email), password });
      if (error || !data.user) throw new AppError("unauthenticated", "Wrong email or password.");
      return { userId: data.user.id };
    },
    async signOut() {
      await client.auth.signOut();
    },
    async currentUserId() {
      const { data } = await client.auth.getUser();
      return data.user?.id ?? null;
    },
    async changePassword(newPassword) {
      requirePassword(newPassword);
      const { error } = await client.auth.updateUser({ password: newPassword });
      fail(error, new AppError("invalid", error?.message ?? "Couldn't change the password."));
    },
    async changeEmail(newEmail) {
      const { error } = await client.auth.updateUser({ email: cleanEmail(newEmail) });
      fail(error, new AppError("invalid", error?.message ?? "Couldn't change the email."));
    },
    async requestPasswordReset(email, redirectTo) {
      await client.auth.resetPasswordForEmail(cleanEmail(email), { redirectTo });
    },
  };
}
