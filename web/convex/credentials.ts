/*
 * Studio accounts (docs/accounts.md): password hashing, random tokens, the sign-in rate limit and the rules for
 * what people type. Pure Web Crypto, so the same code runs in Convex and in the tests. Nothing here touches the db.
 *
 * Passwords: PBKDF2-SHA256, PBKDF2_ITERATIONS rounds, a random 16-byte salt per user, stored as
 * "pbkdf2-sha256$<iterations>$<salt b64>$<hash b64>" so the rounds can be raised later without breaking old hashes.
 * Tokens (sessions, invites): 32 random bytes, given to the browser once; only their SHA-256 is stored.
 */

export const ROLES = ["viewer", "editor", "owner"] as const;
export type Role = (typeof ROLES)[number];
export const isRole = (x: unknown): x is Role => typeof x === "string" && (ROLES as readonly string[]).includes(x);
/** Whether `have` may do what needs `need`: viewer < editor < owner. */
export const roleAtLeast = (have: Role, need: Role) => ROLES.indexOf(have) >= ROLES.indexOf(need);

export const PBKDF2_ITERATIONS = 210_000;
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;
export const NAME_MAX = 80;
export const SESSION_DAYS = 30;
export const INVITE_DAYS = 7;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const SESSION_MS = SESSION_DAYS * DAY_MS;
export const INVITE_MS = INVITE_DAYS * DAY_MS;
/** Failed sign-ins allowed per email in one window before sign-in for that email is paused until the window ends. */
export const SIGNIN_MAX_FAILURES = 10;
export const SIGNIN_WINDOW_MS = 15 * 60 * 1000;

/** Session tokens and invite tokens start differently, so a pasted invite is never taken for a session. */
export const SESSION_PREFIX = "sst_";
export const INVITE_PREFIX = "inv_";

export const SIGN_IN_AGAIN = "Please sign in again.";

const text = new TextEncoder();

const toB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toB64Url = (bytes: Uint8Array) => toB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Compares two strings in time that depends only on their lengths. */
export function sameString(a: string, b: string): boolean {
  const x = text.encode(a);
  const y = text.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** A new random token: prefix + 32 random bytes, base64url. */
export function newToken(prefix: string): string {
  return prefix + toB64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** SHA-256 of a token, hex. What the db keeps instead of the token. */
export async function hashToken(token: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", text.encode(token)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey("raw", text.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, base, 256);
  return new Uint8Array(bits);
}

/** The stored form of a password. Runs in an action (it takes a noticeable fraction of a second on purpose). */
export async function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${iterations}$${toB64(salt)}$${toB64(await pbkdf2(password, salt, iterations))}`;
}

/** Whether `password` matches a stored hash. A malformed hash never matches. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, rounds, salt, hash] = stored.split("$");
  const iterations = Number(rounds);
  if (alg !== "pbkdf2-sha256" || !Number.isInteger(iterations) || iterations < 1 || !salt || !hash) return false;
  let got: Uint8Array;
  try {
    got = await pbkdf2(password, fromB64(salt), iterations);
  } catch {
    return false;
  }
  return sameString(toB64(got), hash);
}

/** Checked against when the email has no account, so a wrong email takes as long as a wrong password. */
export const DUMMY_HASH = "pbkdf2-sha256$210000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

// ------------------------------------------------------------------ what people type

type Checked<T> = { ok: true; value: T } | { ok: false; message: string };

export const normalizeEmail = (raw: unknown) => (typeof raw === "string" ? raw.trim().toLowerCase() : "");

export function checkEmail(raw: unknown): Checked<string> {
  const email = normalizeEmail(raw);
  if (!email) return { ok: false, message: "Enter an email address." };
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, message: "That doesn't look like an email address." };
  return { ok: true, value: email };
}

export function checkName(raw: unknown): Checked<string> {
  const name = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  if (!name) return { ok: false, message: "Enter your name." };
  if (name.length > NAME_MAX) return { ok: false, message: `Keep your name to ${NAME_MAX} characters.` };
  return { ok: true, value: name };
}

export function checkPassword(raw: unknown): Checked<string> {
  const pw = typeof raw === "string" ? raw : "";
  if (pw.length < PASSWORD_MIN) return { ok: false, message: `Use at least ${PASSWORD_MIN} characters for your password.` };
  if (pw.length > PASSWORD_MAX) return { ok: false, message: `Keep your password to ${PASSWORD_MAX} characters.` };
  return { ok: true, value: pw };
}

// ------------------------------------------------------------------ sign-in rate limit

export type Attempts = { failures: number; windowStart: number };

/** Minutes until sign-in for this email opens again, or 0 when it's open. */
export function signInBlockedFor(row: Attempts | null | undefined, now: number): number {
  if (!row || row.failures < SIGNIN_MAX_FAILURES) return 0;
  const left = row.windowStart + SIGNIN_WINDOW_MS - now;
  return left > 0 ? Math.ceil(left / 60000) : 0;
}

/** The counter after one more failed sign-in: a new window starts once the old one has passed. */
export function afterFailure(row: Attempts | null | undefined, now: number): Attempts {
  if (!row || now - row.windowStart >= SIGNIN_WINDOW_MS) return { failures: 1, windowStart: now };
  return { failures: row.failures + 1, windowStart: row.windowStart };
}

export const tooManyTries = (minutes: number) =>
  `Too many sign-in attempts for this email. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
