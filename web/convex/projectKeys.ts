import { actionGeneric, anyApi, internalMutationGeneric, mutationGeneric, queryGeneric } from "convex/server";
import { ConvexError, v } from "convex/values";
import { checkOwner } from "./owner";
import { KEY_SECRET_ENV, checkAnthropicKey, encryptKey, keySecretProblem } from "./apiKey";

/*
 * A project's own Anthropic API key (docs/settings.md). The owner pastes it on the plan page; it is stored encrypted
 * (convex/apiKey.ts) and only its last 4 characters ever come back to the app. The worker gets it decrypted through
 * engine:projectForWorker, which only the worker can call (ENGINE_SECRET).
 */

const owner = { key: v.string() };

/** Which key the project runs on, for the screen: never the key, only its last 4 characters. */
export const status = queryGeneric({
  args: { ...owner, id: v.string() },
  handler: async (ctx, { key, id }) => {
    checkOwner(key);
    const pid = ctx.db.normalizeId("projects", id);
    const p = pid && (await ctx.db.get(pid));
    if (!p) return null;
    const own = Boolean(p.anthropicKeyEnc);
    return { own, last4: own ? (p.anthropicKeyLast4 as string | undefined) ?? null : null,
             // why a key can't be saved right now (STUDIO_KEY_SECRET missing), so the screen can say so up front
             problem: keySecretProblem(process.env[KEY_SECRET_ENV]) };
  },
});

/** Saves the project's own key, encrypted. An action: the IV comes from real randomness, outside a mutation. */
export const set = actionGeneric({
  args: { ...owner, id: v.id("projects"), apiKey: v.string() },
  handler: async (ctx, { key, id, apiKey }) => {
    checkOwner(key);
    const checked = checkAnthropicKey(apiKey);
    if (!checked.ok) throw new ConvexError(checked.message);
    const secret = process.env[KEY_SECRET_ENV];
    const problem = keySecretProblem(secret);
    if (problem) throw new ConvexError(problem);
    const enc = await encryptKey(checked.key, secret!, id);
    await ctx.runMutation(anyApi.projectKeys.store, { id, enc, last4: checked.key.slice(-4) });
    return { last4: checked.key.slice(-4) };
  },
});

export const store = internalMutationGeneric({
  args: { id: v.id("projects"), enc: v.string(), last4: v.string() },
  handler: async (ctx, { id, enc, last4 }) => {
    if (!(await ctx.db.get(id))) throw new ConvexError("This project doesn't exist any more.");
    await ctx.db.patch(id, { anthropicKeyEnc: enc, anthropicKeyLast4: last4 });
  },
});

/** Back to Studio's key from the next run on. */
export const remove = mutationGeneric({
  args: { ...owner, id: v.id("projects") },
  handler: async (ctx, { key, id }) => {
    checkOwner(key);
    if (!(await ctx.db.get(id))) throw new ConvexError("This project doesn't exist any more.");
    await ctx.db.patch(id, { anthropicKeyEnc: undefined, anthropicKeyLast4: undefined });
  },
});
