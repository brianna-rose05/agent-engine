import { describe, expect, it } from "vitest";
import { features, initialState, reduce } from "../src/lib/reduce";
import type { EngineEvent, ProjectState } from "../src/lib/types";
import { ANSWER_MAX, RETRY_PATCH, checkAnswer, checkAnswerText, failedTasks, retryBlocker, withAnswer } from "../convex/answers";
import { isDuplicate, notificationFor, notificationPath } from "../convex/notifications";

const ev = (t: number, kind: EngineEvent["kind"], task_id: string | null, data: Record<string, unknown>): EngineEvent =>
  ({ t, kind, task_id, data });

const plan = { project: "x", contracts: [], tasks: [
  { id: "T1", title: "Slots", module: "src/server/slots.ts", spec: "", depends_on: [] },
  { id: "T2", title: "Bookings", module: "src/server/bookings.ts", spec: "", depends_on: [] }] };

const failedTry = (n: number) => ({ n, passed: false, claim: "done", reason: "2 hidden tests failed", cost_usd: 0.01,
                                    seconds: 1, turns: 1, files_changed: [] });

/** T1 fails its 3 tries and the tech lead starts reviewing. */
function reviewing(): ProjectState {
  let s = reduce(initialState(), ev(0, "plan_ready", null, { plan }));
  s = reduce(s, ev(1, "plan_decision", null, { approved: true }));
  s = reduce(s, ev(2, "task_queued", "T1", { title: "Slots", role: "dev", depends_on: [] }));
  for (const n of [1, 2, 3]) {
    s = reduce(s, ev(2 + n, "task_status", "T1", { status: "working", attempt: n }));
    s = reduce(s, ev(2.5 + n, "attempt_finished", "T1", failedTry(n)));
  }
  return reduce(s, ev(10, "task_status", "T1", { status: "reviewing", attempt: 3 }));
}

describe("reducer: tech lead review", () => {
  it("shows a reviewing task in Checking, with the tech lead speaking in the feed", () => {
    const s = reviewing();
    expect(s.tasks.T1.status).toBe("reviewing");
    const card = features(s).find((f) => f.id === "T1")!;
    expect(card.column).toBe("checking");
    expect(card.reviewing).toBe(true);
    expect(s.feed.at(-1)).toMatchObject({ who: "tech lead", task_id: "T1", channel: "build" });
    expect(s.feed.at(-1)!.text).toContain("Slots didn't pass after 3 tries");
  });

  it("retry on Sonnet: keeps the note, decision and model, and the extra tries say so", () => {
    let s = reduce(reviewing(), ev(11, "tech_lead_review", "T1", {
      decision: "retry", note: "The slot end is exclusive; compare with < not <=.", stronger_model: true, model: "sonnet" }));
    expect(s.tasks.T1.review).toMatchObject({ decision: "retry", note: "The slot end is exclusive; compare with < not <=.",
                                               stronger_model: true, model: "sonnet" });
    expect(s.tasks.T1.retry_model).toBe("sonnet");
    expect(s.feed.at(-1)).toMatchObject({ who: "tech lead", task_id: "T1" });
    expect(s.feed.at(-1)!.text).toBe("Tech lead reviewed Slots: trying again on Sonnet. The slot end is exclusive; compare with < not <=.");
    s = reduce(s, ev(12, "task_status", "T1", { status: "working", attempt: 4 }));
    expect(s.feed.at(-1)!.text).toBe("Slots: trying again with the tech lead's guidance (try 4, on Sonnet).");
    expect(features(s).find((f) => f.id === "T1")!.retry_model).toBe("sonnet");
    s = reduce(s, ev(13, "attempt_finished", "T1", { ...failedTry(4), passed: true }));
    s = reduce(s, ev(14, "task_status", "T1", { status: "merged" }));
    const card = features(s).find((f) => f.id === "T1")!;
    expect(card.column).toBe("done");
    expect(card.tries).toBe(4);
    expect(card.question).toBeUndefined();
  });

  it("retry without a stronger model just says it's trying again", () => {
    const s = reduce(reviewing(), ev(11, "tech_lead_review", "T1", { decision: "retry", note: "Read the contract.", stronger_model: false }));
    expect(s.feed.at(-1)!.text).toBe("Tech lead reviewed Slots: trying again. Read the contract.");
    expect(s.tasks.T1.retry_model).toBeUndefined();
  });

  it("escalate: the question reaches you once, and the card shows it under Needs you", () => {
    const question = "Should a booking that ends at 17:00 fit a slot that closes at 17:00? (a) yes (b) no";
    let s = reduce(reviewing(), ev(11, "tech_lead_review", "T1", {
      decision: "escalate", note: "The spec and the tests disagree on closing time.", question, stronger_model: false }));
    expect(s.tasks.T1.review!.decision).toBe("escalate");
    expect(s.feed.at(-1)!.text).toBe("Tech lead reviewed Slots: The spec and the tests disagree on closing time.");
    s = reduce(s, ev(12, "escalated", "T1", { question }));
    expect(s.tasks.T1.question).toBe(question);
    expect(s.feed.at(-1)).toMatchObject({ who: "tech lead", tone: "bad", text: `Tech lead needs you on Slots: ${question}` });
    const before = s.feed.length;
    s = reduce(s, ev(13, "task_status", "T1", { status: "failed", error: `Needs you: ${question}` }));
    expect(s.feed.length).toBe(before); // no second "needs you" line
    const card = features(s).find((f) => f.id === "T1")!;
    expect(card.column).toBe("attention");
    expect(card.question).toBe(question);
    expect(s.tasks.T1.error).toBe(`Needs you: ${question}`);
  });

  it("a retry that still fails escalates after 5 tries", () => {
    let s = reduce(reviewing(), ev(11, "tech_lead_review", "T1", { decision: "retry", note: "n", stronger_model: true, model: "sonnet" }));
    for (const n of [4, 5]) {
      s = reduce(s, ev(11 + n, "task_status", "T1", { status: "working", attempt: n }));
      s = reduce(s, ev(11.5 + n, "attempt_finished", "T1", failedTry(n)));
    }
    s = reduce(s, ev(20, "escalated", "T1", { question: "Which time zone?" }));
    s = reduce(s, ev(21, "task_status", "T1", { status: "failed", error: "Needs you: Which time zone?" }));
    expect(s.tasks.T1.attempts).toHaveLength(5);
    expect(features(s).find((f) => f.id === "T1")).toMatchObject({ column: "attention", question: "Which time zone?",
                                                                    retry_model: "sonnet", tries: 5 });
  });

  it("a tech lead error is said plainly and still leaves a question", () => {
    let s = reduce(reviewing(), ev(11, "tech_lead_review", "T1", {
      decision: "escalate", note: "", question: "The tech lead couldn't review this feature. How should it work?",
      stronger_model: false, tech_lead_error: true }));
    expect(s.tasks.T1.review!.error).toBe(true);
    expect(s.feed.at(-1)).toMatchObject({ who: "tech lead", tone: "bad" });
    expect(s.feed.at(-1)!.text).toContain("couldn't review Slots");
    s = reduce(s, ev(12, "escalated", "T1", {}));
    expect(s.tasks.T1.question).toBe("The tech lead couldn't review this feature. How should it work?"); // from the review
  });

  it("a retry run starts the task over: no open question, no old review", () => {
    let s = reduce(reviewing(), ev(11, "tech_lead_review", "T1", { decision: "escalate", note: "", question: "Q?", stronger_model: false }));
    s = reduce(s, ev(12, "escalated", "T1", { question: "Q?" }));
    s = reduce(s, ev(13, "task_status", "T1", { status: "failed", error: "Needs you: Q?" }));
    s = reduce(s, ev(14, "project_finished", null, { status: "failed" }));
    s = reduce(s, ev(20, "build_resumed", null, { merged: ["PLAN"], retrying: ["T1"] }));
    s = reduce(s, ev(21, "task_queued", "T1", { title: "Slots", role: "dev", depends_on: [] }));
    expect(s.tasks.T1.question).toBeUndefined();
    expect(s.tasks.T1.review).toBeUndefined();
    expect(features(s).find((f) => f.id === "T1")!.question).toBeUndefined();
  });

  it("a plain failure without a review still says it needs you", () => {
    let s = reduce(initialState(), ev(0, "plan_ready", null, { plan }));
    s = reduce(s, ev(1, "task_queued", "T2", { title: "Bookings", role: "dev", depends_on: [] }));
    s = reduce(s, ev(2, "task_status", "T2", { status: "failed" }));
    expect(s.feed.at(-1)!.text).toBe("Bookings needs you: 3 tries, still not passing.");
  });

  it("ignores review events for unknown tasks", () => {
    const s = reviewing();
    const after = reduce(reduce(s, ev(11, "tech_lead_review", "T9", { decision: "retry", note: "x" })), ev(12, "escalated", "T9", { question: "?" }));
    expect(after.feed.length).toBe(s.feed.length);
  });
});

describe("answers to the tech lead", () => {
  const events = [
    { kind: "task_queued", taskId: "T1", data: {} },
    { kind: "task_status", taskId: "T1", data: { status: "failed" } },
    { kind: "task_queued", taskId: "T2", data: {} },
    { kind: "task_status", taskId: "T2", data: { status: "merged" } },
    { kind: "task_queued", taskId: "T3", data: {} },
    { kind: "task_status", taskId: "T3", data: { status: "failed" } },
    { kind: "task_queued", taskId: "T3", data: {} }, // re-queued by a later run: no longer failed
    { kind: "project_finished", taskId: null, data: { status: "failed" } },
  ];

  it("only tasks whose latest state is failed can be answered", () => {
    expect([...failedTasks(events)]).toEqual(["T1"]);
    expect(checkAnswer("T1", "  Yes, 17:00 fits.  ", failedTasks(events))).toEqual({ ok: true, text: "Yes, 17:00 fits." });
    expect(checkAnswer("T2", "yes", failedTasks(events)).ok).toBe(false);   // merged
    expect(checkAnswer("T3", "yes", failedTasks(events)).ok).toBe(false);   // queued again
    expect(checkAnswer("T9", "yes", failedTasks(events)).ok).toBe(false);   // unknown
  });

  it("trims the text and needs 1 to 2000 characters", () => {
    expect(checkAnswerText("   ").ok).toBe(false);
    expect(checkAnswerText("")).toMatchObject({ ok: false, message: expect.stringContaining("answer") });
    expect(checkAnswerText("a")).toEqual({ ok: true, text: "a" });
    expect(checkAnswerText(` ${"x".repeat(ANSWER_MAX)} `).ok).toBe(true);
    expect(checkAnswerText("x".repeat(ANSWER_MAX + 1))).toMatchObject({ ok: false, message: expect.stringContaining("2000") });
  });

  it("a later answer for the same task replaces the earlier one; others stay", () => {
    let a = withAnswer(undefined, "T1", "first");
    a = withAnswer(a, "T2", "other");
    a = withAnswer(a, "T1", "second");
    expect(a).toEqual({ T1: "second", T2: "other" });
  });

  it("shares retryFailed's preconditions and effect", () => {
    expect(retryBlocker(null)).toMatch(/stopped after planning/);
    expect(retryBlocker({ status: "building", plan: {}, costUsd: 0 })).toMatch(/stopped after planning/);
    expect(retryBlocker({ status: "failed", costUsd: 0 })).toMatch(/stopped after planning/);
    expect(retryBlocker({ status: "failed", plan: {}, costUsd: 5, budgetUsd: 5 })).toMatch(/spent its limit/);
    expect(retryBlocker({ status: "failed", plan: {}, costUsd: 1 })).toBeNull();
    expect(retryBlocker({ status: "stopped", plan: {}, costUsd: 1, budgetUsd: 10 })).toBeNull();
    expect(RETRY_PATCH).toEqual({ status: "queued", resume: true, mode: undefined, error: undefined });
  });
});

describe("notifications: the tech lead needs you", () => {
  it("an escalated event makes a needs-you notification with the question, linking to the board", () => {
    const n = notificationFor("escalated", { question: "Which time zone should bookings use?" }, "Pawfect")!;
    expect(n).toMatchObject({ kind: "needs_you", email: true, title: "Pawfect: the tech lead needs you",
                              body: "Which time zone should bookings use?" });
    expect(notificationPath("abc", n.kind)).toBe("/p/abc/board");
    expect(notificationFor("escalated", {}, "P")!.body).toContain("Answer it on the board");
    expect(notificationFor("escalated", { question: "q".repeat(500) }, "P")!.body.length).toBe(300);
    expect(notificationFor("tech_lead_review", { decision: "retry" }, "P")).toBeNull();
  });

  it("the same unread question isn't notified twice", () => {
    const n = notificationFor("escalated", { question: "Q?" }, "P")!;
    const stored = { projectId: "p1", kind: n.kind, title: n.title, body: n.body, read: false };
    expect(isDuplicate([stored], "p1", n)).toBe(true);
    expect(isDuplicate([{ ...stored, read: true }], "p1", n)).toBe(false);
    expect(isDuplicate([stored], "p2", n)).toBe(false);
    expect(isDuplicate([{ ...stored, body: "Other?" }], "p1", n)).toBe(false);
  });
});
