import { mutationGeneric, queryGeneric, type AnyDataModel, type GenericMutationCtx } from "convex/server";
import { ConvexError, v, type GenericId } from "convex/values";

import { checkOwner } from "./owner";
import { QUICK_TEXT_MAX, canRequestQuickChange, startQuickChange } from "./quick";
import { canRequestChange } from "./changes";
import { startChangeRequest } from "./projects";

/*
 * Comment pins on the preview (Studio's Preview page). The owner drops a numbered pin on the running app and writes a
 * note; selected pins are sent as one quick change (convex/quick.ts) or one change request (projects.requestChange),
 * through the same helpers and rules those use, and are marked sent with that number.
 *
 * Pins live on the project row (`comments`), oldest first, like quick changes and change requests. The rules below are
 * pure functions, so the app and the tests can import them without a Convex backend.
 */

export const COMMENT_TEXT_MIN = 2;
export const COMMENT_TEXT_MAX = 500;
export const COMMENTS_MAX = 200; // pins kept per project (sent and resolved ones included)
export const PATH_MAX = 300;

export type Viewport = "desktop" | "phone";
export type SendAs = "quick" | "change";

/** One pin. x/y are fractions (0..1) of the preview frame's width and height when it was dropped. */
export type Comment = {
  n: number;
  path: string;              // the page it is on, e.g. "/tools"
  pathKnown: boolean;        // false: the app has no Studio bridge, so this is the page the preview was opened at
  x: number;
  y: number;
  viewport: Viewport;
  text: string;
  at: number;                // milliseconds since epoch
  status: "open" | "sent" | "resolved";
  sentAs?: { kind: SendAs; n: number }; // quick change n / change request n
};

export type NewPin = { path: string; pathKnown: boolean; x: number; y: number; viewport: string; text: string };

/** The note, trimmed, or the message to show when it can't be used. */
export function checkCommentText(text: string): { ok: true; text: string } | { ok: false; message: string } {
  const t = text.trim();
  if (t.length < COMMENT_TEXT_MIN) return { ok: false, message: "Write a note for this pin." };
  if (t.length > COMMENT_TEXT_MAX) return { ok: false, message: `Keep a note under ${COMMENT_TEXT_MAX} characters.` };
  return { ok: true, text: t };
}

/** A page path the preview reported or was opened at: starts with one "/", no query, no control characters. */
export function isPagePath(path: unknown): path is string {
  return typeof path === "string" && path.length <= PATH_MAX && /^\/(?!\/)[^\s?#\\]*$/.test(path);
}

const fraction = (n: number) => Number.isFinite(n) && n >= 0 && n <= 1;

/** A new pin checked and cleaned up, or the message to show. */
export function checkPin(pin: NewPin): { ok: true; pin: Omit<Comment, "n" | "at" | "status"> } | { ok: false; message: string } {
  if (!isPagePath(pin.path)) return { ok: false, message: "This pin's page isn't a page of the app." };
  if (!fraction(pin.x) || !fraction(pin.y)) return { ok: false, message: "Drop the pin inside the preview." };
  if (pin.viewport !== "desktop" && pin.viewport !== "phone") return { ok: false, message: "Pick Desktop or Phone." };
  const text = checkCommentText(pin.text);
  if (!text.ok) return text;
  const round = (n: number) => Math.round(n * 10000) / 10000;
  return { ok: true, pin: { path: pin.path, pathKnown: Boolean(pin.pathKnown), x: round(pin.x), y: round(pin.y),
                            viewport: pin.viewport, text: text.text } };
}

/**
 * The next pin number: 1, 2, ... Never reused, so "pin 3" keeps meaning the same pin: `last` is the highest number
 * ever given on this project (the row's commentSeq), which a deleted pin no longer shows.
 */
export const nextCommentNumber = (comments: Comment[] | undefined, last = 0) =>
  (comments ?? []).reduce((m, c) => Math.max(m, c.n), Math.max(0, last)) + 1;

/** One line per pin, oldest first: `On /tools (phone): <note>`. A note's own line breaks become spaces. */
export function requestText(pins: Pick<Comment, "n" | "path" | "viewport" | "text">[]): string {
  return [...pins].sort((a, b) => a.n - b.n)
    .map((p) => `On ${p.path} (${p.viewport}): ${p.text.replace(/\s+/g, " ").trim()}`)
    .join("\n");
}

// What a quick change is for (convex/quick.ts, engine/quick.py): wording and looks. Anything about data, accounts or a
// new feature goes to a change request. Kept deliberately simple: the owner sees the suggestion and can override it.
const LOOKS = /\b(rename|renamed|reword|wording|word|words|text|copy|say|says|said|read|reads|label|labels|title|heading|headline|typo|spelling|spell|capitali[sz]e|colou?rs?|green|blue|red|black|white|gr[ae]y|orange|purple|pink|yellow|darker|lighter|dark|light|contrast|font|fonts|bold|italic|underline|size|bigger|smaller|larger|wider|narrower|taller|shorter|spacing|space|padding|margin|gap|align|aligned|center|centre|left|right|rounded|corners?|border|shadow|icon|logo|button|link|move|hide|show|placeholder|tagline|caption)\b/i;
const BIG = /\b(save|saves|saved|store|stores|stored|database|schema|table|column|field|fields|data|login|log in|sign[- ]?in|sign[- ]?up|account|accounts|password|email|emails|notify|notification|notifications|payment|payments|pay|stripe|checkout|upload|search|filter|sort|export|import|calculate|calculation|role|roles|permission|permissions|admins?|staff only|only (?:admins?|staff|owners?|managers?)|feature|features|new page|integrat\w*|api|booking rules?|limit|limits|validate|validation|when .* then|should be able to|let (?:people|users|me|customers|staff))\b/i;
export const QUICK_NOTE_MAX = 140;

/** Whether one note reads like wording or styling: short, about looks, nothing about data or features. */
export function isCopyOrStyle(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && t.length <= QUICK_NOTE_MAX && LOOKS.test(t) && !BIG.test(t);
}

/**
 * The PM's suggestion for the selected pins: "quick" when every note is short copy/style wording and the request fits
 * a quick change, else "change". The owner can always pick the other one.
 */
export function suggestSendAs(pins: Pick<Comment, "n" | "path" | "viewport" | "text">[]): SendAs {
  if (!pins.length) return "change";
  if (requestText(pins).length > QUICK_TEXT_MAX) return "change";
  return pins.every((p) => isCopyOrStyle(p.text)) ? "quick" : "change";
}

/** The pins to send, oldest first, or the message to show: each id must be an open pin of this project. */
export function pinsToSend(comments: Comment[], ids: number[]): { ok: true; pins: Comment[] } | { ok: false; message: string } {
  const wanted = [...new Set(ids)];
  if (!wanted.length) return { ok: false, message: "Pick at least one pin to send." };
  const pins: Comment[] = [];
  for (const n of wanted) {
    const c = comments.find((x) => x.n === n);
    if (!c) return { ok: false, message: `Pin ${n} doesn't exist any more.` };
    if (c.status !== "open") return { ok: false, message: `Pin ${n} was already ${c.status === "sent" ? "sent" : "resolved"}.` };
    pins.push(c);
  }
  return { ok: true, pins: pins.sort((a, b) => a.n - b.n) };
}

/** The comments with these pins marked sent as quick change / change request n. */
export function markSent(comments: Comment[], ids: number[], kind: SendAs, n: number): Comment[] {
  const set = new Set(ids);
  return comments.map((c) => (set.has(c.n) ? { ...c, status: "sent" as const, sentAs: { kind, n } } : c));
}

// ---------------------------------------------------------------------------------------------------- Convex

const owner = { key: v.string() };

type Row = { comments?: unknown[] } & Record<string, unknown>;
const commentsOf = (p: Row) => (p.comments ?? []) as Comment[];

async function ownRow(ctx: GenericMutationCtx<AnyDataModel>, id: GenericId<"projects">): Promise<Row> {
  const p = (await ctx.db.get(id)) as Row | null;
  if (!p) throw new ConvexError("This project doesn't exist any more.");
  return p;
}

function find(comments: Comment[], n: number): Comment {
  const c = comments.find((x) => x.n === n);
  if (!c) throw new ConvexError(`Pin ${n} doesn't exist any more.`);
  return c;
}

/** The project's pins (oldest first) and whether each kind of request can be sent now. */
export const forProject = queryGeneric({
  args: { ...owner, id: v.string() },
  handler: async (ctx, { key, id }) => {
    checkOwner(key);
    const pid = ctx.db.normalizeId("projects", id);
    const p = pid && (await ctx.db.get(pid));
    if (!p) return null;
    return {
      comments: commentsOf(p),
      next: nextCommentNumber(commentsOf(p), Number(p.commentSeq ?? 0)), // the number the next pin gets
      canQuick: canRequestQuickChange(p.status, Boolean(p.repo), false),
      canChange: Boolean(p.repo) && canRequestChange(p.status, Boolean(p.plan), false),
    };
  },
});

/** Drop a pin. Returns its number. */
export const add = mutationGeneric({
  args: { ...owner, id: v.id("projects"), path: v.string(), pathKnown: v.boolean(), x: v.number(), y: v.number(),
          viewport: v.string(), text: v.string() },
  handler: async (ctx, { key, id, ...pin }) => {
    checkOwner(key);
    const p = await ownRow(ctx, id);
    const checked = checkPin(pin);
    if (!checked.ok) throw new ConvexError(checked.message);
    const comments = commentsOf(p);
    if (comments.length >= COMMENTS_MAX) {
      throw new ConvexError(`A project keeps up to ${COMMENTS_MAX} pins. Delete some resolved ones first.`);
    }
    const entry: Comment = { ...checked.pin, n: nextCommentNumber(comments, Number(p.commentSeq ?? 0)), at: Date.now(), status: "open" };
    await ctx.db.patch(id, { comments: [...comments, entry], commentSeq: entry.n });
    return entry.n;
  },
});

/** Change an open pin's note. */
export const update = mutationGeneric({
  args: { ...owner, id: v.id("projects"), n: v.number(), text: v.string() },
  handler: async (ctx, { key, id, n, text }) => {
    checkOwner(key);
    const comments = commentsOf(await ownRow(ctx, id));
    if (find(comments, n).status !== "open") throw new ConvexError(`Pin ${n} was already sent, so its note stays as it was.`);
    const checked = checkCommentText(text);
    if (!checked.ok) throw new ConvexError(checked.message);
    await ctx.db.patch(id, { comments: comments.map((c) => (c.n === n ? { ...c, text: checked.text } : c)) });
  },
});

/** Resolve a pin (done, or not needed), or reopen a resolved one. A sent pin stays sent. */
export const resolve = mutationGeneric({
  args: { ...owner, id: v.id("projects"), n: v.number(), resolved: v.boolean() },
  handler: async (ctx, { key, id, n, resolved }) => {
    checkOwner(key);
    const comments = commentsOf(await ownRow(ctx, id));
    const c = find(comments, n);
    if (c.status === "sent" && !resolved) throw new ConvexError(`Pin ${n} was sent, so it can't be reopened. Drop a new pin.`);
    const status = resolved ? "resolved" : "open";
    await ctx.db.patch(id, { comments: comments.map((x) => (x.n === n ? { ...x, status } : x)) });
  },
});

/** Delete a pin that wasn't sent (a sent one is part of a request's history). */
export const remove = mutationGeneric({
  args: { ...owner, id: v.id("projects"), n: v.number() },
  handler: async (ctx, { key, id, n }) => {
    checkOwner(key);
    const comments = commentsOf(await ownRow(ctx, id));
    if (find(comments, n).status === "sent") throw new ConvexError(`Pin ${n} was sent, so it stays with its request. Resolve it instead.`);
    await ctx.db.patch(id, { comments: comments.filter((c) => c.n !== n) });
  },
});

/**
 * Send open pins as one request: a quick change or a change request, built from their notes ("On /tools (phone): ...",
 * one line per pin). It goes through startQuickChange / startChangeRequest, so every rule of those applies unchanged;
 * then the pins are marked sent with the request's number. Returns {kind, n}.
 */
export const sendComments = mutationGeneric({
  args: { ...owner, id: v.id("projects"), commentIds: v.array(v.number()), as: v.union(v.literal("quick"), v.literal("change")) },
  handler: async (ctx, { key, id, commentIds, as }) => {
    checkOwner(key);
    const picked = pinsToSend(commentsOf(await ownRow(ctx, id)), commentIds);
    if (!picked.ok) throw new ConvexError(picked.message);
    const text = requestText(picked.pins);
    const n = as === "quick" ? await startQuickChange(ctx, id, text) : await startChangeRequest(ctx, id, text);
    const comments = commentsOf(await ownRow(ctx, id)); // the row as the request left it
    await ctx.db.patch(id, { comments: markSent(comments, picked.pins.map((p) => p.n), as, n) });
    return { kind: as, n };
  },
});
