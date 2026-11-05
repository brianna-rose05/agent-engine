import { mutationGeneric, queryGeneric } from "convex/server";
import { ConvexError, v } from "convex/values";
import { composeSpec } from "./wizard";
import type { ChangeRequest } from "./changes";
import { budgetOf } from "./budget";
import { notifyFor } from "./notifications";

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
    const change = p.mode === "change";
    let merged: string[] = [];
    let repo = p.repo ?? null;
    if (p.resume || change) {
      // what a retry or a change keeps: every task whose latest status is merged
      const events = await ctx.db.query("events").withIndex("by_project_ts", (q) => q.eq("projectId", projectId)).collect();
      const last: Record<string, string> = {};
      for (const e of events) {
        if (e.kind === "task_status" && e.taskId) last[e.taskId] = e.data?.status;
        if (e.kind === "project_finished" && e.data?.repo) repo ??= e.data.repo;
      }
      merged = Object.keys(last).filter((k) => last[k] === "merged").sort();
    }
    const latest = change ? ((p.changes ?? []) as ChangeRequest[]).at(-1) : undefined;
    return { resume: Boolean(p.resume), mode: change ? "change" : p.resume ? "resume" : "build",
             change: latest ? { n: latest.n, text: latest.text } : null,
             repo, merged, plan: p.resume || change ? p.plan ?? null : null, name: p.name,
             description: composeSpec(p.name, p.description, p.wizard), model: p.model, status: p.status, planNote: p.planNote ?? "",
             budgetUsd: budgetOf(p), costUsd: p.costUsd };
  },
});

const STATUS_AFTER: Record<string, string> = { task_queued: "planning", plan_ready: "awaiting_approval" };

/**
 * One engine event: stored as-is (the app rebuilds every screen from these), plus the project summary.
 * agent_activity events (what a running agent is doing, about one every 10 s per agent) are stored like any
 * other but return before the project row is touched.
 */
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
    if (kind === "agent_activity") return; // frequent and informational: never touches the project row
    await notifyFor(ctx, projectId, p.name, kind, data); // approvals, finished builds, the spending limit, previews
    const patch: Record<string, unknown> = {};
    if (kind === "task_queued" && taskId === "PLAN") patch.status = STATUS_AFTER.task_queued;
    if (kind === "plan_ready") {
      patch.status = STATUS_AFTER.plan_ready;
      patch.plan = data.plan;
    }
    if (kind === "change_started") patch.status = "planning";
    if (kind === "change_plan_ready") {
      patch.status = "awaiting_approval";
      patch.pendingChange = data.change;
    }
    if (kind === "plan_decision") patch.status = data.approved ? "building" : "rejected";
    if (kind === "attempt_finished") patch.costUsd = Math.round((p.costUsd + Number(data.cost_usd ?? 0)) * 10000) / 10000;
    if (kind === "project_finished") {
      // A change that was sent back built nothing: the project goes back to how it was (done, or failed), so the
      // owner can ask for a different change. Matches the app reducer.
      patch.status = data.status === "rejected" && p.mode === "change" && p.changeFrom ? p.changeFrom : data.status;
      if (data.repo) patch.repo = data.repo;
    }
    if (kind === "preview_ready" && typeof data?.url === "string" && /^https:\/\//.test(data.url)) patch.previewUrl = data.url;
    if (kind === "build_resumed") {
      patch.status = "building";
      patch.resume = false;
    }
    if (Object.keys(patch).length) await ctx.db.patch(projectId, patch);
  },
});
