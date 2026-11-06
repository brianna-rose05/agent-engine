import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkSlackWebhook, claim, finish, maskWebhook, post, postToSlack, slackText } from "../convex/slack";
import { notifyFor } from "../convex/notifications";
import * as settings from "../convex/settings";
import { fakeCtx, type AnyFn } from "./fake-db";

const HOOK = "https://hooks.slack.com/services/T0000AAAA/B0000BBBB/abcdefghijklmnopWXYZ";

describe("Slack webhook URL", () => {
  it("accepts only https://hooks.slack.com/services/…/…/…", () => {
    expect(checkSlackWebhook(` ${HOOK} `)).toEqual({ ok: true, url: HOOK });
    for (const bad of ["", "   ", HOOK.replace("https", "http"), "https://hooks.slack.com/workflows/T1/B2/c3",
                       "https://hooks.slack.com.evil.example/services/T1/B2/c3", "https://evil.example/https://hooks.slack.com/services/T1/B2/c3",
                       `${HOOK}?x=1`, `${HOOK}#x`, `${HOOK}/extra`, "https://hooks.slack.com/services/T1/B2",
                       "https://user:pw@hooks.slack.com/services/T1/B2/c3", "https://hooks.slack.com:8443/services/T1/B2/c3",
                       "https://hooks.slack.com/services/T1/B2/c3%2F..", `${HOOK}${"a".repeat(300)}`, 42, null]) {
      expect(checkSlackWebhook(bad).ok, String(bad)).toBe(false);
    }
  });
  it("is shown only as its last 4 characters", () => {
    expect(maskWebhook(HOOK)).toBe("…/WXYZ");
  });
});

describe("Slack message", () => {
  it("is plain text with the project's name and a link to its Studio page", () => {
    const t = slackText({ kind: "ready_to_ship", title: "Pawfect: ready to ship", body: "Every Must feature passes." },
                        "Pawfect", "p1", "https://studio.example/");
    expect(t).toBe("Pawfect: ready to ship\nEvery Must feature passes.\nOpen in Studio: https://studio.example/p/p1/ship");
    const plan = slackText({ kind: "needs_approval", title: "A plan <b>&</b>", body: "x" }, "Pawfect", "p1", undefined);
    expect(plan).toBe("Pawfect: A plan &lt;b&gt;&amp;&lt;/b&gt;\nx\nIn Studio: /p/p1/plan");     // name added, markup escaped
  });
});

describe("posting to Slack", () => {
  it("never throws, and errors never contain the webhook", async () => {
    const echo = vi.fn(async () => ({ ok: false, status: 404, text: async () => `no_service for ${HOOK}` }));
    const r = await postToSlack(echo, HOOK, "hi");
    expect(r).toEqual({ ok: false, error: "Slack answered HTTP 404 (no_service for …)" });
    const down = await postToSlack(async () => { throw new TypeError(`fetch failed ${HOOK}`); }, HOOK, "hi");
    expect(down.ok).toBe(false);
    expect(JSON.stringify(down)).not.toContain(HOOK);
    expect(echo).toHaveBeenCalledWith(HOOK, expect.objectContaining({ method: "POST", body: JSON.stringify({ text: "hi" }) }));
  });
});

// every engine event that makes a notification, one per notification kind (convex/notifications.ts notificationFor)
const EVENTS: [string, Record<string, unknown>][] = [
  ["plan_ready", {}], ["change_plan_ready", { n: 2 }], ["project_finished", { status: "done" }],
  ["project_finished", { status: "failed" }], ["project_finished", { status: "stopped" }],
  ["budget_reached", { spent: 5.02, budget: 5 }], ["escalated", { question: "Which time zone?" }],
  ["ready_to_ship", { saved: [] }], ["preview_ready", { url: "https://x.vercel.app" }],
];

describe("every notification is posted to Slack once", () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.APP_URL = "https://studio.example";
    delete process.env.RESEND_API_KEY;
  });
  afterEach(() => {
    process.env = { ...env };
    vi.unstubAllGlobals();
  });
  const functions: Record<string, AnyFn> = { "slack:claim": claim, "slack:finish": finish, "settings:webhook": settings.webhook };

  const setup = (webhook: string | null) => fakeCtx({
    projects: [{ _id: "p1", name: "Pawfect", status: "building" }],
    settings: webhook ? [{ slackWebhookUrl: webhook, updatedAt: 1 }] : [],
  }, functions);

  it("each kind: one post, with the project and a link; running a post again sends nothing", async () => {
    const f = setup(HOOK);
    type Res = { ok: boolean; status: number; text: () => Promise<string> };
    const fetchFn = vi.fn<(url: string, init: RequestInit) => Promise<Res>>(async () => ({ ok: true, status: 200, text: async () => "ok" }));
    vi.stubGlobal("fetch", fetchFn);
    for (const [kind, data] of EVENTS) await notifyFor(f.ctx as AnyFn, "p1" as AnyFn, "Pawfect", kind, data);
    const posts = f.scheduled.filter((s) => s.name === "slack:post");
    expect(posts).toHaveLength(EVENTS.length);
    for (const p of posts) await (post as AnyFn)._handler(f.actionCtx, p.args);
    for (const p of posts) await (post as AnyFn)._handler(f.actionCtx, p.args);      // a repeat: no second post
    expect(fetchFn).toHaveBeenCalledTimes(EVENTS.length);
    const notes = f.tables.notifications;
    expect(new Set(notes.map((n) => n.kind))).toEqual(
      new Set(["needs_approval", "finished", "budget_reached", "needs_you", "ready_to_ship", "preview_ready"]));
    expect(notes.every((n) => (n.slack as { status: string }).status === "sent")).toBe(true);
    const texts = fetchFn.mock.calls.map(([url, init]) => {
      expect(url).toBe(HOOK);
      return JSON.parse(String(init.body)).text as string;
    });
    expect(texts.every((t) => t.includes("Pawfect") && t.includes("https://studio.example/p/p1/"))).toBe(true);
    expect(texts[0]).toContain("/p/p1/plan");
  });

  it("nothing is scheduled without a webhook", async () => {
    const f = setup(null);
    for (const [kind, data] of EVENTS) await notifyFor(f.ctx as AnyFn, "p1" as AnyFn, "Pawfect", kind, data);
    expect(f.tables.notifications).toHaveLength(EVENTS.length);
    expect(f.scheduled.filter((s) => s.name === "slack:post")).toHaveLength(0);
  });

  it("a Slack failure is recorded on the notification, never thrown, and not retried", async () => {
    const f = setup(HOOK);
    const fetchFn = vi.fn(async () => ({ ok: false, status: 500, text: async () => "internal_error" }));
    vi.stubGlobal("fetch", fetchFn);
    await notifyFor(f.ctx as AnyFn, "p1" as AnyFn, "Pawfect", "plan_ready", {});
    const [p] = f.scheduled;
    await expect((post as AnyFn)._handler(f.actionCtx, p.args)).resolves.toBeUndefined();
    await (post as AnyFn)._handler(f.actionCtx, p.args);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(f.tables.notifications[0].slack).toMatchObject({ status: "failed", error: "Slack answered HTTP 500 (internal_error)" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    await notifyFor(f.ctx as AnyFn, "p1" as AnyFn, "Pawfect", "ready_to_ship", { saved: [] });
    await expect((post as AnyFn)._handler(f.actionCtx, f.scheduled[1].args)).resolves.toBeUndefined();
    expect(f.tables.notifications[1].slack).toMatchObject({ status: "failed" });
  });

  it("a webhook removed before the post: skipped, nothing sent", async () => {
    const f = setup(HOOK);
    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);
    await notifyFor(f.ctx as AnyFn, "p1" as AnyFn, "Pawfect", "plan_ready", {});
    delete f.tables.settings[0].slackWebhookUrl;
    await (post as AnyFn)._handler(f.actionCtx, f.scheduled[0].args);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(f.tables.notifications[0].slack).toMatchObject({ status: "skipped" });
  });
});

describe("Slack settings (owner only, the URL never comes back)", () => {
  const env = { ...process.env };
  beforeEach(() => { process.env.OWNER_PASSPHRASE = "pass"; });
  afterEach(() => {
    process.env = { ...env };
    vi.unstubAllGlobals();
  });
  const functions: Record<string, AnyFn> = { "settings:webhook": settings.webhook };

  it("saves, masks, tests and removes the webhook", async () => {
    const f = fakeCtx({}, functions);
    const run = (fn: AnyFn, args: Record<string, unknown> = {}) => fn._handler(f.ctx, { key: "pass", ...args });
    await expect(run(settings.setSlackWebhook, { key: "wrong", url: HOOK })).rejects.toThrow();
    await expect(run(settings.setSlackWebhook, { url: "https://example.com/x" })).rejects.toThrow();
    expect(await run(settings.setSlackWebhook, { url: HOOK })).toEqual({ masked: "…/WXYZ" });
    const shown = await run(settings.get);
    expect(shown.slack).toEqual({ masked: "…/WXYZ" });
    expect(JSON.stringify(shown)).not.toContain("abcdefghijklmnop");
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, text: async () => "ok" }));
    vi.stubGlobal("fetch", fetchFn);
    expect(await (settings.testSlack as AnyFn)._handler(f.actionCtx, { key: "pass" })).toMatchObject({ ok: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await run(settings.removeSlackWebhook);
    expect((await run(settings.get)).slack).toBeNull();
    expect(await (settings.testSlack as AnyFn)._handler(f.actionCtx, { key: "pass" })).toEqual({ ok: false, message: "Save a webhook URL first." });
  });
});
