import { describe, expect, it } from "vitest";
import { neverStarted, WORKER_START_LIMIT_MS } from "../convex/projects";

describe("a worker run GitHub accepted but never started (regression: Pawfect's change 2, Nov 6)", () => {
  it("fails only the project still starting from that same dispatch", () => {
    expect(neverStarted({ status: "starting", startingSince: 100 }, 100)).toBe(true);
    expect(neverStarted({ status: "planning", startingSince: 100 }, 100)).toBe(false);   // the worker ran
    expect(neverStarted({ status: "starting", startingSince: 200 }, 100)).toBe(false);   // a later run's check decides
    expect(neverStarted(null, 100)).toBe(false);
    expect(WORKER_START_LIMIT_MS).toBeGreaterThanOrEqual(10 * 60_000);                  // GitHub queues can be slow
  });
});
