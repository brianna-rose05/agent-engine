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
    status: v.string(), // draft (setup wizard) | queued | starting | planning | awaiting_approval | approved | rejected | building | done | failed | stopped (spending limit)
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
    quicks: v.optional(v.array(v.any())), // quick changes, oldest first: {n, text, at, result?, reason?} (convex/quick.ts)
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
    kind: v.string(), // needs_approval | finished | budget_reached | preview_ready
    title: v.string(),
    body: v.string(),
    ts: v.number(),
    read: v.boolean(),
  }).index("by_ts", ["ts"]).index("by_read", ["read"]),
});
