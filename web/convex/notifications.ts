import { internalActionGeneric, mutationGeneric, queryGeneric, anyApi } from "convex/server";
import type { GenericDataModel, GenericMutationCtx } from "convex/server";
import type { GenericId } from "convex/values";
import { v } from "convex/values";
import { requireRole } from "./owner";

/*
 * Notifications for the owner: written by engine:record when something needs them or finished (see
 * notificationFor), shown by the bell in the sidebar (src/components/Notifications.tsx) and, while the tab is
 * hidden, as browser notifications. Optionally emailed through Resend when RESEND_API_KEY and NOTIFY_EMAIL are
 * set in Convex; without them, nothing is sent and nothing is logged. Also posted to Slack when the owner saved a
 * webhook on /settings (convex/slack.ts).
 */

export type NotificationKind = "needs_approval" | "needs_you" | "finished" | "budget_reached" | "preview_ready" | "ready_to_ship";
export type Note = { kind: NotificationKind; title: string; body: string; email: boolean };

const dollars = (x: unknown) => `$${Number(x ?? 0).toFixed(2)}`;

/** The notification an engine event deserves, if any. Pure: Convex record and the tests use the same rules. */
export function notificationFor(kind: string, data: Record<string, unknown> | null | undefined, project: string): Note | null {
  const d = data ?? {};
  switch (kind) {
    case "plan_ready":
      return { kind: "needs_approval", title: `${project}: the plan is ready`, email: true,
               body: "The planner finished. Nothing is built until you approve the plan." };
    case "change_plan_ready":
      return { kind: "needs_approval", title: `${project}: change ${d.n ?? ""} is planned`.replace(/ {2,}/g, " "), email: true,
               body: "Nothing changes until you approve it." };
    case "project_finished": {
      const status = String(d.status ?? "");
      if (status === "done") return { kind: "finished", title: `${project} is built`, email: true,
                                      body: "Every feature the team could finish is verified and merged." };
      // a run the worker refused to start says why (`reason`, e.g. the project's own API key can't be used)
      if (status === "failed" && typeof d.reason === "string" && d.reason) {
        return { kind: "finished", title: `${project} couldn't start`, email: true, body: d.reason.slice(0, 300) };
      }
      if (status === "failed") return { kind: "finished", title: `${project} stopped with problems`, email: true,
                                        body: "Some features didn't pass their checks. You can retry what failed." };
      if (status === "stopped") return { kind: "finished", title: `${project} stopped at its spending limit`, email: true,
                                         body: "Raise the limit on the plan page, then retry what's left." };
      return null; // rejected: the owner just sent it back themselves
    }
    case "budget_reached":
      return { kind: "budget_reached", title: `${project} reached its spending limit`, email: false,
               body: `${dollars(d.spent)} of ${dollars(d.budget)} spent. Running agents finish; nothing new starts.` };
    case "escalated": {
      // the tech lead couldn't get a failed feature through and has a question only the owner can answer
      const q = typeof d.question === "string" ? d.question.trim() : "";
      return { kind: "needs_you", title: `${project}: the tech lead needs you`, email: true,
               body: q ? (q.length > 300 ? `${q.slice(0, 297)}...` : q)
                       : "A feature failed and the tech lead has a question for you. Answer it on the board to retry." };
    }
    case "ready_to_ship": {
      // the PM's ship gate: every Must feature merged (and the app put together); Shoulds and Coulds never block it
      const saved = Array.isArray(d.saved) ? d.saved.length : 0;
      return { kind: "ready_to_ship", title: `${project}: ready to ship`, email: true,
               body: "Ready to ship: every Must feature passes." +
                     (saved ? ` ${saved} feature${saved === 1 ? " is" : "s are"} saved for the next version.` : "") +
                     " Ship it to production when you're ready." };
    }
    case "preview_ready":
      return typeof d.url === "string" && d.url.startsWith("https://")
        ? { kind: "preview_ready", title: `${project}: preview is live`, body: d.url, email: false }
        : null;
    default:
      return null;
  }
}

/** Where a notification takes the owner: the plan for approvals (and the limit), Ship when it's ready, else the board. */
export const notificationPath = (projectId: string, kind: string) =>
  `/p/${projectId}/${kind === "needs_approval" || kind === "budget_reached" ? "plan" : kind === "ready_to_ship" ? "ship" : "board"}`;

/** Whether email is set up (both settings present). Never exposes the key. */
export const emailEnabled = () => Boolean(process.env.RESEND_API_KEY && process.env.NOTIFY_EMAIL);

type StoredNote = { projectId: string; kind: string; title: string; body: string; read: boolean };

/** Whether an unread notification for the same project already says exactly this. */
export const isDuplicate = (unread: StoredNote[], projectId: string, n: Pick<Note, "kind" | "title" | "body">) =>
  unread.some((x) => !x.read && String(x.projectId) === projectId && x.kind === n.kind && x.title === n.title && x.body === n.body);

/** Called by engine:record for every event (except agent_activity). */
export async function notifyFor(ctx: GenericMutationCtx<GenericDataModel>, projectId: GenericId<"projects">, projectName: string, kind: string,
                                data: Record<string, unknown> | null | undefined) {
  const n = notificationFor(kind, data, projectName);
  if (!n) return;
  if (n.kind === "needs_you") {
    // the same question already waiting unread (e.g. a resent event) isn't worth a second alert or email
    const unread = await ctx.db.query("notifications").withIndex("by_read", (q) => q.eq("read", false)).take(200);
    if (isDuplicate(unread as unknown as StoredNote[], String(projectId), n)) return;
  }
  const id = await ctx.db.insert("notifications", { projectId, kind: n.kind, title: n.title, body: n.body, ts: Date.now(), read: false });
  // Slack (convex/slack.ts, docs/settings.md): every notification, once, when a webhook is saved on /settings
  const settings = (await ctx.db.query("settings").first()) as { slackWebhookUrl?: string } | null;
  if (settings?.slackWebhookUrl) await ctx.scheduler.runAfter(0, anyApi.slack.post, { id });
  if (n.email && emailEnabled()) {
    await ctx.scheduler.runAfter(0, anyApi.notifications.sendEmail,
                                 { title: n.title, body: n.body, path: notificationPath(projectId, n.kind) });
  }
}

const owner = { key: v.string() };

/** The latest notifications (newest first) and how many are unread. */
export const recent = queryGeneric({
  args: { ...owner, limit: v.optional(v.number()) },
  handler: async (ctx, { key, limit }) => {
    await requireRole(ctx, key, "viewer");
    const rows = await ctx.db.query("notifications").withIndex("by_ts").order("desc").take(Math.min(limit ?? 20, 50));
    const unread = (await ctx.db.query("notifications").withIndex("by_read", (q) => q.eq("read", false)).take(100)).length;
    return {
      unread,
      items: rows.map((n) => ({ id: n._id, projectId: n.projectId, kind: n.kind, title: n.title, body: n.body, ts: n.ts,
                                read: n.read, href: notificationPath(n.projectId, n.kind) })),
    };
  },
});

export const markRead = mutationGeneric({
  args: { ...owner, id: v.id("notifications") },
  handler: async (ctx, { key, id }) => {
    await requireRole(ctx, key, "viewer");
    const n = await ctx.db.get(id);
    if (n && !n.read) await ctx.db.patch(id, { read: true });
  },
});

export const markAllRead = mutationGeneric({
  args: owner,
  handler: async (ctx, { key }) => {
    await requireRole(ctx, key, "viewer");
    const rows = await ctx.db.query("notifications").withIndex("by_read", (q) => q.eq("read", false)).take(200);
    for (const n of rows) await ctx.db.patch(n._id, { read: true });
  },
});

/** The email Resend sends: plain text, with a link to the project when APP_URL is set. */
export function emailBody(title: string, body: string, path: string, appUrl: string | undefined) {
  const link = appUrl ? `\n\n${appUrl.replace(/\/$/, "")}${path}` : "";
  return { subject: title, text: `${body}${link}\n\n(Studio)` };
}

/** Sends one notification email through Resend's REST API. Skips silently when email isn't set up. */
export const sendEmail = internalActionGeneric({
  // `to` is for invites (convex/accounts.ts); notifications go to NOTIFY_EMAIL
  args: { title: v.string(), body: v.string(), path: v.string(), to: v.optional(v.string()) },
  handler: async (_ctx, { title, body, path, to: invitee }) => {
    const apiKey = process.env.RESEND_API_KEY;
    const to = invitee ?? process.env.NOTIFY_EMAIL;
    if (!apiKey || !to) return;
    const { subject, text } = emailBody(title, body, path, process.env.APP_URL);
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: process.env.NOTIFY_FROM ?? "Studio <onboarding@resend.dev>", to: [to], subject, text }),
    });
    // the status only: never the request (it carries the key) or the response body
    if (!r.ok) console.warn(`notification email not sent (HTTP ${r.status})`);
  },
});
