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
