import { ConvexError } from "convex/values";

/**
 * Every app call carries the owner passphrase until real sign-in exists: starting work spends money, so
 * nobody else who finds the URL can do that or read projects. Set as OWNER_PASSPHRASE in Convex.
 */
export function checkOwner(key: string) {
  const expected = process.env.OWNER_PASSPHRASE;
  if (!expected) throw new ConvexError("The app isn't set up yet: OWNER_PASSPHRASE is missing in Convex.");
  if (key !== expected) throw new ConvexError("Wrong passphrase.");
}
