/*
 * Owner setup codes. Every generated app has an owner (its admin), who claims that role in the app itself: they open
 * <app url>/owner-setup, sign up, and enter a one-time setup code (template src/lib/owner.ts). The preview and
 * production each have their own code. The codes live on the project row (`setupCodes`), go to the worker through
 * projectForWorker (it sets them as APP_SETUP_CODE on each deploy), and reach the screen only through the
 * owner-checked projects.get. Never put them in events.
 */

/** No 0/O, 1/I/L: easy to read aloud and type from a screen. */
export const SETUP_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const SETUP_CODE_RE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/;

export type SetupCodes = { preview?: string; production?: string };

/** Fills `out` with random bytes. Defaults to crypto.getRandomValues (available in the Convex runtime). */
export type RandomBytes = (out: Uint8Array) => Uint8Array;
const cryptoBytes: RandomBytes = (out) => crypto.getRandomValues(out);

/** A code like "K7PQ-M2XR-9TVD": 12 characters from SETUP_ALPHABET, crypto-random and uniform (rejection sampling). */
export function makeSetupCode(random: RandomBytes = cryptoBytes): string {
  const n = SETUP_ALPHABET.length;
  const limit = 256 - (256 % n); // bytes at or above this would favour the first letters
  const chars: string[] = [];
  while (chars.length < 12) {
    for (const b of random(new Uint8Array(16))) {
      if (b < limit && chars.length < 12) chars.push(SETUP_ALPHABET[b % n]);
    }
  }
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8, 12)].map((g) => g.join("")).join("-");
}

export function isSetupCode(x: unknown): x is string {
  return typeof x === "string" && SETUP_CODE_RE.test(x);
}

/**
 * The codes a project should have: the ones it has (kept as they are, so a code the owner already wrote down keeps
 * working) plus a new one for each that's missing or malformed. Returns null when nothing is missing.
 */
export function missingSetupCodes(existing: SetupCodes | undefined | null, random?: RandomBytes): Required<SetupCodes> | null {
  const preview = isSetupCode(existing?.preview) ? existing.preview : null;
  const production = isSetupCode(existing?.production) ? existing.production : null;
  if (preview && production) return null;
  const p = preview ?? makeSetupCode(random);
  let q = production ?? makeSetupCode(random);
  while (q === p) q = makeSetupCode(random); // never the same code for both
  return { preview: p, production: q };
}

/** Both codes for a new project. */
export function newSetupCodes(random?: RandomBytes): Required<SetupCodes> {
  return missingSetupCodes(null, random)!;
}

/** What the worker gets: only well-formed codes, so a bad value never reaches a deploy. */
export function setupCodesForWorker(existing: SetupCodes | undefined | null): SetupCodes {
  return {
    ...(isSetupCode(existing?.preview) ? { preview: existing.preview } : {}),
    ...(isSetupCode(existing?.production) ? { production: existing.production } : {}),
  };
}

/** The address to open, from an app URL: "https://x.vercel.app/" -> "https://x.vercel.app/owner-setup". */
export function ownerSetupUrl(appUrl: string): string {
  return `${appUrl.replace(/\/+$/, "")}/owner-setup`;
}
