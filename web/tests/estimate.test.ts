import { describe, expect, it } from "vitest";
import { RATES, budgetFit, estimateBuild, isUiModule, needsIntegration, rangeText } from "../src/lib/estimate";

const server = (n: number) => Array.from({ length: n }, (_, i) => ({ module: `src/server/m${i}.ts` }));
const ui = (n: number) => Array.from({ length: n }, (_, i) => ({ module: `src/components/C${i}.tsx` }));

describe("estimateBuild", () => {
  it("prices a server feature at QA + 1.5 dev tries, plus one review at the high end", () => {
    const e = estimateBuild(server(1), { integration: false });
    expect(e.low).toBeCloseTo(RATES.qa + 1.5 * RATES.devPerTry.low, 1);      // 0.065, shown to the cent
    expect(e.high).toBeCloseTo(RATES.qa + 1.5 * RATES.devPerTry.high + RATES.referee, 2); // 0.22
  });

  it("counts screens at more tries than server modules", () => {
    const s = estimateBuild(server(1), { integration: false });
    const u = estimateBuild(ui(1), { integration: false });
    expect(u.low).toBeGreaterThan(s.low);
    expect(u.high).toBeGreaterThan(s.high);
    expect(u.lines[0].label).toBe("1 screen");
  });

  it("adds the integrator for web apps and the planner when asked", () => {
    const web = estimateBuild([...server(4), ...ui(3)]);
    expect(web.lines.map((l) => l.label)).toEqual(["4 server features", "3 screens", "Putting the app together"]);
    expect(web.low).toBeCloseTo(4 * 0.065 + 3 * (0.02 + 0.06) + 1, 2);
    expect(web.high).toBeCloseTo(4 * 0.22 + 3 * (0.02 + 0.2 + 0.05) + 2, 2);
    const withPlanner = estimateBuild(server(2), { planner: true });
    expect(withPlanner.lines[0]).toEqual({ label: "Planner", low: 0.3, high: 0.5 });
  });

  it("leaves the integrator out of Python projects", () => {
    expect(needsIntegration([{ module: "library.py" }])).toBe(false);
    expect(estimateBuild([{ module: "library.py" }]).lines.map((l) => l.label)).toEqual(["1 server feature"]);
  });

  it("scales a change by its tasks", () => {
    const one = estimateBuild([{ module: "src/server/bookings.ts" }]);
    const three = estimateBuild([...server(3)]);
    expect(three.high - one.high).toBeCloseTo(2 * 0.22, 2);
  });

  it("is zero for nothing to build", () => {
    expect(estimateBuild([], { integration: false })).toEqual({ low: 0, high: 0, lines: [] });
  });

  it("matches the engine's idea of a UI module", () => {
    expect(isUiModule("src/components/Booking.tsx")).toBe(true);
    expect(isUiModule("src/app/page.tsx")).toBe(false);
  });
});

describe("budgetFit and rangeText", () => {
  it("compares the range with what is left of the limit", () => {
    expect(budgetFit({ low: 1, high: 2 }, 0.5, 5)).toBe("ok");
    expect(budgetFit({ low: 1, high: 2 }, 3.5, 5)).toBe("tight");
    expect(budgetFit({ low: 1, high: 2 }, 4.5, 5)).toBe("over");
  });
  it("formats a range", () => {
    expect(rangeText({ low: 1.1, high: 2.8 })).toBe("$1.10–$2.80");
  });
});
