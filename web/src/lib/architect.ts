/* The architect (docs/architect.md): reviews a plan's contracts after its checks pass and before you approve it. */
import type { ArchitectReview, FeedItem } from "./types";

/** The reason on a plan try the architect sent back (engine/engine.py ARCHITECT_CHANGES); architect_review said why. */
export const ARCHITECT_CHANGES = "the architect requested changes";

/** An architect_review event's data as the app keeps it. Anything odd reads as a plain approval. */
export function architectReview(data: Record<string, unknown>, t: number): ArchitectReview {
  const comments = Array.isArray(data.comments)
    ? data.comments.filter((c): c is string => typeof c === "string" && c.trim() !== "").map((c) => c.trim()) : [];
  const round = Number(data.round) >= 2 ? 2 : 1;
  const verdict = data.verdict === "changes" && comments.length ? "changes" : "approve";
  return {
    verdict, comments, round, t,
    ...(data.warnings && verdict === "changes" ? { warnings: true } : {}),
    ...(data.architect_error ? { error: true } : {}),
    ...(data.skipped ? { skipped: true } : {}),
  };
}

/** The comments to show in the warning box above the Approve button: only when the architect still asked for
 *  changes on the planner's second plan (warnings). Null otherwise. */
export function architectWarnings(review: ArchitectReview | null | undefined): string[] | null {
  return review?.warnings && review.comments.length ? review.comments : null;
}

/** One line for the approval screen: what the architect decided about the plan you're about to approve. */
export function architectVerdict(review: ArchitectReview | null | undefined):
  { text: string; tone: "good" | "warn" } | null {
  if (!review) return null;
  if (review.skipped) return { tone: "warn", text: "Not reviewed: the spending limit didn't allow an architect review." };
  if (review.error) return { tone: "warn", text: "Not reviewed: the architect's run hit an error." };
  if (review.warnings) {
    return { tone: "warn", text: "The architect still has concerns after the planner's second try. You decide." };
  }
  return { tone: "good", text: review.round > 1
    ? "Approved by the architect after the planner fixed its comments."
    : "Approved by the architect: contracts, migrations and security checked." };
}

const SECURITY = /^security:\s*/i;
export const isSecurity = (comment: string) => SECURITY.test(comment);
export const withoutSecurityTag = (comment: string) => comment.replace(SECURITY, "");

const sentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);

/** The feed line for an architect_review. `what`: "the plan" or "the plan for change 2". */
export function architectFeed(review: ArchitectReview, what: string): Pick<FeedItem, "text" | "tone"> {
  const more = review.comments.length > 1 ? ` (and ${review.comments.length - 1} more)` : "";
  const first = sentence((review.comments[0] ?? "").replace(/[.!?]$/, "") + more);
  if (review.skipped) {
    return { tone: "warn", text: `Architect review skipped (spending limit): ${what} comes to you unreviewed.` };
  }
  if (review.error) {
    return { tone: "warn", text: `The architect couldn't review ${what} (its run hit an error), so it comes to you unreviewed.` };
  }
  if (review.warnings) {
    return { tone: "warn", text: `Architect still has concerns about ${what}, so they come to you with it: ${first} You decide.` };
  }
  if (review.verdict === "changes") {
    return { tone: "warn", text: `Architect asked the planner to fix ${what} before it comes to you: ${first}` };
  }
  return { tone: review.round > 1 ? "good" : undefined,
           text: review.round > 1 ? `Architect approved the revised ${what.replace(/^the /, "")}.`
                                  : `Architect reviewed the contracts of ${what} and approved it.` };
}
