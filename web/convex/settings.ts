import { actionGeneric, anyApi, internalQueryGeneric, mutationGeneric, queryGeneric } from "convex/server";
import { ConvexError, v } from "convex/values";
import { requireRole, requireRoleInAction } from "./owner";
import { emailEnabled } from "./notifications";
import { checkSlackWebhook, maskWebhook, postToSlack } from "./slack";
import { KEY_SECRET_ENV, keySecretProblem } from "./apiKey";

/*
 * Studio settings (the /settings page, docs/settings.md): the Slack Incoming Webhook notifications are posted to.
 * Owner-checked. The webhook URL is a secret (anyone with it can post to the channel): once saved it never goes back
 * to the app, which only sees "…/abcd".
 */

const owner = { key: v.string() };

/** What /settings shows: whether Slack and email are set up, never the webhook itself. */
export const get = queryGeneric({
  args: owner,
  handler: async (ctx, { key }) => {
    await requireRole(ctx, key, "owner");
    const row = (await ctx.db.query("settings").first()) as { slackWebhookUrl?: string } | null;
    const url = row?.slackWebhookUrl;
    return { slack: url ? { masked: maskWebhook(url) } : null, email: emailEnabled(),
             // project API keys (convex/projectKeys.ts) need STUDIO_KEY_SECRET: say so here too
             keySecretProblem: keySecretProblem(process.env[KEY_SECRET_ENV]) };
  },
});

export const setSlackWebhook = mutationGeneric({
  args: { ...owner, url: v.string() },
  handler: async (ctx, { key, url }) => {
    await requireRole(ctx, key, "owner");
    const checked = checkSlackWebhook(url);
    if (!checked.ok) throw new ConvexError(checked.message);
    const row = await ctx.db.query("settings").first();
    if (row) await ctx.db.patch(row._id, { slackWebhookUrl: checked.url, updatedAt: Date.now() });
    else await ctx.db.insert("settings", { slackWebhookUrl: checked.url, updatedAt: Date.now() });
    return { masked: maskWebhook(checked.url) };
  },
});

export const removeSlackWebhook = mutationGeneric({
  args: owner,
  handler: async (ctx, { key }) => {
    await requireRole(ctx, key, "owner");
    const row = await ctx.db.query("settings").first();
    if (row) await ctx.db.patch(row._id, { slackWebhookUrl: undefined, updatedAt: Date.now() });
  },
});

export const webhook = internalQueryGeneric({
  args: {},
  handler: async (ctx) => {
    const row = (await ctx.db.query("settings").first()) as { slackWebhookUrl?: string } | null;
    return row?.slackWebhookUrl ?? null;
  },
});

export const TEST_MESSAGE = "Studio test message: Slack notifications are working. You'll get a message here when a " +
                            "plan needs your approval, a build finishes, or a project is ready to ship.";

/** "Send a test message": posts to the saved webhook and says how it went. Never throws for Slack's answer. */
export const testSlack = actionGeneric({
  args: owner,
  handler: async (ctx, { key }): Promise<{ ok: boolean; message: string }> => {
    await requireRoleInAction(ctx as never, key, "owner");
    const url = (await ctx.runQuery(anyApi.settings.webhook, {})) as string | null;
    if (!url) return { ok: false, message: "Save a webhook URL first." };
    const r = await postToSlack(fetch, url, TEST_MESSAGE);
    return r.ok ? { ok: true, message: "Sent. Check the Slack channel." } : { ok: false, message: `Not sent: ${r.error}.` };
  },
});
