import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * The app's backend. The engine streams every step as an event; the app rebuilds the plan, board and
 * channels from those events (web/src/lib/reduce.ts), so a project is just its row plus its event log.
 */
export default defineSchema({
  projects: defineTable({
    name: v.string(),
    description: v.string(),
    model: v.union(v.literal("haiku"), v.literal("sonnet")),
    status: v.string(), // draft (setup wizard) | queued | starting | planning | awaiting_approval | approved | rejected | building | shipping | done | failed | stopped (spending limit)
    plan: v.optional(v.any()),
    planNote: v.optional(v.string()),
    costUsd: v.number(),
    error: v.optional(v.string()),
    wizard: v.optional(v.any()), // setup wizard state, see convex/wizard.ts
    repo: v.optional(v.string()), // the project's GitHub repo, once the worker has made it
    resume: v.optional(v.boolean()), // the next worker run retries only what didn't merge
    previewUrl: v.optional(v.string()), // live Vercel preview of the finished app (worker.py publish_preview)
    durableDb: v.optional(v.boolean()), // the preview has its own Postgres (database_ready, docs/databases.md)
    mode: v.optional(v.string()), // the next/current worker run: "change" (docs/change-requests.md), else a build or retry
    changes: v.optional(v.array(v.any())), // change requests, oldest first: {n, text, at} (convex/changes.ts)
    pendingChange: v.optional(v.any()), // the latest planned change (changes/{n}.json) from change_plan_ready
    changeFrom: v.optional(v.string()), // status before the running change, restored if the change is sent back
    budgetUsd: v.optional(v.number()), // spending limit in $, enforced by the engine (convex/budget.ts, engine/budget.py)
    checkpoints: v.optional(v.array(v.any())), // save points, oldest first: {n, tag, sha, label, at, merged} (convex/checkpoints.ts)
    rollback: v.optional(v.any()), // the running/last rollback: {n, from} (from = status before it, restored if it fails)
    comments: v.optional(v.array(v.any())), // comment pins on the preview, oldest first: {n, path, pathKnown, x, y, viewport, text, at, status, sentAs?} (convex/comments.ts)
    commentSeq: v.optional(v.number()), // the highest pin number given so far, so a deleted pin's number isn't reused
    quicks: v.optional(v.array(v.any())), // quick changes, oldest first: {n, text, at, result?, reason?} (convex/quick.ts)
    // Ship to production (convex/ship.ts). status is "shipping" while a ship runs, then back to ship.from.
    ship: v.optional(v.any()), // the running/last ship: {from, rollbackTo: n|null, state?, checks?: [{name, label, status, detail?}], reason?}
    versions: v.optional(v.array(v.any())), // shipped versions, oldest first: {n, tag, sha, url, at, label?}
    production: v.optional(v.any()), // what production runs now: {url, version, at}
    answers: v.optional(v.record(v.string(), v.string())), // owner answers to the tech lead: {taskId: text} (convex/answers.ts)
    deferred: v.optional(v.array(v.string())), // plan task ids saved for the next version at approval (convex/pm.ts)
    // one-time codes the app's owner enters on <app>/owner-setup to claim the admin role (convex/setup.ts). Set as
    // APP_SETUP_CODE on each deploy by the worker; shown only to the owner through projects.get, never in events.
    setupCodes: v.optional(v.object({ preview: v.optional(v.string()), production: v.optional(v.string()) })),
    // the project's own Anthropic API key (docs/settings.md, convex/projectKeys.ts): AES-GCM ciphertext under
    // STUDIO_KEY_SECRET, decrypted only for the worker (projectForWorker); the screen gets the last 4 characters only
    anthropicKeyEnc: v.optional(v.string()),
    anthropicKeyLast4: v.optional(v.string()),
    // the account that created the project (docs/accounts.md): {id, name}; absent when the owner passphrase did
    createdBy: v.optional(v.object({ id: v.string(), name: v.string() })),
  }),
  events: defineTable({
    projectId: v.id("projects"),
    kind: v.string(),
    taskId: v.union(v.string(), v.null()),
    data: v.any(),
    ts: v.number(), // seconds since epoch, as the engine reports it
  }).index("by_project_ts", ["projectId", "ts"]),
  // written by engine:record (convex/notifications.ts); ts in milliseconds since epoch
  notifications: defineTable({
    projectId: v.id("projects"),
    kind: v.string(), // needs_approval | needs_you | finished | budget_reached | preview_ready | ready_to_ship
    title: v.string(),
    body: v.string(),
    ts: v.number(),
    read: v.boolean(),
    // the Slack post for this notification (convex/slack.ts): {status: sending | sent | failed | skipped, at, error?}.
    // Set once, before posting, so a notification is posted at most once.
    slack: v.optional(v.any()),
  }).index("by_ts", ["ts"]).index("by_read", ["read"]),
  // Studio-wide settings, one row (convex/settings.ts): the Slack Incoming Webhook URL, never sent back to the app
  settings: defineTable({
    slackWebhookUrl: v.optional(v.string()),
    updatedAt: v.number(),
  }),
  // Studio accounts (convex/accounts.ts, docs/accounts.md). No open sign-up: people join through an invite.
  // passwordHash and tokenHash never leave the backend; the browser gets a token once and the db keeps its SHA-256.
  users: defineTable({
    email: v.string(), // lowercased, unique
    name: v.string(),
    passwordHash: v.string(), // PBKDF2-SHA256 (convex/credentials.ts)
    role: v.union(v.literal("owner"), v.literal("editor"), v.literal("viewer")),
    createdAt: v.number(),
  }).index("by_email", ["email"]),
  sessions: defineTable({
    userId: v.id("users"),
    tokenHash: v.string(),
    expiresAt: v.number(),
    createdAt: v.number(),
  }).index("by_token", ["tokenHash"]).index("by_user", ["userId"]),
  invites: defineTable({
    email: v.string(),
    role: v.union(v.literal("owner"), v.literal("editor"), v.literal("viewer")),
    tokenHash: v.string(),
    expiresAt: v.number(),
    createdBy: v.optional(v.string()), // the inviting account's name; absent when the owner passphrase invited
    usedAt: v.optional(v.number()),
  }).index("by_token", ["tokenHash"]).index("by_email", ["email"]),
  // failed sign-ins per email, for the rate limit (convex/credentials.ts signInBlockedFor)
  signInAttempts: defineTable({
    email: v.string(),
    failures: v.number(),
    windowStart: v.number(),
  }).index("by_email", ["email"]),
});
