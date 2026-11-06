import { anyApi, internalActionGeneric, internalMutationGeneric } from "convex/server";
import { v } from "convex/values";
import { notificationPath } from "./notifications";

/*
 * Slack notifications (docs/settings.md). The owner saves a Slack Incoming Webhook URL on /settings
 * (convex/settings.ts); from then on every notification Studio writes (convex/notifications.ts notifyFor) is also
 * posted to that channel as plain text: the title (it names the project), the body and a link to the Studio page.
 * One post per notification at most: the notification row is marked before posting, so a retried or repeated action
 * never posts it twice. Slack failures are recorded on the notification (`slack`), never thrown.
 */

export const SLACK_PREFIX = "https://hooks.slack.com/services/";

export type WebhookCheck = { ok: true; url: string } | { ok: false; message: string };

/** A Slack Incoming Webhook URL: https://hooks.slack.com/services/T…/B…/secret, nothing else. */
export function checkSlackWebhook(raw: unknown): WebhookCheck {
  const url = typeof raw === "string" ? raw.trim() : "";
  if (!url) return { ok: false, message: "Paste the webhook URL Slack gave you." };
  const bad = { ok: false as const,
                message: `That isn't a Slack Incoming Webhook URL. It should start with ${SLACK_PREFIX} (see docs/settings.md).` };
  if (url.length > 300 || !url.startsWith(SLACK_PREFIX)) return bad;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return bad;
  }
  const parts = u.pathname.split("/").slice(2); // "", "services", ...
  if (u.protocol !== "https:" || u.hostname !== "hooks.slack.com" || u.port || u.username || u.password || u.search || u.hash
      || parts.length !== 3 || !parts.every((p) => /^[A-Za-z0-9]+$/.test(p))) {
    return bad;
  }
  return { ok: true, url };
}

/** "…/abcd": all the screen ever shows of a saved webhook. */
export const maskWebhook = (url: string) => `…/${url.slice(-4)}`;

/** Slack reads &, < and > as markup in message text. */
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

type NoteLike = { kind: string; title: string; body: string };

/** The message: the title (with the project's name), the body, and where to open it in Studio. Plain text. */
export function slackText(n: NoteLike, projectName: string, projectId: string, appUrl: string | undefined): string {
  const title = n.title.includes(projectName) ? n.title : `${projectName}: ${n.title}`;
  const path = notificationPath(projectId, n.kind);
  const where = appUrl ? `Open in Studio: ${appUrl.replace(/\/$/, "")}${path}` : `In Studio: ${path}`;
  return [escape(title), escape(n.body), where].filter(Boolean).join("\n");
}

export type PostResult = { ok: true } | { ok: false; error: string };
type Fetch = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/** Posts one message. Never throws, and the error never contains the URL (it is the secret). */
export async function postToSlack(fetchFn: Fetch, url: string, text: string): Promise<PostResult> {
  try {
    const r = await fetchFn(url, { method: "POST", headers: { "Content-Type": "application/json" },
                                   body: JSON.stringify({ text }) });
    if (r.ok) return { ok: true };
    let reason = "";
    try {
      reason = (await r.text()).split(url).join("…").replace(/\s+/g, " ").trim().slice(0, 100);
    } catch {
      /* the status is enough */
    }
    return { ok: false, error: `Slack answered HTTP ${r.status}${reason ? ` (${reason})` : ""}` };
  } catch (e) {
    const name = e instanceof Error ? e.name : "error";
    return { ok: false, error: `Couldn't reach Slack (${name})` };
  }
}

/** The saved webhook, if any (the settings row). */
export async function savedWebhook(db: { query: (t: "settings") => { first: () => Promise<unknown> } }): Promise<string | null> {
  const row = (await db.query("settings").first()) as { slackWebhookUrl?: string } | null;
  return row?.slackWebhookUrl ?? null;
}

/**
 * Marks the notification as being posted and returns what to post, or null when it was already posted (or tried),
 * or Slack isn't set up any more. This mark is the "at most one post per notification" rule.
 */
export const claim = internalMutationGeneric({
  args: { id: v.id("notifications") },
  handler: async (ctx, { id }) => {
    const n = await ctx.db.get(id);
    if (!n || n.slack) return null;
    const webhook = await savedWebhook(ctx.db as never);
    if (!webhook) {
      await ctx.db.patch(id, { slack: { status: "skipped", at: Date.now() } });
      return null;
    }
    await ctx.db.patch(id, { slack: { status: "sending", at: Date.now() } });
    const p = await ctx.db.get(n.projectId);
    const name = (p as { name?: string } | null)?.name ?? "A project";
    return { webhook, text: slackText(n as unknown as NoteLike, name, String(n.projectId), process.env.APP_URL) };
  },
});

export const finish = internalMutationGeneric({
  args: { id: v.id("notifications"), ok: v.boolean(), error: v.optional(v.string()) },
  handler: async (ctx, { id, ok, error }) => {
    if (!(await ctx.db.get(id))) return;
    await ctx.db.patch(id, { slack: ok ? { status: "sent", at: Date.now() } : { status: "failed", at: Date.now(), error } });
  },
});

/** Posts one notification to Slack (scheduled by notifyFor). Never throws: failures are kept on the notification. */
export const post = internalActionGeneric({
  args: { id: v.id("notifications") },
  handler: async (ctx, { id }) => {
    let job: { webhook: string; text: string } | null = null;
    try {
      job = await ctx.runMutation(anyApi.slack.claim, { id });
    } catch {
      return; // the notification is gone, or the database is unavailable: nothing was posted
    }
    if (!job) return;
    const r = await postToSlack(fetch as unknown as Fetch, job.webhook, job.text);
    try {
      await ctx.runMutation(anyApi.slack.finish, { id, ok: r.ok, error: r.ok ? undefined : r.error });
    } catch {
      /* posted (or not); the record is best effort */
    }
  },
});
