import { describe, expect, it } from "vitest";
import { gateView } from "../src/lib/gate";

describe("sign-in gate", () => {
  it("never flashes the sign-in form while a saved sign-in is read or checked (regression, Nov 6)", () => {
    expect(gateView({ ready: false, state: "none", key: null, restored: null })).toBe("wait");
    expect(gateView({ ready: true, state: "checking", key: "sst_a", restored: "sst_a" })).toBe("wait");
    expect(gateView({ ready: true, state: "ok", key: "sst_a", restored: "sst_a" })).toBe("app");
  });
  it("shows the form when there is no saved sign-in, it ended, or a typed key is being checked", () => {
    expect(gateView({ ready: true, state: "none", key: null, restored: null })).toBe("form");
    expect(gateView({ ready: true, state: "wrong", key: "sst_a", restored: "sst_a" })).toBe("form");
    expect(gateView({ ready: true, state: "checking", key: "typed", restored: null })).toBe("form");
  });
});
