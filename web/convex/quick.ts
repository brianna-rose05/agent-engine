import { mutationGeneric, queryGeneric, type AnyDataModel, type GenericMutationCtx } from "convex/server";
import { anyApi } from "convex/server";
import { ConvexError, v, type GenericId } from "convex/values";

import { actorOf, requireRole, type Actor } from "./owner";

/*
 * Quick changes (engine/quick.py): small edits to what people see in a built app (wording, colors, spacing, labels,
 * a missing link). One agent edits only the pages and components, the whole app is checked (types, lint, every test,
 * a production build, every page answers), and it merges without an approval. If the agent finds it needs new data
 * or a feature, it stops (quick_blocked) and the app offers to send the same words as a change request instead.
 *
 * The rules below are pure functions, so the app and the tests can import them without a Convex backend.
 */

export const QUICK_TEXT_MIN = 5;
export const QUICK_TEXT_MAX = 1000;

/** One quick change on the project row. `at` is milliseconds since epoch; `result` is set when its run ends. */
export type QuickChange = {
  by?: { id: string; name: string }; // the account that asked (docs/accounts.md); absent for the owner passphrase
  n: number;
  text: string;
  at: number;
  result?: "done" | "failed" | "blocked";
  reason?: string; // why it needs a change request (quick_blocked)
};

/** A quick change needs a built app (done, with a repo) and nothing running. */
export function canRequestQuickChange(status: string, hasRepo: boolean, running: boolean): boolean {
  return hasRepo && !running && status === "done";
}

/** The request text, trimmed, or the message to show the owner when it can't be used. */
export function checkQuickText(text: string): { ok: true; text: string } | { ok: false; message: string } {
  const t = text.trim();
  if (t.length < QUICK_TEXT_MIN) return { ok: false, message: "Say what to change, for example \"Make the Book button green\"." };
  if (t.length > QUICK_TEXT_MAX) {
    return { ok: false, message: `Keep a quick change under ${QUICK_TEXT_MAX} characters. Bigger ones work better as a change request.` };
  }
  return { ok: true, text: t };
}

/** The next quick change number: 1, 2, ... */
export const nextQuickNumber = (quicks: QuickChange[] | undefined) => (quicks ?? []).reduce((m, q) => Math.max(m, q.n), 0) + 1;

type Row = { mode?: string; quicks?: unknown[] };

/** What projectForWorker adds in quick mode: `quick: {n, text}` of the latest quick change, else null. */
export function quickForWorker(p: Row): { n: number; text: string } | null {
  if (p.mode !== "quick") return null;
  const latest = ((p.quicks ?? []) as QuickChange[]).at(-1);
  return latest ? { n: latest.n, text: latest.text } : null;
}

/**
 * The project-row patch for a quick change's engine events (engine:record applies it after its own). quick_started
 * means building; quick_blocked keeps the reason on the entry; the run's project_finished records the result and
 * puts the project back to done: a quick change only starts from a working app, and one that didn't merge left it
 * exactly as it was (the app reducer does the same).
 */
export function quickPatch(p: Row, kind: string, data: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const quicks = (p.quicks ?? []) as QuickChange[];
  const set = (n: number, next: Partial<QuickChange>) => quicks.map((q) => (q.n === n ? { ...q, ...next } : q));
  if (kind === "quick_started") return { status: "building" };
  if (kind === "quick_blocked") {
    return { quicks: set(Number(data?.n), { result: "blocked", reason: String(data?.reason ?? "it needs a change request") }) };
  }
  if (kind === "project_finished" && p.mode === "quick") {
    const latest = quicks.at(-1);
    const result = latest?.result === "blocked" || data?.status === "blocked" ? "blocked" : data?.status === "done" ? "done" : "failed";
    return { status: "done", ...(latest ? { quicks: set(latest.n, { result }) } : {}) };
  }
  return {};
}

const owner = { key: v.string() };

/** Whether a quick change can be asked for now, and the ones asked so far (oldest first). */
export const forProject = queryGeneric({
  args: { ...owner, id: v.string() },
  handler: async (ctx, { key, id }) => {
    await requireRole(ctx, key, "viewer");
    const pid = ctx.db.normalizeId("projects", id);
    const p = pid && (await ctx.db.get(pid));
    if (!p) return null;
    return { canQuick: canRequestQuickChange(p.status, Boolean(p.repo), false), quicks: (p.quicks ?? []) as QuickChange[] };
  },
});

/**
 * Start a quick change on a project row: every rule a quick change has (a repo, a finished app, the text), then the
 * row patch and the worker. Shared by requestQuickChange and comment pins sent as a quick change (convex/comments.ts),
 * so both follow exactly the same rules. Returns the quick change's number.
 */
export async function startQuickChange(ctx: GenericMutationCtx<AnyDataModel>, id: GenericId<"projects">, text: string,
                                       by?: Actor): Promise<number> {
  const p = await ctx.db.get(id);
  if (!p) throw new ConvexError("This project doesn't exist any more.");
  if (!p.repo) throw new ConvexError("This project has no repo yet, so there's nothing to change.");
  if (!canRequestQuickChange(p.status, true, false)) {
    throw new ConvexError(p.status === "failed"
      ? "Quick changes are for an app that's finished. Retry the build or ask for a change request instead."
      : "The team is still working on this project. Ask for a quick change once it has finished.");
  }
  const checked = checkQuickText(text);
  if (!checked.ok) throw new ConvexError(checked.message);
  const quicks = (p.quicks ?? []) as QuickChange[];
  const entry: QuickChange = { n: nextQuickNumber(quicks), text: checked.text, at: Date.now(), ...(by ? { by } : {}) };
  await ctx.db.patch(id, { status: "queued", mode: "quick", resume: false, error: undefined, quicks: [...quicks, entry] });
  await ctx.scheduler.runAfter(0, anyApi.projects.startWorker, { projectId: id });
  return entry.n;
}

/** Ask for a quick change to a built project: one UI task, checked like the whole app, merged without approval. */
export const requestQuickChange = mutationGeneric({
  args: { ...owner, id: v.id("projects"), text: v.string() },
  handler: async (ctx, { key, id, text }) => {
    const a = await requireRole(ctx, key, "editor");
    return startQuickChange(ctx, id, text, actorOf(a));
  },
});
