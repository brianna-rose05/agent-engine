import { internalActionGeneric, internalMutationGeneric, mutationGeneric, queryGeneric } from "convex/server";
import { ConvexError, v } from "convex/values";
import { anyApi } from "convex/server";

import { checkOwner } from "./owner";

const owner = { key: v.string() };

export const checkKey = queryGeneric({
  args: owner,
  handler: async (_ctx, { key }) => {
    try {
      checkOwner(key);
      return { ok: true as const };
    } catch (e) {
      return { ok: false as const, message: e instanceof ConvexError ? String(e.data) : "Something went wrong." };
    }
  },
});

export const list = queryGeneric({
  args: owner,
  handler: async (ctx, { key }) => {
    checkOwner(key);
    const rows = await ctx.db.query("projects").order("desc").take(50);
    return rows.map((p) => ({ id: p._id, name: p.name, status: p.status, costUsd: p.costUsd, createdAt: p._creationTime }));
  },
});

export const get = queryGeneric({
  args: { ...owner, id: v.string() },
  handler: async (ctx, { key, id }) => {
    checkOwner(key);
    const pid = ctx.db.normalizeId("projects", id);
    const p = pid && (await ctx.db.get(pid));
    if (!p) return null;
    const events = await ctx.db
      .query("events")
      .withIndex("by_project_ts", (q) => q.eq("projectId", p._id))
      .order("asc")
      .collect();
    return {
      project: { id: p._id, name: p.name, description: p.description, model: p.model, status: p.status,
                 createdAt: p._creationTime, error: p.error ?? null, wizard: p.wizard ?? null },
      events: events.map((e) => ({ kind: e.kind, task_id: e.taskId, data: e.data, ts: e.ts })),
    };
  },
});

export const create = mutationGeneric({
  args: { ...owner, name: v.string(), description: v.string(), model: v.union(v.literal("haiku"), v.literal("sonnet")),
          setup: v.optional(v.boolean()) },
  handler: async (ctx, { key, name, description, model, setup }) => {
    checkOwner(key);
    const n = name.trim();
    const d = description.trim();
    if (n.length < 1 || n.length > 120) throw new ConvexError("Give the project a name (up to 120 characters).");
    if (d.length < 20 || d.length > 20000) throw new ConvexError("Describe the project in at least a sentence or two.");
    if (setup) {
      // Setup wizard first (Questions -> Requirements -> Stack -> Design); the team starts when Design is locked.
      const id = await ctx.db.insert("projects", { name: n, description: d, model, status: "draft", costUsd: 0,
                                                    wizard: { step: "questions", busy: "questions" } });
      await ctx.scheduler.runAfter(0, anyApi.wizard.generateQuestions, { key, id });
      return id;
    }
    const id = await ctx.db.insert("projects", { name: n, description: d, model, status: "queued", costUsd: 0 });
    await ctx.scheduler.runAfter(0, anyApi.projects.startWorker, { projectId: id });
    return id;
  },
});

/** Build a stopped project again from the same approved setup: a fresh project (and repo), same wizard. */
export const rebuild = mutationGeneric({
  args: { ...owner, id: v.id("projects") },
  handler: async (ctx, { key, id }) => {
    checkOwner(key);
    const p = await ctx.db.get(id);
    if (!p || !["failed", "done", "rejected"].includes(p.status)) throw new ConvexError("Only a stopped project can be built again.");
    const copies = (await ctx.db.query("projects").collect()).filter((x) => x.name.startsWith(p.name.replace(/ \(\d+\)$/, ""))).length;
    const nid = await ctx.db.insert("projects", {
      name: `${p.name.replace(/ \(\d+\)$/, "")} (${copies + 1})`, description: p.description, model: p.model,
      status: "queued", costUsd: 0, ...(p.wizard ? { wizard: p.wizard } : {}),
    });
    await ctx.scheduler.runAfter(0, anyApi.projects.startWorker, { projectId: nid });
    return nid;
  },
});

export const decide = mutationGeneric({
  args: { ...owner, id: v.id("projects"), approved: v.boolean(), note: v.optional(v.string()) },
  handler: async (ctx, { key, id, approved, note }) => {
    checkOwner(key);
    const p = await ctx.db.get(id);
    if (!p || p.status !== "awaiting_approval") throw new ConvexError("This plan isn't waiting for a decision.");
    await ctx.db.patch(id, { status: approved ? "approved" : "rejected", planNote: (note ?? "").slice(0, 2000) });
  },
});

/** Starts the Worker workflow in GitHub Actions for a new project. */
export const startWorker = internalActionGeneric({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    const token = process.env.GITHUB_DISPATCH_TOKEN;
    const repo = process.env.ENGINE_REPO ?? "brianna-rose05/agent-engine";
    let error: string | null = null;
    if (!token) {
      error = "The worker can't be started: GITHUB_DISPATCH_TOKEN is missing in Convex.";
    } else {
      const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/worker.yml/dispatches`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json",
                   "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "studio-app" },
        body: JSON.stringify({ ref: "main", inputs: { project_id: projectId } }),
      });
      if (r.status !== 204) error = `GitHub didn't start the worker (HTTP ${r.status}).`;
    }
    await ctx.runMutation(anyApi.projects.markStarting, { projectId, error });
  },
});

export const markStarting = internalMutationGeneric({
  args: { projectId: v.id("projects"), error: v.union(v.string(), v.null()) },
  handler: async (ctx, { projectId, error }) => {
    const p = await ctx.db.get(projectId);
    if (!p || p.status !== "queued") return;
    await ctx.db.patch(projectId, error ? { status: "failed", error } : { status: "starting" });
  },
});
