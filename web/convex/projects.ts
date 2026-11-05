import {
  internalActionGeneric, internalMutationGeneric, mutationGeneric, queryGeneric, type AnyDataModel, type GenericMutationCtx,
} from "convex/server";
import { ConvexError, v, type GenericId } from "convex/values";
import { anyApi } from "convex/server";

import { checkOwner } from "./owner";
import { canRequestChange, checkChangeText, nextChangeNumber, type ChangeRequest } from "./changes";
import { budgetOf, canSpendMore, checkBudget } from "./budget";
import { canShip } from "./ship";
import { BUILD_SAVED_PATCH, buildSavedBlocker, decisionDeferred } from "./pm";
import { missingSetupCodes, newSetupCodes, setupCodesForWorker } from "./setup";
import { RETRY_PATCH, checkAnswer, failedTasks, retryBlocker, withAnswer, type Answers } from "./answers";

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
                 canRetry: (p.status === "failed" || p.status === "stopped") && Boolean(p.plan),
                 budgetUsd: budgetOf(p), costUsd: p.costUsd,
                 canChange: Boolean(p.repo) && canRequestChange(p.status, Boolean(p.plan), false),
                 changes: ((p.changes ?? []) as ChangeRequest[]).map((c) => ({ n: c.n, text: c.text, at: c.at })),
                 createdAt: p._creationTime, error: p.error ?? null, wizard: p.wizard ?? null, previewUrl: p.previewUrl ?? null,
                 durableDb: Boolean(p.durableDb),
                 // ship to production (convex/ship.ts): the screen reduces the events, the row says what's queued
                 canShip: canShip(p.status, false, Boolean(p.repo)), shipping: p.mode === "ship" && ["queued", "starting", "shipping"].includes(p.status),
                 production: p.production ?? null,
                 answers: p.answers ?? {}, // your answers to the tech lead, {taskId: text} (convex/answers.ts)
                 // features saved for the next version at approval (convex/pm.ts), and whether they can be built now
                 deferred: p.deferred ?? [], canBuildSaved: buildSavedBlocker(p) === null,
                 // owner setup codes for the app's /owner-setup page (convex/setup.ts): owner-only, like this whole query
                 setupCodes: setupCodesForWorker(p.setupCodes) },
      events: events.map((e) => ({ kind: e.kind, task_id: e.taskId, data: e.data, ts: e.ts })),
    };
  },
});

export const create = mutationGeneric({
  args: { ...owner, name: v.string(), description: v.string(), model: v.union(v.literal("haiku"), v.literal("sonnet")),
          setup: v.optional(v.boolean()), budgetUsd: v.optional(v.number()) },
  handler: async (ctx, { key, name, description, model, setup, budgetUsd }) => {
    checkOwner(key);
    const budget = checkBudget(budgetUsd ?? budgetOf({}));
    if (!budget.ok) throw new ConvexError(budget.message);
    const n = name.trim();
    const d = description.trim();
    if (n.length < 1 || n.length > 120) throw new ConvexError("Give the project a name (up to 120 characters).");
    if (d.length < 20 || d.length > 20000) throw new ConvexError("Describe the project in at least a sentence or two.");
    if (setup) {
      // Setup wizard first (Questions -> Requirements -> Stack -> Design); the team starts when Design is locked.
      const id = await ctx.db.insert("projects", { name: n, description: d, model, status: "draft", costUsd: 0,
                                                    budgetUsd: budget.usd, setupCodes: newSetupCodes(), wizard: { step: "questions", busy: "questions" } });
      await ctx.scheduler.runAfter(0, anyApi.wizard.generateQuestions, { key, id });
      return id;
    }
    const id = await ctx.db.insert("projects", { name: n, description: d, model, status: "queued", costUsd: 0, budgetUsd: budget.usd,
                                         setupCodes: newSetupCodes() });
    await ctx.scheduler.runAfter(0, anyApi.projects.startWorker, { projectId: id });
    return id;
  },
});

/**
 * Give a project the owner setup codes it's missing (convex/setup.ts). New projects get both when they're created;
 * projects made before codes existed get them here, called by the project page when it opens for the owner, so the
 * next worker run (and its deploys) already has them. Codes that exist are never changed. Returns nothing: the
 * codes reach the screen through projects.get.
 */
export const ensureSetupCodes = mutationGeneric({
  args: { ...owner, id: v.string() },
  handler: async (ctx, { key, id }) => {
    checkOwner(key);
    const pid = ctx.db.normalizeId("projects", id);
    const p = pid && (await ctx.db.get(pid));
    if (!pid || !p) return;
    const codes = missingSetupCodes(p.setupCodes);
    if (codes) await ctx.db.patch(pid, { setupCodes: codes });
  },
});

/** Retry only what didn't finish, in the same repo: merged features stay, no new plan or approval. */
export const retryFailed = mutationGeneric({
  args: { ...owner, id: v.id("projects") },
  handler: async (ctx, { key, id }) => {
    checkOwner(key);
    const p = await ctx.db.get(id);
    const blocker = retryBlocker(p);
    if (blocker) throw new ConvexError(blocker);
    await ctx.db.patch(id, RETRY_PATCH);
    await ctx.scheduler.runAfter(0, anyApi.projects.startWorker, { projectId: id });
  },
});

/**
 * Answer the tech lead's question on a failed feature, then retry what failed exactly like retryFailed. The answer
 * is kept on the row (`answers`, convex/answers.ts; a later one for the same task replaces it), and the retry's dev
 * agent gets it as feedback on its first try (worker.py resume).
 */
export const answerAndRetry = mutationGeneric({
  args: { ...owner, id: v.id("projects"), taskId: v.string(), text: v.string() },
  handler: async (ctx, { key, id, taskId, text }) => {
    checkOwner(key);
    const p = await ctx.db.get(id);
    const blocker = retryBlocker(p);
    if (blocker || !p) throw new ConvexError(blocker ?? "This project doesn't exist any more.");
    const events = await ctx.db.query("events").withIndex("by_project_ts", (q) => q.eq("projectId", id)).collect();
    const checked = checkAnswer(taskId, text, failedTasks(events));
    if (!checked.ok) throw new ConvexError(checked.message);
    await ctx.db.patch(id, { ...RETRY_PATCH, answers: withAnswer(p.answers as Answers | undefined, taskId, checked.text) });
    await ctx.scheduler.runAfter(0, anyApi.projects.startWorker, { projectId: id });
  },
});

/**
 * Start a change request on a project row: every rule a change request has (a plan, nothing running, a repo, the
 * text, the spending limit), then the row patch and the worker. Shared by requestChange and comment pins sent as a
 * change request (convex/comments.ts), so both follow exactly the same rules. Returns the change's number.
 */
export async function startChangeRequest(ctx: GenericMutationCtx<AnyDataModel>, id: GenericId<"projects">, text: string): Promise<number> {
  const p = await ctx.db.get(id);
  if (!p) throw new ConvexError("This project doesn't exist any more.");
  if (!canRequestChange(p.status, Boolean(p.plan), false)) {
    throw new ConvexError(p.status === "failed"
      ? "This build stopped before it had a plan, so there's nothing to change yet. Build it again instead."
      : "The team is still working on this project. Ask for a change once it has finished.");
  }
  if (!p.repo) throw new ConvexError("This project has no repo yet, so there's nothing to change. Build it again instead.");
  const checked = checkChangeText(text);
  if (!checked.ok) throw new ConvexError(checked.message);
  if (!canSpendMore(p.costUsd, budgetOf(p))) {
    throw new ConvexError("This project has spent its limit. Raise the spending limit on the plan page first.");
  }
  const changes = (p.changes ?? []) as ChangeRequest[];
  const entry: ChangeRequest = { n: nextChangeNumber(changes), text: checked.text, at: Date.now() };
  await ctx.db.patch(id, { status: "queued", mode: "change", resume: false, error: undefined, changeFrom: p.status,
                           pendingChange: undefined, planNote: undefined, changes: [...changes, entry] });
  await ctx.scheduler.runAfter(0, anyApi.projects.startWorker, { projectId: id });
  return entry.n;
}

/** Ask the team for a change to a built project, in the same repo (docs/change-requests.md). */
export const requestChange = mutationGeneric({
  args: { ...owner, id: v.id("projects"), text: v.string() },
  handler: async (ctx, { key, id, text }) => {
    checkOwner(key);
    return startChangeRequest(ctx, id, text);
  },
});

/** Build a stopped project again from the same approved setup: a fresh project (and repo), same wizard. */
export const rebuild = mutationGeneric({
  args: { ...owner, id: v.id("projects") },
  handler: async (ctx, { key, id }) => {
    checkOwner(key);
    const p = await ctx.db.get(id);
    if (!p || !["failed", "done", "rejected", "stopped"].includes(p.status)) throw new ConvexError("Only a stopped project can be built again.");
    const copies = (await ctx.db.query("projects").collect()).filter((x) => x.name.startsWith(p.name.replace(/ \(\d+\)$/, ""))).length;
    const nid = await ctx.db.insert("projects", {
      name: `${p.name.replace(/ \(\d+\)$/, "")} (${copies + 1})`, description: p.description, model: p.model,
      status: "queued", costUsd: 0, budgetUsd: budgetOf(p), setupCodes: newSetupCodes(), ...(p.wizard ? { wizard: p.wizard } : {}),
    });
    await ctx.scheduler.runAfter(0, anyApi.projects.startWorker, { projectId: nid });
    return nid;
  },
});

/**
 * Change a project's spending limit (plan page). A run waiting for approval uses the limit as it stands when you
 * decide (worker.py with_fresh_budget); a build already running keeps its limit; the next run (retry, change) reads it.
 */
export const setBudget = mutationGeneric({
  args: { ...owner, id: v.id("projects"), budgetUsd: v.number() },
  handler: async (ctx, { key, id, budgetUsd }) => {
    checkOwner(key);
    const p = await ctx.db.get(id);
    if (!p) throw new ConvexError("This project doesn't exist any more.");
    const checked = checkBudget(budgetUsd);
    if (!checked.ok) throw new ConvexError(checked.message);
    await ctx.db.patch(id, { budgetUsd: checked.usd });
    return checked.usd;
  },
});

/**
 * Approve or send back the plan (or a planned change). Approving the first plan may save features for the next
 * version (`deferred`, the PM's suggestion on the plan page): checked by convex/pm.ts checkDeferred, stored on the
 * row, read by the worker after approval. Approving without it builds everything (and clears any earlier list).
 */
export const decide = mutationGeneric({
  args: { ...owner, id: v.id("projects"), approved: v.boolean(), note: v.optional(v.string()),
          deferred: v.optional(v.array(v.string())) },
  handler: async (ctx, { key, id, approved, note, deferred }) => {
    checkOwner(key);
    const p = await ctx.db.get(id);
    // the first plan and a planned change (pendingChange) wait for the same decision
    if (!p || p.status !== "awaiting_approval") {
      throw new ConvexError(p?.mode === "change" ? "This change isn't waiting for a decision." : "This plan isn't waiting for a decision.");
    }
    const patch: Record<string, unknown> = { status: approved ? "approved" : "rejected", planNote: (note ?? "").slice(0, 2000) };
    const checked = decisionDeferred(approved, p.mode === "change", p.plan, deferred);
    if (!checked.ok) throw new ConvexError(checked.message);
    if (checked.ids) patch.deferred = checked.ids.length ? checked.ids : undefined;
    await ctx.db.patch(id, patch);
  },
});

/**
 * Build the features saved for later at approval: clears `deferred` and runs a resume in the same repo (merged
 * features stay; the worker builds the saved ones and puts the app together again). Allowed once the team has
 * finished (done, failed or stopped) and the limit has room.
 */
export const buildSaved = mutationGeneric({
  args: { ...owner, id: v.id("projects") },
  handler: async (ctx, { key, id }) => {
    checkOwner(key);
    const p = await ctx.db.get(id);
    const blocker = buildSavedBlocker(p);
    if (blocker) throw new ConvexError(blocker);
    await ctx.db.patch(id, BUILD_SAVED_PATCH);
    await ctx.scheduler.runAfter(0, anyApi.projects.startWorker, { projectId: id });
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
