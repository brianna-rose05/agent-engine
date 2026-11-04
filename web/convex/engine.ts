import { mutationGeneric, queryGeneric } from "convex/server";
import { ConvexError, v } from "convex/values";
import { composeSpec } from "./wizard";

/*
 * What the engine (worker.py in GitHub Actions) calls. Authenticated with ENGINE_SECRET, which both sides
 * derive from the Convex deploy key, so no extra secret has to be created by hand.
 */
function checkEngine(secret: string) {
  const expected = process.env.ENGINE_SECRET;
  if (!expected || secret !== expected) throw new ConvexError("not allowed");
}

export const projectForWorker = queryGeneric({
  args: { secret: v.string(), projectId: v.id("projects") },
  handler: async (ctx, { secret, projectId }) => {
    checkEngine(secret);
    const p = await ctx.db.get(projectId);
    if (!p) return null;
    let merged: string[] = [];
    let repo = p.repo ?? null;
    if (p.resume) {
      // what a retry can keep: every task whose latest status is merged
      const events = await ctx.db.query("events").withIndex("by_project_ts", (q) => q.eq("projectId", projectId)).collect();
      const last: Record<string, string> = {};
      for (const e of events) {
        if (e.kind === "task_status" && e.taskId) last[e.taskId] = e.data?.status;
        if (e.kind === "project_finished" && e.data?.repo) repo ??= e.data.repo;
      }
      merged = Object.keys(last).filter((k) => last[k] === "merged").sort();
    }
    return { resume: Boolean(p.resume), repo, merged, plan: p.resume ? p.plan ?? null : null, name: p.name, description: composeSpec(p.name, p.description, p.wizard), model: p.model, status: p.status, planNote: p.planNote ?? "" };
  },
});

const STATUS_AFTER: Record<string, string> = { task_queued: "planning", plan_ready: "awaiting_approval" };

/** One engine event: stored as-is (the app rebuilds every screen from these), plus the project summary. */
export const record = mutationGeneric({
  args: {
    secret: v.string(),
    projectId: v.id("projects"),
    kind: v.string(),
    taskId: v.union(v.string(), v.null()),
    data: v.any(),
    ts: v.number(),
  },
  handler: async (ctx, { secret, projectId, kind, taskId, data, ts }) => {
    checkEngine(secret);
    const p = await ctx.db.get(projectId);
    if (!p) throw new ConvexError("no such project");
    await ctx.db.insert("events", { projectId, kind, taskId, data, ts });
    const patch: Record<string, unknown> = {};
    if (kind === "task_queued" && taskId === "PLAN") patch.status = STATUS_AFTER.task_queued;
    if (kind === "plan_ready") {
      patch.status = STATUS_AFTER.plan_ready;
      patch.plan = data.plan;
    }
    if (kind === "plan_decision") patch.status = data.approved ? "building" : "rejected";
    if (kind === "attempt_finished") patch.costUsd = Math.round((p.costUsd + Number(data.cost_usd ?? 0)) * 10000) / 10000;
    if (kind === "project_finished") {
      patch.status = data.status;
      if (data.repo) patch.repo = data.repo;
    }
    if (kind === "build_resumed") {
      patch.status = "building";
      patch.resume = false;
    }
    if (Object.keys(patch).length) await ctx.db.patch(projectId, patch);
  },
});
