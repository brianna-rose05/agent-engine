import { describe, expect, it } from "vitest";
import { features, initialState, reduce } from "../src/lib/reduce";
import type { EngineEvent } from "../src/lib/types";

const ev = (t: number, kind: EngineEvent["kind"], task_id: string | null, data: Record<string, unknown>): EngineEvent =>
  ({ t, kind, task_id, data });

describe("integration card", () => {
  const plan = { project: "x", contracts: [], tasks: [
    { id: "T1", title: "Slots", module: "src/server/slots.ts", spec: "", depends_on: [] },
    { id: "T2", title: "Bookings", module: "src/server/bookings.ts", spec: "", depends_on: ["T1"] }] };

  it("appears after the features, waits for them, and lands in Done when merged", () => {
    let s = reduce(initialState(), ev(0, "plan_ready", null, { plan }));
    s = reduce(s, ev(1, "task_queued", "INT", { title: "Integrate", role: "dev", depends_on: ["T1", "T2"] }));
    let card = features(s).at(-1)!;
    expect(card.id).toBe("INT");
    expect(card.waitingOn).toEqual(["T1", "T2"]);
    s = reduce(s, ev(2, "task_status", "INT", { status: "working", attempt: 1 }));
    expect(s.feed.at(-1)!.text).toContain("building the pages, sign-in and server actions");
    s = reduce(s, ev(3, "task_status", "INT", { status: "merged" }));
    card = features(s).at(-1)!;
    expect(card.column).toBe("done");
  });

  it("is absent for projects without an integration step", () => {
    const s = reduce(initialState(), ev(0, "plan_ready", null, { plan }));
    expect(features(s).map((f) => f.id)).toEqual(["T1", "T2"]);
  });
});

describe("retry what failed", () => {
  it("puts a stopped project back to building and resets the retried tasks", () => {
    const plan = { project: "x", contracts: [], tasks: [{ id: "T1", title: "A", module: "a.ts", spec: "", depends_on: [] }] };
    let s = reduce(initialState(), ev(0, "plan_ready", null, { plan }));
    s = reduce(s, ev(1, "task_queued", "T1", { title: "A", role: "dev", depends_on: [] }));
    s = reduce(s, ev(2, "task_status", "T1", { status: "failed" }));
    s = reduce(s, ev(3, "project_finished", null, { status: "failed" }));
    expect(features(s)[0].column).toBe("attention");
    s = reduce(s, ev(4, "build_resumed", null, { merged: ["PLAN"], retrying: ["T1"] }));
    s = reduce(s, ev(5, "task_queued", "T1", { title: "A", role: "dev", depends_on: [] }));
    expect(s.status).toBe("building");
    expect(features(s)[0].column).toBe("queued");
    expect(s.feed.at(-1)!.text).toContain("Retrying 1 unfinished task");
  });
});

describe("preview link", () => {
  const finished = () => reduce(initialState(), ev(0, "project_finished", null, { status: "done" }));

  it("stores the URL from preview_ready and says the data resets", () => {
    const s = reduce(finished(), ev(1, "preview_ready", null, { url: "https://studio-x.vercel.app" }));
    expect(s.preview_url).toBe("https://studio-x.vercel.app");
    expect(s.status).toBe("done");
    const last = s.feed.at(-1)!;
    expect(last.channel).toBe("build");
    expect(last.tone).toBe("good");
    expect(last.text).toContain("https://studio-x.vercel.app");
    expect(last.text).toContain("preview data resets");
  });

  it("ignores a preview_ready without an https URL", () => {
    const s = reduce(finished(), ev(1, "preview_ready", null, { url: "javascript:alert(1)" }));
    expect(s.preview_url).toBeNull();
  });

  it("reports a failed deploy in the build channel without a link", () => {
    const s = reduce(finished(), ev(1, "preview_failed", null, { reason: "Vercel build error: next build failed" }));
    expect(s.preview_url).toBeNull();
    expect(s.feed.at(-1)).toMatchObject({ channel: "build", tone: "warn" });
    expect(s.feed.at(-1)!.text).toContain("next build failed");
  });

  it("mentions a skipped preview quietly", () => {
    const s = reduce(finished(), ev(1, "preview_skipped", null, { reason: "no VERCEL_TOKEN" }));
    expect(s.preview_url).toBeNull();
    expect(s.feed.at(-1)!.channel).toBe("build");
    expect(s.feed.at(-1)!.tone).toBeUndefined();
    expect(s.feed.at(-1)!.text).toContain("no VERCEL_TOKEN");
  });

  it("keeps the link when a later retry starts", () => {
    let s = reduce(finished(), ev(1, "preview_ready", null, { url: "https://a.vercel.app" }));
    s = reduce(s, ev(2, "build_resumed", null, { merged: ["PLAN"], retrying: [] }));
    expect(s.preview_url).toBe("https://a.vercel.app");
  });
});

describe("live agent activity", () => {
  const queued = () => reduce(initialState(), ev(0, "task_queued", "PLAN", { title: "Plan", role: "planner", depends_on: [] }));

  it("keeps the latest notes per task without adding them to the feed", () => {
    let s = reduce(queued(), ev(5, "task_status", "PLAN", { status: "working", attempt: 1 }));
    const feed = s.feed.length;
    for (let i = 1; i <= 4; i++) {
      s = reduce(s, ev(5 + i * 10, "agent_activity", "PLAN", { attempt: 1, note: `n${i * 2}`, notes: [`n${i * 2 - 1}`, `n${i * 2}`] }));
    }
    expect(s.tasks.PLAN.notes).toEqual(["n4", "n5", "n6", "n7", "n8"]);
    expect(s.feed.length).toBe(feed);
    expect(s.status).toBe("planning");
    expect(s.now).toBe(45); // activity moves the clock too
    expect(s.tasks.PLAN.started).toBe(5);
  });

  it("accepts a single note, ignores unknown tasks, and starts a new try clean", () => {
    let s = reduce(queued(), ev(1, "task_status", "PLAN", { status: "working", attempt: 1 }));
    s = reduce(s, ev(2, "agent_activity", "PLAN", { attempt: 1, note: "Wrote plan/plan.json" }));
    s = reduce(s, ev(3, "agent_activity", "NOPE", { attempt: 1, note: "x" }));
    expect(s.tasks.PLAN.notes).toEqual(["Wrote plan/plan.json"]);
    expect(s.tasks.NOPE).toBeUndefined();
    s = reduce(s, ev(9, "task_status", "PLAN", { status: "working", attempt: 2 }));
    expect(s.tasks.PLAN.notes).toEqual([]);
    expect(s.tasks.PLAN.started).toBe(1); // the timer counts from the first try
  });
});

describe("integration without a failed screen", () => {
  it("says so in the feed and leaves the card's status alone", () => {
    const plan = { project: "x", contracts: [], tasks: [{ id: "T3", title: "Owner screens", module: "src/components/O.tsx", spec: "", depends_on: [] }] };
    let s = reduce(initialState(), ev(0, "plan_ready", null, { plan }));
    s = reduce(s, ev(1, "task_queued", "INT", { title: "Integrate", role: "dev", depends_on: [] }));
    s = reduce(s, ev(2, "task_status", "INT", { status: "without", missing: ["T3"] }));
    expect(s.tasks.INT.status).toBe("queued");
    expect(s.feed.at(-1)!.text).toContain("without Owner screens");
    expect(s.feed.at(-1)!.tone).toBe("warn");
  });
});

describe("durable preview database (docs/databases.md)", () => {
  const finished = () => reduce(initialState(), ev(0, "project_finished", null, { status: "done" }));

  it("database_ready marks the project durable and the preview message stops saying data resets", () => {
    let s = reduce(finished(), ev(1, "database_ready", null, { name: "app_studio_x_abc123" }));
    expect(s.durable_db).toBe(true);
    expect(s.feed.at(-1)).toMatchObject({ channel: "build", tone: "good" });
    expect(s.feed.at(-1)!.text).toContain("app_studio_x_abc123");
    s = reduce(s, ev(2, "preview_ready", null, { url: "https://studio-x.vercel.app" }));
    expect(s.feed.at(-1)!.text).not.toContain("resets");
    expect(s.feed.at(-1)!.text).toContain("kept");
    const n = s.feed.length;
    s = reduce(s, ev(3, "database_ready", null, { name: "app_studio_x_abc123" }));   // a later deploy: no repeat
    expect(s.feed.length).toBe(n);
  });

  it("database_failed warns and leaves the project in local mode", () => {
    let s = reduce(finished(), ev(1, "database_failed", null, { reason: "OperationalError: timeout" }));
    expect(s.durable_db).toBe(false);
    expect(s.feed.at(-1)).toMatchObject({ channel: "build", tone: "warn" });
    expect(s.feed.at(-1)!.text).toContain("timeout");
    expect(s.feed.at(-1)!.text).toContain("resets");
    s = reduce(s, ev(2, "preview_ready", null, { url: "https://studio-x.vercel.app" }));
    expect(s.feed.at(-1)!.text).toContain("preview data resets");
  });

  it("a failure after a database exists keeps it durable", () => {
    let s = reduce(finished(), ev(1, "database_ready", null, { name: "app_x" }));
    s = reduce(s, ev(2, "database_failed", null, { reason: "timeout" }));
    expect(s.durable_db).toBe(true);
    expect(s.feed.at(-1)!.text).toContain("keeps using");
  });
});

describe("a run the worker refused to start", () => {
  it("is failed, and the feed says why", () => {
    const s = reduce(initialState(), ev(0, "project_finished", null,
      { status: "failed", reason: "this project's own Anthropic API key can't be used: STUDIO_KEY_SECRET changed" }));
    expect(s.status).toBe("failed");
    expect(s.feed.at(-1)!.text).toBe("The run couldn't start: this project's own Anthropic API key can't be used: STUDIO_KEY_SECRET changed");
  });
});
