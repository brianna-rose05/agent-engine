import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkAnthropicKey, decryptKey, encryptKey, keyForWorker, keyLabel, keySecretProblem, maskKey } from "../convex/apiKey";
import * as projectKeys from "../convex/projectKeys";
import * as projects from "../convex/projects";
import * as settings from "../convex/settings";
import { projectForWorker } from "../convex/engine";
import { fakeCtx, type AnyFn } from "./fake-db";

const KEY = `sk-ant-api03-${"Q".repeat(80)}abcd`;      // shaped like a key; not a real one
const SECRET = "x".repeat(16) + "studio-test-secret-0123456789";

describe("Anthropic API key rules", () => {
  it("accepts a key that starts with sk-ant- and is long enough", () => {
    expect(checkAnthropicKey(`  ${KEY}\n`)).toEqual({ ok: true, key: KEY });
    const bad = ["", "   ", `sk-${"a".repeat(60)}`, "sk-ant-short", `sk-ant-${"a".repeat(300)}`, `sk-ant-api03 ${"a".repeat(60)}`,
                 `"${KEY}"`, `sk-ant-${"a".repeat(40)}$`, 12, null];
    for (const k of bad) expect(checkAnthropicKey(k).ok, String(k)).toBe(false);
  });
  it("never repeats the key in a message", () => {
    const r = checkAnthropicKey(`sk-ant-${"z".repeat(40)}!`);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("zzzz");
  });
  it("is shown only as its last 4 characters", () => {
    expect(maskKey(KEY)).toBe("…abcd");
    expect(keyLabel({ own: true, last4: "abcd" })).toBe("Your key …abcd");
    expect(keyLabel({ own: false, last4: null })).toBe("Studio's key");
  });
  it("needs STUDIO_KEY_SECRET, long enough, before anything is stored", () => {
    expect(keySecretProblem(undefined)).toMatch(/STUDIO_KEY_SECRET environment variable isn't set in Convex/);
    expect(keySecretProblem("short")).toMatch(/too short/);
    expect(keySecretProblem(SECRET)).toBeNull();
  });
});

describe("encryption at rest (AES-GCM, Web Crypto)", () => {
  it("round-trips, with a fresh IV each time and nothing readable in the stored value", async () => {
    const a = await encryptKey(KEY, SECRET, "p1");
    const b = await encryptKey(KEY, SECRET, "p1");
    expect(a).toMatch(/^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain("QQQQ");
    expect(await decryptKey(a, SECRET, "p1")).toBe(KEY);
    expect(await decryptKey(b, SECRET, "p1")).toBe(KEY);
  });
  it("can't be read with another secret, on another project, or once damaged", async () => {
    const s = await encryptKey(KEY, SECRET, "p1");
    expect(await decryptKey(s, `${SECRET}!`, "p1")).toBeNull();
    expect(await decryptKey(s, SECRET, "p2")).toBeNull();
    const [v, iv, ct] = s.split(".");
    const flipped = ct[5] === "A" ? "B" : "A";
    expect(await decryptKey(`${v}.${iv}.${ct.slice(0, 5)}${flipped}${ct.slice(6)}`, SECRET, "p1")).toBeNull();
    expect(await decryptKey("garbage", SECRET, "p1")).toBeNull();
  });
  it("keyForWorker: the key, a plain reason it can't be used, or nothing", async () => {
    const enc = await encryptKey(KEY, SECRET, "p1");
    expect(await keyForWorker({}, "p1", SECRET)).toEqual({});
    expect(await keyForWorker({ anthropicKeyEnc: enc }, "p1", SECRET)).toEqual({ anthropicKey: KEY });
    expect((await keyForWorker({ anthropicKeyEnc: enc }, "p1", undefined)).anthropicKeyProblem).toMatch(/STUDIO_KEY_SECRET/);
    expect((await keyForWorker({ anthropicKeyEnc: enc }, "p1", `${SECRET}?`)).anthropicKeyProblem).toMatch(/can't be decrypted/);
  });
});

describe("project key functions", () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.OWNER_PASSPHRASE = "pass";
    process.env.ENGINE_SECRET = "engine";
    process.env.STUDIO_KEY_SECRET = SECRET;
  });
  afterEach(() => { process.env = { ...env }; });

  const functions: Record<string, AnyFn> = { "projectKeys:store": projectKeys.store };
  const setup = () => fakeCtx({ projects: [{ _id: "p1", name: "Pawfect", description: "d", model: "haiku", status: "done",
                                             costUsd: 0.5, budgetUsd: 10 }] }, functions);
  const save = (f: ReturnType<typeof setup>, args: Record<string, unknown> = {}) =>
    (projectKeys.set as AnyFn)._handler(f.actionCtx, { key: "pass", id: "p1", apiKey: KEY, ...args });

  it("refuses to save without STUDIO_KEY_SECRET, in plain English", async () => {
    delete process.env.STUDIO_KEY_SECRET;
    const f = setup();
    await expect(save(f)).rejects.toMatchObject({ data: expect.stringMatching(/STUDIO_KEY_SECRET environment variable isn't set/) });
    expect(f.tables.projects[0].anthropicKeyEnc).toBeUndefined();
  });

  it("is owner-only and checks the key before storing it", async () => {
    const f = setup();
    await expect(save(f, { key: "wrong" })).rejects.toThrow();
    await expect(save(f, { apiKey: "sk-nope" })).rejects.toMatchObject({ data: expect.stringMatching(/start with sk-ant-/) });
    await expect((projectKeys.remove as AnyFn)._handler(f.ctx, { key: "wrong", id: "p1" })).rejects.toThrow();
    expect(f.tables.projects[0].anthropicKeyEnc).toBeUndefined();
  });

  it("stores it encrypted, shows only the last 4, gives it to the worker only, and removes it", async () => {
    const f = setup();
    expect(await save(f)).toEqual({ last4: "abcd" });
    const row = f.tables.projects[0];
    expect(String(row.anthropicKeyEnc)).not.toContain(KEY);
    expect(await decryptKey(String(row.anthropicKeyEnc), SECRET, "p1")).toBe(KEY);

    // everything the app can read: no key, no ciphertext
    const status = await (projectKeys.status as AnyFn)._handler(f.ctx, { key: "pass", id: "p1" });
    expect(status).toEqual({ own: true, last4: "abcd", problem: null });
    const clientFacing = [
      status,
      await (projects.get as AnyFn)._handler(f.ctx, { key: "pass", id: "p1" }),
      await (projects.list as AnyFn)._handler(f.ctx, { key: "pass" }),
      await (settings.get as AnyFn)._handler(f.ctx, { key: "pass" }),
    ];
    for (const out of clientFacing) {
      const json = JSON.stringify(out);
      expect(json).not.toContain(KEY);
      expect(json).not.toContain("QQQQQQQQ");
      expect(json).not.toContain(String(row.anthropicKeyEnc));
      expect(json).not.toContain("anthropicKeyEnc");
    }

    // the worker (ENGINE_SECRET) gets it decrypted; nobody else can call that query
    expect(await (projectForWorker as AnyFn)._handler(f.ctx, { secret: "engine", projectId: "p1" }))
      .toMatchObject({ anthropicKey: KEY, name: "Pawfect" });
    await expect((projectForWorker as AnyFn)._handler(f.ctx, { secret: "pass", projectId: "p1" })).rejects.toThrow();

    await (projectKeys.remove as AnyFn)._handler(f.ctx, { key: "pass", id: "p1" });
    expect(await (projectKeys.status as AnyFn)._handler(f.ctx, { key: "pass", id: "p1" })).toEqual({ own: false, last4: null, problem: null });
    const worker = await (projectForWorker as AnyFn)._handler(f.ctx, { secret: "engine", projectId: "p1" });
    expect(worker.anthropicKey).toBeUndefined();
    expect(worker.anthropicKeyProblem).toBeUndefined();
  });
});
