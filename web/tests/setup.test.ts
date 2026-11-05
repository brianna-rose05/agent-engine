import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SETUP_ALPHABET, isSetupCode, makeSetupCode, missingSetupCodes, newSetupCodes, ownerSetupUrl, setupCodesForWorker,
} from "../convex/setup";
import { ensureSetupCodes } from "../convex/projects";

describe("setup codes", () => {
  it("are 3 groups of 4 from an alphabet without 0/O/1/I/L", () => {
    for (const ch of "0O1IL") expect(SETUP_ALPHABET).not.toContain(ch);
    for (let i = 0; i < 200; i++) {
      const c = makeSetupCode();
      expect(c).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      for (const ch of c.replace(/-/g, "")) expect(SETUP_ALPHABET).toContain(ch);
      expect(isSetupCode(c)).toBe(true);
    }
  });
  it("are unique across many draws", () => {
    const seen = new Set(Array.from({ length: 5000 }, () => makeSetupCode()));
    expect(seen.size).toBe(5000);
  });
  it("skip biased bytes (rejection sampling) and use the random source", () => {
    // 255 is above the unbiased limit and must be skipped; 0 maps to the first letter
    const bytes = (out: Uint8Array) => out.fill(0).map((_, i) => (i % 2 ? 255 : 0));
    expect(makeSetupCode(bytes)).toBe("2222-2222-2222");
  });
  it("rejects malformed codes", () => {
    for (const bad of ["", "K7PQM2XR9TVD", "k7pq-m2xr-9tvd", "K7PQ-M2XR-9TV0", "K7PQ-M2XR-9TVDX", 42, null]) {
      expect(isSetupCode(bad)).toBe(false);
    }
  });
  it("new projects get two different codes", () => {
    const c = newSetupCodes();
    expect(isSetupCode(c.preview) && isSetupCode(c.production)).toBe(true);
    expect(c.preview).not.toBe(c.production);
  });
  it("fills only what's missing and keeps existing codes", () => {
    expect(missingSetupCodes({ preview: "K7PQ-M2XR-9TVD", production: "ABCD-EFGH-JKMN" })).toBeNull();
    const filled = missingSetupCodes({ preview: "K7PQ-M2XR-9TVD" })!;
    expect(filled.preview).toBe("K7PQ-M2XR-9TVD");
    expect(isSetupCode(filled.production)).toBe(true);
    const fixed = missingSetupCodes({ preview: "oops", production: "ABCD-EFGH-JKMN" })!;
    expect(isSetupCode(fixed.preview)).toBe(true);
    expect(fixed.production).toBe("ABCD-EFGH-JKMN");
  });
  it("the worker gets only well-formed codes", () => {
    expect(setupCodesForWorker(undefined)).toEqual({});
    expect(setupCodesForWorker({ preview: "K7PQ-M2XR-9TVD", production: "nope" })).toEqual({ preview: "K7PQ-M2XR-9TVD" });
  });
  it("builds the owner setup address", () => {
    expect(ownerSetupUrl("https://x.vercel.app/")).toBe("https://x.vercel.app/owner-setup");
    expect(ownerSetupUrl("https://x.vercel.app")).toBe("https://x.vercel.app/owner-setup");
  });
});

describe("ensureSetupCodes", () => {
  const saved = process.env.OWNER_PASSPHRASE;
  beforeEach(() => { process.env.OWNER_PASSPHRASE = "pass"; });
  afterEach(() => { process.env.OWNER_PASSPHRASE = saved; });

  // A one-row stand-in for ctx.db: what the mutation reads and writes.
  function fakeCtx(row: Record<string, unknown> | null) {
    const patches: Record<string, unknown>[] = [];
    const db = {
      normalizeId: (_t: string, id: string) => (id === "p1" ? id : null),
      get: async () => row,
      patch: async (_id: string, p: Record<string, unknown>) => { patches.push(p); if (row) Object.assign(row, p); },
    };
    return { ctx: { db }, patches };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const run = (ctx: unknown, args: { key: string; id: string }) => (ensureSetupCodes as any)._handler(ctx, args);

  it("gives an old project codes once, then leaves them alone", async () => {
    const row: Record<string, unknown> = { name: "Pawfect" };
    const { ctx, patches } = fakeCtx(row);
    await run(ctx, { key: "pass", id: "p1" });
    const first = row.setupCodes as { preview: string; production: string };
    expect(isSetupCode(first.preview) && isSetupCode(first.production)).toBe(true);
    await run(ctx, { key: "pass", id: "p1" });
    await run(ctx, { key: "pass", id: "p1" });
    expect(patches).toHaveLength(1);
    expect(row.setupCodes).toEqual(first);
  });
  it("adds only the missing one", async () => {
    const row: Record<string, unknown> = { setupCodes: { preview: "K7PQ-M2XR-9TVD" } };
    const { ctx } = fakeCtx(row);
    await run(ctx, { key: "pass", id: "p1" });
    expect((row.setupCodes as { preview: string }).preview).toBe("K7PQ-M2XR-9TVD");
    expect(isSetupCode((row.setupCodes as { production: string }).production)).toBe(true);
  });
  it("needs the owner passphrase and ignores unknown projects", async () => {
    const { ctx, patches } = fakeCtx({});
    await expect(run(ctx, { key: "wrong", id: "p1" })).rejects.toThrow();
    await run(ctx, { key: "pass", id: "nope" });
    expect(patches).toHaveLength(0);
  });
});
