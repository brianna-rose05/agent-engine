import { describe, expect, it } from "vitest";
import { ARCHITECT_CHANGES, architectFeed, architectReview, architectVerdict, architectWarnings } from "../src/lib/architect";
import { initialState, reduce } from "../src/lib/reduce";
import type { EngineEvent, ProjectState } from "../src/lib/types";
import { WHO } from "../src/components/ui";

const ev = (t: number, kind: EngineEvent["kind"], task_id: string | null, data: Record<string, unknown>): EngineEvent =>
  ({ t, kind, task_id, data });

const plan = { project: "x", contracts: ["supabase/migrations/0001_init.sql"], tasks: [
  { id: "T1", title: "Slots", module: "src/server/slots.ts", spec: "", depends_on: [] },
  { id: "T2", title: "Bookings", module: "src/server/bookings.ts", spec: "", depends_on: ["T1"] }] };

const planTry = (n: number, passed: boolean, reason = "") => ({ n, passed, claim: "done", reason, cost_usd: 0.02, seconds: 1,
                                                                turns: 1, files_changed: ["plan.json"] });

/** The planner's plan passes its checks and the architect starts reading it. */
function inReview(s: ProjectState, n: number, t: number, id = "PLAN"): ProjectState {
  s = reduce(s, ev(t, "task_status", id, { status: "working", attempt: n }));
  s = reduce(s, ev(t + 0.2, "task_status", id, { status: "checking", attempt: n }));
  return reduce(s, ev(t + 0.4, "task_status", id, { status: "architect_reviewing", attempt: n }));
}

const planning = () => reduce(initialState(), ev(0, "task_queued", "PLAN", { title: "Plan the project", role: "planner", depends_on: [] }));

describe("reducer: architect on the build plan", () => {
  it("while it reviews, the planner is architect_reviewing and the Architect says so in the planning feed", () => {
    const s = inReview(planning(), 1, 1);
    expect(s.tasks.PLAN.status).toBe("architect_reviewing");
    expect(s.status).toBe("planning");
    expect(s.feed.at(-1)).toMatchObject({ who: "architect", channel: "planning", task_id: "PLAN" });
    expect(s.feed.at(-1)!.text).toContain("architect (a different model) is reviewing");
  });

  it("approve: kept in the plan state, one feed line, then the plan is ready", () => {
    let s = inReview(planning(), 1, 1);
    s = reduce(s, ev(3, "architect_review", "PLAN", { verdict: "approve", comments: [], round: 1 }));
    expect(s.architect).toEqual({ verdict: "approve", comments: [], round: 1, t: 3 });
    expect(s.feed.at(-1)).toMatchObject({ who: "architect", text: "Architect reviewed the contracts of the plan and approved it." });
    s = reduce(s, ev(3.1, "attempt_finished", "PLAN", planTry(1, true)));
    s = reduce(s, ev(3.2, "plan_ready", null, { plan }));
    expect(s.status).toBe("awaiting_approval");
    expect(s.architect?.verdict).toBe("approve");
    expect(architectWarnings(s.architect)).toBeNull();
  });

  it("changes then approve: the sent-back try gets no 'rejected' line, the revised plan is approved", () => {
    let s = inReview(planning(), 1, 1);
    const comment = "src/server/bookings.ts depends on a slots table no migration creates.";
    s = reduce(s, ev(3, "architect_review", "PLAN", { verdict: "changes", comments: [comment], round: 1 }));
    expect(s.feed.at(-1)).toMatchObject({ who: "architect", tone: "warn",
      text: `Architect asked the planner to fix the plan before it comes to you: ${comment}` });
    const before = s.feed.length;
    s = reduce(s, ev(3.1, "attempt_finished", "PLAN", { ...planTry(1, false, ARCHITECT_CHANGES), output: `- ${comment}` }));
    expect(s.feed.length).toBe(before); // the architect already said it
    s = inReview(s, 2, 4);
    s = reduce(s, ev(6, "architect_review", "PLAN", { verdict: "approve", comments: [], round: 2 }));
    expect(s.architect).toMatchObject({ verdict: "approve", round: 2 });
    expect(s.feed.at(-1)).toMatchObject({ tone: "good", text: "Architect approved the revised plan." });
    expect(architectVerdict(s.architect)!.text).toContain("after the planner fixed its comments");
  });

  it("changes twice: the plan comes to you with the comments as warnings", () => {
    let s = inReview(planning(), 1, 1);
    s = reduce(s, ev(3, "architect_review", "PLAN", { verdict: "changes", comments: ["Drops members."], round: 1 }));
    s = inReview(s, 2, 4);
    const comments = ["Security: the bookings policy lets every user read every booking", "Still drops members."];
    s = reduce(s, ev(6, "architect_review", "PLAN", { verdict: "changes", comments, round: 2, warnings: true }));
    s = reduce(s, ev(6.2, "plan_ready", null, { plan }));
    expect(s.architect).toEqual({ verdict: "changes", comments, round: 2, warnings: true, t: 6 });
    expect(architectWarnings(s.architect)).toEqual(comments);
    expect(s.feed.filter((f) => f.who === "architect").at(-1)).toMatchObject({ tone: "warn",
      text: "Architect still has concerns about the plan, so they come to you with it: " +
            "Security: the bookings policy lets every user read every booking (and 1 more). You decide." });
    expect(architectVerdict(s.architect)).toMatchObject({ tone: "warn" });
  });

  it("an error or a skipped review comes to you unreviewed, never as warnings", () => {
    let s = inReview(planning(), 1, 1);
    s = reduce(s, ev(3, "architect_review", "PLAN", { verdict: "approve", comments: [], round: 1, architect_error: true }));
    expect(s.architect).toMatchObject({ error: true });
    expect(s.feed.at(-1)!.text).toContain("couldn't review the plan");
    expect(architectWarnings(s.architect)).toBeNull();
    s = reduce(planning(), ev(3, "architect_review", "PLAN", { verdict: "approve", comments: [], round: 1, skipped: true }));
    expect(s.architect).toMatchObject({ skipped: true });
    expect(s.feed.at(-1)!.text).toBe("Architect review skipped (spending limit): the plan comes to you unreviewed.");
    expect(architectVerdict(s.architect)!.text).toContain("spending limit");
  });

  it("a new build plan starts without the last plan's review", () => {
    let s = reduce(planning(), ev(3, "architect_review", "PLAN", { verdict: "approve", comments: [], round: 1 }));
    s = reduce(s, ev(9, "task_queued", "PLAN", { title: "Plan the project", role: "planner", depends_on: [] }));
    expect(s.architect).toBeNull();
  });
});

describe("reducer: architect on a change plan", () => {
  it("attaches to the change, not the build plan, and names the change", () => {
    let s = reduce(planning(), ev(1, "architect_review", "PLAN", { verdict: "approve", comments: [], round: 1 }));
    s = reduce(s, ev(1.1, "plan_ready", null, { plan }));
    s = reduce(s, ev(1.2, "plan_decision", null, { approved: true }));
    s = reduce(s, ev(1.3, "project_finished", null, { status: "done" }));
    s = reduce(s, ev(2, "change_started", null, { n: 1, text: "Rename requireAdmin" }));
    s = reduce(s, ev(2.1, "task_queued", "C1PLAN", { title: "Plan the change", role: "planner", depends_on: [] }));
    s = inReview(s, 1, 3, "C1PLAN");
    expect(s.feed.at(-1)!.text).toContain("The plan for change 1 passed its checks");
    const c = "requireAdmin is removed but src/app/admin/page.tsx still imports it; keep it as a thin wrapper.";
    s = reduce(s, ev(4, "architect_review", "C1PLAN", { verdict: "changes", comments: [c], round: 1 }));
    expect(s.change?.architect).toMatchObject({ verdict: "changes", round: 1, comments: [c] });
    expect(s.architect).toMatchObject({ verdict: "approve", round: 1 }); // the build plan's is untouched
    expect(s.feed.at(-1)!.text).toBe(`Architect asked the planner to fix the plan for change 1 before it comes to you: ${c}`);
    s = reduce(s, ev(5, "architect_review", "C1PLAN", { verdict: "changes", comments: [c], round: 2, warnings: true }));
    s = reduce(s, ev(5.1, "change_plan_ready", null, { n: 1, change: { summary: "s", tasks: [], contracts: [] } }));
    expect(s.change?.decision).toBe("pending");
    expect(architectWarnings(s.change?.architect)).toEqual([c]);
  });

  it("a review for a change the app never saw start is ignored", () => {
    const s = reduce(initialState(), ev(1, "architect_review", "C3PLAN", { verdict: "approve", comments: [], round: 1 }));
    expect(s.changes).toEqual([]);
    expect(s.architect).toBeNull();
  });
});

describe("architect helpers", () => {
  it("architectReview reads event data defensively", () => {
    expect(architectReview({ verdict: "changes", comments: [" a ", "", 3], round: 2, warnings: true }, 1))
      .toEqual({ verdict: "changes", comments: ["a"], round: 2, warnings: true, t: 1 });
    expect(architectReview({ verdict: "changes", comments: [] }, 1)).toEqual({ verdict: "approve", comments: [], round: 1, t: 1 });
    expect(architectReview({ verdict: "approve", warnings: true, comments: ["note"] }, 1)).not.toHaveProperty("warnings");
    expect(architectReview({}, 2)).toEqual({ verdict: "approve", comments: [], round: 1, t: 2 });
  });

  it("the warning box shows only for warnings with comments", () => {
    const base = { verdict: "changes" as const, comments: ["x"], round: 2, t: 0 };
    expect(architectWarnings({ ...base, warnings: true })).toEqual(["x"]);
    expect(architectWarnings(base)).toBeNull();                       // round 1 changes: back to the planner, not you
    expect(architectWarnings({ ...base, verdict: "approve", comments: ["note"] })).toBeNull();
    expect(architectWarnings({ ...base, warnings: true, comments: [] })).toBeNull();
    expect(architectWarnings(null)).toBeNull();
    expect(architectWarnings(undefined)).toBeNull();
  });

  it("the verdict line covers every outcome", () => {
    const r = (x: object) => ({ verdict: "approve" as const, comments: [], round: 1, t: 0, ...x });
    expect(architectVerdict(null)).toBeNull();
    expect(architectVerdict(r({}))).toMatchObject({ tone: "good" });
    expect(architectVerdict(r({ round: 2 }))!.text).toContain("after the planner fixed");
    expect(architectVerdict(r({ error: true }))).toMatchObject({ tone: "warn" });
    expect(architectVerdict(r({ skipped: true }))).toMatchObject({ tone: "warn" });
    expect(architectVerdict(r({ verdict: "changes", comments: ["x"], warnings: true }))).toMatchObject({ tone: "warn" });
  });

  it("feed lines end each comment as a sentence, once", () => {
    const r = { verdict: "changes" as const, comments: ["Drops members."], round: 1, t: 0 };
    expect(architectFeed(r, "the plan").text).toBe("Architect asked the planner to fix the plan before it comes to you: Drops members.");
  });

  it("the Architect has its own avatar and colour, like the tech lead and the reviewer", () => {
    expect(WHO.architect).toMatchObject({ label: "Architect", bg: "bg-arch-bg", fg: "text-arch" });
    const colours = Object.values(WHO).map((w) => w.fg);
    expect(new Set(colours).size).toBe(colours.length);
  });
});
