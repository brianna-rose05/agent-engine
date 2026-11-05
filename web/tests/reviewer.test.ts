import { describe, expect, it } from "vitest";
import { REVIEW_CHANGES, codeReviewFor, features, initialState, reduce } from "../src/lib/reduce";
import type { EngineEvent, ProjectState } from "../src/lib/types";
import { notificationFor } from "../convex/notifications";

const ev = (t: number, kind: EngineEvent["kind"], task_id: string | null, data: Record<string, unknown>): EngineEvent =>
  ({ t, kind, task_id, data });

const plan = { project: "x", contracts: [], tasks: [
  { id: "T1", title: "Slots", module: "src/server/slots.ts", spec: "", depends_on: [] },
  { id: "T2", title: "Bookings", module: "src/server/bookings.ts", spec: "", depends_on: [] }] };

const tryOf = (n: number, passed: boolean, reason = "") => ({ n, passed, claim: "done", reason, cost_usd: 0.01, seconds: 1,
                                                              turns: 1, files_changed: ["src/server/slots.ts"] });

/** T1's try `n` passes its checks and the reviewer starts reading it. */
function inReview(s: ProjectState, n: number, t: number): ProjectState {
  s = reduce(s, ev(t, "task_status", "T1", { status: "working", attempt: n }));
  s = reduce(s, ev(t + 0.2, "task_status", "T1", { status: "checking", attempt: n }));
  return reduce(s, ev(t + 0.4, "task_status", "T1", { status: "reviewing_code", attempt: n }));
}

function started(): ProjectState {
  let s = reduce(initialState(), ev(0, "plan_ready", null, { plan }));
  s = reduce(s, ev(1, "plan_decision", null, { approved: true }));
  return reduce(s, ev(2, "task_queued", "T1", { title: "Slots", role: "dev", depends_on: [] }));
}

describe("reducer: code reviewer", () => {
  it("a try in code review is in Checking, marked as in code review, with no feed line until the verdict", () => {
    const s = inReview(started(), 1, 3);
    expect(s.tasks.T1.status).toBe("reviewing_code");
    const card = features(s).find((f) => f.id === "T1")!;
    expect(card).toMatchObject({ column: "checking", code_reviewing: true, reviewing: false, active: "dev" });
    expect(s.feed.filter((f) => f.task_id === "T1").map((f) => f.who)).toEqual(["dev"]);
  });

  it("approve: the verdict is kept on the task, the reviewer speaks in the feed, then the merge", () => {
    let s = inReview(started(), 1, 3);
    s = reduce(s, ev(5, "code_review", "T1", { verdict: "approve", comments: ["Clear."], attempt: 1 }));
    expect(s.tasks.T1.code_reviews).toEqual([{ attempt: 1, verdict: "approve", comments: ["Clear."], t: 5 }]);
    expect(s.feed.at(-1)).toMatchObject({ who: "reviewer", channel: "build", task_id: "T1", text: "Reviewer approved Slots." });
    s = reduce(s, ev(5.1, "attempt_finished", "T1", tryOf(1, true)));
    s = reduce(s, ev(5.2, "task_status", "T1", { status: "merging", attempt: 1 }));
    s = reduce(s, ev(5.3, "task_status", "T1", { status: "merged" }));
    expect(features(s).find((f) => f.id === "T1")).toMatchObject({ column: "done", code_reviewing: false });
    const who = s.feed.filter((f) => f.task_id === "T1").map((f) => f.who);
    expect(who).toEqual(["dev", "reviewer", "engine"]); // building, approved, merged: in order
  });

  it("changes: one reviewer line with the first comment, no 'checks disagree' line, and the next try says why", () => {
    let s = inReview(started(), 1, 3);
    const comments = ["Security: any signed-in user can cancel another user's booking.", "Slots past closing time are offered."];
    s = reduce(s, ev(5, "code_review", "T1", { verdict: "changes", comments, attempt: 1 }));
    expect(s.feed.at(-1)).toMatchObject({
      who: "reviewer", tone: "warn",
      text: "Reviewer asked for changes on Slots: Security: any signed-in user can cancel another user's booking. (and 1 more)" });
    const before = s.feed.length;
    s = reduce(s, ev(5.1, "attempt_finished", "T1", { ...tryOf(1, false, REVIEW_CHANGES), output: comments.map((c) => `- ${c}`).join("\n") }));
    expect(s.feed.length).toBe(before); // the reviewer already said it
    expect(s.tasks.T1.attempts[0]).toMatchObject({ n: 1, passed: false, reason: REVIEW_CHANGES });
    s = inReview(s, 2, 6);
    expect(s.feed.filter((f) => f.task_id === "T1").at(-1)!.text).toBe("Slots: trying again with the reviewer's comments (try 2).");
    s = reduce(s, ev(8, "code_review", "T1", { verdict: "approve", comments: [], attempt: 2 }));
    expect(s.tasks.T1.code_reviews!.map((r) => [r.attempt, r.verdict])).toEqual([[1, "changes"], [2, "approve"]]);
    expect(codeReviewFor(s.tasks.T1, 1)!.comments).toEqual(comments);
    expect(s.feed.at(-1)!.text).toBe("Reviewer approved Slots.");
  });

  it("a single comment has no '(and N more)'", () => {
    const s = reduce(inReview(started(), 1, 3), ev(5, "code_review", "T1", { verdict: "changes", comments: ["Cancelling deletes the booking history."], attempt: 1 }));
    expect(s.feed.at(-1)!.text).toBe("Reviewer asked for changes on Slots: Cancelling deletes the booking history.");
  });

  it("a second non-security 'changes' approves with the engine's note", () => {
    const note = "Only a security problem can hold a feature back a second time, so these comments don't block it.";
    const s = reduce(inReview(started(), 2, 3), ev(5, "code_review", "T1", { verdict: "approve", comments: ["Rename it."], attempt: 2, note }));
    expect(s.feed.at(-1)!.text).toBe(`Reviewer approved Slots. ${note}`);
    expect(codeReviewFor(s.tasks.T1, 2)).toMatchObject({ verdict: "approve", note, comments: ["Rename it."] });
  });

  it("review skipped at the spending limit, and a broken review, are said plainly and merge", () => {
    let s = reduce(started(), ev(3, "code_review", "T1", { verdict: "approve", comments: [], attempt: 1, skipped: true }));
    expect(s.feed.at(-1)).toMatchObject({ who: "reviewer", tone: "warn",
                                          text: "Review skipped (spending limit): Slots merges on its passing tests, unreviewed." });
    expect(codeReviewFor(s.tasks.T1, 1)).toMatchObject({ skipped: true, verdict: "approve" });
    s = reduce(s, ev(4, "code_review", "T1", { verdict: "approve", comments: [], attempt: 2, review_error: true,
                                               note: "The reviewer couldn't review this attempt, so it merges on its passing tests." }));
    expect(s.feed.at(-1)).toMatchObject({ who: "reviewer", tone: "warn",
                                          text: "The reviewer couldn't review Slots (its run hit an error), so it merges on its passing tests." });
    expect(codeReviewFor(s.tasks.T1, 2)!.error).toBe(true);
  });

  it("keeps the latest verdict per try, oldest try first, and ignores junk", () => {
    let s = reduce(started(), ev(3, "code_review", "T1", { verdict: "changes", comments: ["a", 5, "  ", " b "], attempt: 2 }));
    s = reduce(s, ev(4, "code_review", "T1", { verdict: "changes", comments: ["x"], attempt: 1 }));
    s = reduce(s, ev(5, "code_review", "T1", { verdict: "approve", comments: "not a list", attempt: 2 }));
    expect(s.tasks.T1.code_reviews!.map((r) => [r.attempt, r.verdict, r.comments])).toEqual([[1, "changes", ["x"]], [2, "approve", []]]);
    expect(reduce(s, ev(6, "code_review", "T1", { verdict: "maybe", attempt: 3 })).tasks.T1.code_reviews!.at(-1)!.verdict).toBe("approve");
  });

  it("ignores reviews of unknown tasks; a retry run starts the task's thread over", () => {
    let s = reduce(inReview(started(), 1, 3), ev(5, "code_review", "T1", { verdict: "changes", comments: ["x"], attempt: 1 }));
    const n = s.feed.length;
    expect(reduce(s, ev(6, "code_review", "T9", { verdict: "approve", comments: [], attempt: 1 })).feed.length).toBe(n);
    s = reduce(s, ev(20, "task_queued", "T1", { title: "Slots", role: "dev", depends_on: [] }));
    expect(s.tasks.T1.code_reviews).toBeUndefined();
  });

  it("the reviewer's own run is never a card, but its cost counts", () => {
    let s = inReview(started(), 1, 3);
    s = reduce(s, ev(4, "task_status", "T1-codereview", { status: "working", attempt: 1 }));
    s = reduce(s, ev(4.5, "attempt_finished", "T1-codereview", { ...tryOf(1, true), cost_usd: 0.05 }));
    expect(s.tasks["T1-codereview"]).toBeUndefined();
    expect(s.cost_usd).toBe(0.05);
    expect(features(s).map((f) => f.id)).toEqual(["T1", "T2"]);
  });

  it("a code review never notifies you", () => {
    expect(notificationFor("code_review", { verdict: "changes", comments: ["x"] }, "P")).toBeNull();
  });
});
