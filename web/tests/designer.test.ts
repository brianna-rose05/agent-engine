import { describe, expect, it } from "vitest";
import { features, initialState, reduce } from "../src/lib/reduce";
import { DESIGN_CHANGES, designFeed, designReview, designReviewFor, designWarnings, splitComment, widthLabel } from "../src/lib/designer";
import type { EngineEvent, ProjectState } from "../src/lib/types";

const ev = (t: number, kind: EngineEvent["kind"], task_id: string | null, data: Record<string, unknown>): EngineEvent =>
  ({ t, kind, task_id, data });

const plan = { project: "x", contracts: [], tasks: [
  { id: "T1", title: "Slots", module: "src/server/slots.ts", spec: "", depends_on: [] }] };

const tryOf = (n: number, passed: boolean, reason = "", output = "") => ({
  n, passed, claim: "done", reason, cost_usd: 0.02, seconds: 1, turns: 1, files_changed: ["src/app/page.tsx"], output });

const comments = ["/book (390): the slot table runs off the right edge; let it wrap.",
                  "/ (1280): the heading overlaps the nav bar."];

function started(): ProjectState {
  let s = reduce(initialState(), ev(0, "plan_ready", null, { plan }));
  s = reduce(s, ev(1, "plan_decision", null, { approved: true }));
  s = reduce(s, ev(2, "task_queued", "T1", { title: "Slots", role: "dev", depends_on: [] }));
  s = reduce(s, ev(3, "task_status", "T1", { status: "merged" }));
  return reduce(s, ev(4, "task_queued", "INT", { title: "Integrate: pages, sign-in and data", role: "dev", depends_on: ["T1"] }));
}

/** INT's try `n` passes its whole-app check and the designer starts looking at it. */
function looking(s: ProjectState, n: number, t: number): ProjectState {
  s = reduce(s, ev(t, "task_status", "INT", { status: "working", attempt: n }));
  s = reduce(s, ev(t + 0.2, "task_status", "INT", { status: "checking", attempt: n }));
  return reduce(s, ev(t + 0.4, "task_status", "INT", { status: "design_review", attempt: n }));
}

const card = (s: ProjectState) => features(s).find((f) => f.id === "INT")!;
const intFeed = (s: ProjectState) => s.feed.filter((f) => f.task_id === "INT");

describe("reducer: designer", () => {
  it("a try under design review is in Checking, marked as such, and the designer says what it's doing", () => {
    const s = looking(started(), 1, 5);
    expect(s.tasks.INT.status).toBe("design_review");
    expect(card(s)).toMatchObject({ column: "checking", design_reviewing: true, code_reviewing: false, active: "dev" });
    expect(intFeed(s).at(-1)).toMatchObject({ who: "designer", channel: "build" });
    expect(intFeed(s).at(-1)!.text).toContain("screenshots of every page, on desktop and phone");
  });

  it("approve: the verdict is kept on INT, the designer speaks, then the merge", () => {
    let s = looking(started(), 1, 5);
    s = reduce(s, ev(6, "design_review", "INT", { verdict: "approve", comments: [], attempt: 1 }));
    expect(s.tasks.INT.design_reviews).toEqual([{ attempt: 1, verdict: "approve", comments: [], t: 6 }]);
    expect(intFeed(s).at(-1)).toMatchObject({ who: "designer",
      text: "Designer looked at every page on desktop and phone and approved the pages." });
    s = reduce(s, ev(6.1, "attempt_finished", "INT", tryOf(1, true)));
    s = reduce(s, ev(6.2, "task_status", "INT", { status: "merged" }));
    expect(card(s)).toMatchObject({ column: "done", design_reviewing: false });
    expect(designWarnings(s)).toBeNull();
  });

  it("changes: one designer line, no 'checks disagree' line, and the extra try says it's fixing the comments", () => {
    let s = looking(started(), 1, 5);
    s = reduce(s, ev(6, "design_review", "INT", { verdict: "changes", comments, attempt: 1 }));
    expect(intFeed(s).at(-1)).toMatchObject({ who: "designer", tone: "warn",
      text: "Designer asked for changes to the pages: /book (390): the slot table runs off the right edge; let it wrap (and 1 more)." });
    const before = s.feed.length;
    s = reduce(s, ev(6.1, "attempt_finished", "INT", tryOf(1, false, DESIGN_CHANGES, comments.map((c) => `- ${c}`).join("\n"))));
    expect(s.feed.length).toBe(before); // the designer already said it
    s = looking(s, 2, 7);
    expect(intFeed(s).find((f) => f.text.startsWith("Fixing the designer's comments"))).toMatchObject({ who: "dev", tone: "warn" });
    s = reduce(s, ev(8, "design_review", "INT", { verdict: "approve", comments: [], attempt: 2 }));
    expect(s.tasks.INT.design_reviews!.map((r) => [r.attempt, r.verdict])).toEqual([[1, "changes"], [2, "approve"]]);
    expect(intFeed(s).at(-1)!.text).toBe("Designer approved the pages after the fix.");
    expect(designReviewFor(s.tasks.INT, 1)?.comments).toEqual(comments);
  });

  it("changes twice: merged with design warnings, which the Ship screen shows from the last build", () => {
    let s = looking(started(), 1, 5);
    s = reduce(s, ev(6, "design_review", "INT", { verdict: "changes", comments, attempt: 1 }));
    s = reduce(s, ev(6.1, "attempt_finished", "INT", tryOf(1, false, DESIGN_CHANGES)));
    s = looking(s, 2, 7);
    s = reduce(s, ev(8, "design_review", "INT", { verdict: "changes", comments: [comments[1]], attempt: 2, warnings: true }));
    expect(intFeed(s).at(-1)).toMatchObject({ who: "designer", tone: "warn" });
    expect(intFeed(s).at(-1)!.text).toContain("they merge anyway, with design warnings");
    expect(designWarnings(s)).toBeNull(); // not merged yet
    s = reduce(s, ev(8.1, "attempt_finished", "INT", tryOf(2, true)));
    s = reduce(s, ev(8.2, "task_status", "INT", { status: "merged" }));
    expect(designWarnings(s)).toEqual({ comments: [comments[1]], attempt: 2 });
    // a new run's integration starts clean: no warnings until its own designer speaks
    s = reduce(s, ev(20, "task_queued", "INT", { title: "Integrate the change", role: "dev", depends_on: [] }));
    expect(designWarnings(s)).toBeNull();
  });

  it("a fix that failed its checks: the reviewed try merges, its review becomes the warnings", () => {
    let s = looking(started(), 1, 5);
    s = reduce(s, ev(6, "design_review", "INT", { verdict: "changes", comments, attempt: 1 }));
    s = reduce(s, ev(6.1, "attempt_finished", "INT", tryOf(1, false, DESIGN_CHANGES)));
    s = reduce(s, ev(7, "task_status", "INT", { status: "working", attempt: 2 }));
    s = reduce(s, ev(8, "attempt_finished", "INT", tryOf(2, false, "the app doesn't build")));
    const reason = "The fix (try 2) didn't pass the whole-app check, so try 1 merges as it was, with the designer's comments as design warnings.";
    s = reduce(s, ev(9, "design_review", "INT", { verdict: "changes", comments, attempt: 1, warnings: true, reason }));
    s = reduce(s, ev(9.2, "task_status", "INT", { status: "merged" }));
    expect(s.tasks.INT.design_reviews).toEqual([{ attempt: 1, verdict: "changes", comments, warnings: true, reason, t: 9 }]);
    expect(designWarnings(s)).toEqual({ comments, attempt: 1 });
    expect(card(s).column).toBe("done");
  });

  it("skipped and broken reviews say so, and approve", () => {
    let s = looking(started(), 1, 5);
    s = reduce(s, ev(6, "design_review", "INT", { verdict: "approve", comments: [], attempt: 1, skipped: true,
                                                    reason: "no browser for screenshots: Chromium couldn't start" }));
    expect(intFeed(s).at(-1)).toMatchObject({ who: "designer", tone: "warn",
      text: "Design review skipped (no browser for screenshots: Chromium couldn't start): the pages merge unreviewed." });
    s = reduce(s, ev(7, "design_review", "INT", { verdict: "approve", comments: [], attempt: 1, designer_error: true }));
    expect(s.tasks.INT.design_reviews).toHaveLength(1); // the latest verdict per try
    expect(s.tasks.INT.design_reviews![0]).toMatchObject({ error: true, verdict: "approve" });
    expect(intFeed(s).at(-1)!.text).toContain("couldn't review the pages");
  });

  it("the designer's own cost counts toward the project, never as an INT try", () => {
    let s = looking(started(), 1, 5);
    s = reduce(s, ev(6, "attempt_finished", "INT-design", { ...tryOf(1, true), cost_usd: 0.11 }));
    expect(s.tasks.INT.attempts).toHaveLength(0);
    expect(s.tasks["INT-design"]).toBeUndefined();
    expect(s.cost_usd).toBeCloseTo(0.11);
  });

  it("design_review for a task the app never saw is ignored", () => {
    const s = reduce(started(), ev(6, "design_review", "Q1", { verdict: "changes", comments }));
    expect(s.feed.filter((f) => f.who === "designer")).toHaveLength(0);
  });
});

describe("designer helpers", () => {
  it("reads odd events as plain approvals", () => {
    expect(designReview({ verdict: "changes", comments: [] }, 1, 2)).toEqual({ attempt: 2, verdict: "approve", comments: [], t: 1 });
    expect(designReview({ verdict: "approve", comments: ["  ok  ", 3, ""], warnings: true }, 1, 1))
      .toEqual({ attempt: 1, verdict: "approve", comments: ["ok"], t: 1 }); // warnings only with changes
  });

  it("splits a comment into page, width and problem", () => {
    expect(splitComment("/book (390): runs off the edge")).toEqual({ page: "/book", width: "390", text: "runs off the edge" });
    expect(splitComment("/ (1280px): overlaps")).toEqual({ page: "/", width: "1280", text: "overlaps" });
    expect(splitComment("Looks unstyled everywhere")).toEqual({ text: "Looks unstyled everywhere" });
    expect([widthLabel("390"), widthLabel("1280"), widthLabel()]).toEqual(["phone", "desktop", ""]);
  });

  it("feed lines for each kind of verdict", () => {
    const base = { attempt: 1, comments: [], t: 0 };
    expect(designFeed({ ...base, verdict: "approve" }).tone).toBeUndefined();
    expect(designFeed({ ...base, verdict: "approve", skipped: true }).text).toContain("(no screenshots)");
    expect(designFeed({ ...base, verdict: "changes", comments: ["/ (390): cut off."] }).text)
      .toBe("Designer asked for changes to the pages: / (390): cut off.");
  });
});
