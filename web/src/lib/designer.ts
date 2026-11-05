/* The designer (docs/designer.md): after the integrator's whole-app check passes and before it merges, a different
 * model looks at screenshots of every page at desktop and phone width, and asks for changes only for clear visual
 * defects. One more try with its comments; a second "changes" merges anyway with them as design warnings. */
import type { DesignReview, FeedItem, ProjectState, TaskState } from "./types";

/** The integrator's task id (lib/reduce.ts INTEGRATION): the only task the designer reviews. */
const INTEGRATION = "INT";

/** The reason on a try the designer sent back (engine/designer.py DESIGN_CHANGES); design_review already said why. */
export const DESIGN_CHANGES = "the designer requested changes";

/** A design_review event's data as the app keeps it. Anything odd reads as a plain approval. */
export function designReview(data: Record<string, unknown>, t: number, fallbackAttempt: number): DesignReview {
  const comments = Array.isArray(data.comments)
    ? data.comments.filter((c): c is string => typeof c === "string" && c.trim() !== "").map((c) => c.trim()) : [];
  const verdict = data.verdict === "changes" && comments.length ? "changes" : "approve";
  const reason = typeof data.reason === "string" ? data.reason.trim() : "";
  return {
    attempt: Number(data.attempt ?? fallbackAttempt) || fallbackAttempt, verdict, comments, t,
    ...(data.warnings && verdict === "changes" ? { warnings: true } : {}),
    ...(data.designer_error ? { error: true } : {}),
    ...(data.skipped ? { skipped: true } : {}),
    ...(reason ? { reason } : {}),
  };
}

/** Keep the latest verdict per try (a redone try replaces its earlier review), oldest try first. A fallback merge
 *  (warnings on a try that was already reviewed) replaces that try's "changes" with the warnings. */
export function withDesignReview(t: TaskState, review: DesignReview): TaskState {
  const design_reviews = [...(t.design_reviews ?? []).filter((r) => r.attempt !== review.attempt), review]
    .sort((x, y) => x.attempt - y.attempt);
  return { ...t, design_reviews };
}

/** The designer's verdict on one try of a task, if it looked at that try. */
export const designReviewFor = (t: TaskState | undefined, n: number): DesignReview | undefined =>
  t?.design_reviews?.find((r) => r.attempt === n);

const sentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);

/** The feed line for a design_review. `what`: "the app" or similar. */
export function designFeed(review: DesignReview, what = "the pages"): Pick<FeedItem, "text" | "tone"> {
  const more = review.comments.length > 1 ? ` (and ${review.comments.length - 1} more)` : "";
  const first = sentence((review.comments[0] ?? "").replace(/[.!?]$/, "") + more);
  if (review.skipped) {
    return { tone: "warn", text: `Design review skipped (${review.reason ?? "no screenshots"}): ${what} merge unreviewed.` };
  }
  if (review.error) {
    return { tone: "warn", text: `The designer couldn't review ${what} (its run hit an error), so they merge as they are.` };
  }
  if (review.warnings) {
    return { tone: "warn", text: `Designer still sees problems in ${what}; they merge anyway, with design warnings: ${first}` };
  }
  if (review.verdict === "changes") {
    return { tone: "warn", text: `Designer asked for changes to ${what}: ${first}` };
  }
  return { text: review.attempt > 1 && review.comments.length === 0
    ? `Designer approved ${what} after the fix.` : `Designer looked at every page on desktop and phone and approved ${what}.` };
}

/** The design warnings the last build left (read-only, Ship screen): the integration's latest review, when it merged
 *  with the designer's comments still open. Null when there are none. */
export function designWarnings(s: ProjectState): { comments: string[]; attempt: number } | null {
  const integ = s.tasks[INTEGRATION];
  if (!integ || integ.status !== "merged") return null;
  const last = integ.design_reviews?.at(-1);
  return last?.warnings && last.comments.length ? { comments: last.comments, attempt: last.attempt } : null;
}

const PAGE = /^(\S+)\s+\((\d+)(?:px)?\):\s*/;

/** "/book (390): text" -> { page: "/book", width: "390", text } (the designer's comment format); as is otherwise. */
export function splitComment(c: string): { page?: string; width?: string; text: string } {
  const m = c.match(PAGE);
  return m ? { page: m[1], width: m[2], text: c.slice(m[0].length) } : { text: c };
}

/** "390" -> "phone", "1280" -> "desktop". */
export const widthLabel = (w?: string) => (!w ? "" : Number(w) < 700 ? "phone" : "desktop");
