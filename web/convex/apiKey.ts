/*
 * A project's own Anthropic API key ("bring your own key", docs/settings.md): the rules for what the owner pastes,
 * how it is shown (only the last 4 characters), and how it is stored: encrypted at rest with AES-GCM under a key
 * derived from the STUDIO_KEY_SECRET Convex environment variable. Pure Web Crypto, so the same code runs in Convex
 * and in the tests. The Convex functions are in convex/projectKeys.ts.
 */

export const KEY_PREFIX = "sk-ant-";
export const KEY_MIN = 40;
export const KEY_MAX = 256;
export const KEY_SECRET_ENV = "STUDIO_KEY_SECRET";
export const SECRET_MIN = 32;

export type KeyCheck = { ok: true; key: string } | { ok: false; message: string };

/** What the owner pasted, checked before anything is stored. Messages never repeat the key. */
export function checkAnthropicKey(raw: unknown): KeyCheck {
  const key = typeof raw === "string" ? raw.trim() : "";
  if (!key) return { ok: false, message: "Paste your Anthropic API key." };
  if (!key.startsWith(KEY_PREFIX)) {
    return { ok: false, message: `That doesn't look like an Anthropic API key: they start with ${KEY_PREFIX}` };
  }
  if (key.length < KEY_MIN) return { ok: false, message: "That key is too short. Copy the whole key from the Anthropic Console." };
  if (key.length > KEY_MAX) return { ok: false, message: "That key is too long. Paste only the key itself." };
  if (!/^sk-ant-[A-Za-z0-9_-]+$/.test(key)) {
    return { ok: false, message: "The key has characters an Anthropic key doesn't have. Paste it again without spaces or quotes." };
  }
  return { ok: true, key };
}

/** "…abcd": all the screen ever shows of a key. */
export const maskKey = (key: string) => `…${key.slice(-4)}`;

/** "Your key …abcd" or "Studio's key": which Anthropic key a project's agents run on (plan and setup pages). */
export const keyLabel = (s: { own: boolean; last4: string | null }) => (s.own ? `Your key …${s.last4 ?? "????"}` : "Studio's key");

/** Why keys can't be stored or read with this secret, in plain English, or null when it's fine. */
export function keySecretProblem(secret: string | undefined): string | null {
  if (!secret) {
    return `Studio can't store API keys yet: the ${KEY_SECRET_ENV} environment variable isn't set in Convex. ` +
           `Set it once (see docs/settings.md), then paste the key again.`;
  }
  if (secret.length < SECRET_MIN) {
    return `${KEY_SECRET_ENV} in Convex is too short to protect API keys: use a random value of at least ` +
           `${SECRET_MIN} characters (see docs/settings.md).`;
  }
  return null;
}

const text = new TextEncoder();
const VERSION = "v1";

const toB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** AES-256-GCM key from the secret. The secret is a random value (docs/settings.md), so SHA-256 with a fixed label
 * is enough to derive the key; nothing about it is stored. */
async function aesKey(secret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", text.encode(`studio/anthropic-key/${VERSION}\0${secret}`));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/**
 * "v1.<iv>.<ciphertext>" (base64). Bound to the project (`context`, the project id, as AES-GCM additional data), so a
 * copied value doesn't decrypt on another project. `random` is for tests.
 */
export async function encryptKey(key: string, secret: string, context: string,
                                 random: (b: Uint8Array) => void = (b) => { crypto.getRandomValues(b); }): Promise<string> {
  const iv = new Uint8Array(12);
  random(iv);
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: text.encode(context) },
                                             await aesKey(secret), text.encode(key));
  return `${VERSION}.${toB64(iv)}.${toB64(new Uint8Array(sealed))}`;
}

/** The key, or null when it can't be read (another secret, another project, a damaged value). Never throws. */
export async function decryptKey(stored: string, secret: string, context: string): Promise<string | null> {
  try {
    const [version, iv, sealed] = stored.split(".");
    if (version !== VERSION || !iv || !sealed) return null;
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(iv), additionalData: text.encode(context) },
                                              await aesKey(secret), fromB64(sealed));
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

type KeyRow = { anthropicKeyEnc?: string };

/**
 * What projectForWorker adds for the worker (only it: ENGINE_SECRET): `anthropicKey` when the project has one,
 * `anthropicKeyProblem` when it has one that can't be read (the worker then stops instead of quietly spending
 * Studio's key), nothing when it has none.
 */
export async function keyForWorker(p: KeyRow, projectId: string, secret = process.env[KEY_SECRET_ENV]):
    Promise<{ anthropicKey?: string; anthropicKeyProblem?: string }> {
  if (!p.anthropicKeyEnc) return {};
  const problem = keySecretProblem(secret);
  if (problem) return { anthropicKeyProblem: problem };
  const key = await decryptKey(p.anthropicKeyEnc, secret!, projectId);
  return key ? { anthropicKey: key }
             : { anthropicKeyProblem: `the stored key can't be decrypted (was ${KEY_SECRET_ENV} changed?). Paste the key again in Studio.` };
}
