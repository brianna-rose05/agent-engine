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
    status: v.string(), // draft (setup wizard) | queued | starting | planning | awaiting_approval | approved | rejected | building | done | failed
    plan: v.optional(v.any()),
    planNote: v.optional(v.string()),
    costUsd: v.number(),
    error: v.optional(v.string()),
    wizard: v.optional(v.any()), // setup wizard state, see convex/wizard.ts
    repo: v.optional(v.string()), // the project's GitHub repo, once the worker has made it
    resume: v.optional(v.boolean()), // the next worker run retries only what didn't merge
    previewUrl: v.optional(v.string()), // live Vercel preview of the finished app (worker.py publish_preview)
  }),
  events: defineTable({
    projectId: v.id("projects"),
    kind: v.string(),
    taskId: v.union(v.string(), v.null()),
    data: v.any(),
    ts: v.number(), // seconds since epoch, as the engine reports it
  }).index("by_project_ts", ["projectId", "ts"]),
});
