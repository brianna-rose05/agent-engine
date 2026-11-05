import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  COMMENT_TEXT_MAX, checkPin, isCopyOrStyle, isPagePath, markSent, nextCommentNumber, pinsToSend, requestText, suggestSendAs,
  add, remove, resolve, sendComments, update, type Comment,
} from "../convex/comments";
import { requestQuickChange } from "../convex/quick";
import { requestChange } from "../convex/projects";
import { QUICK_TEXT_MAX } from "../convex/quick";
import {
  bridgePath, pageUrl, pathOf, pinFromClick, pinStatus, pinStyle, pinsOnScreen, popoverPlacement, previewOrigin, samePath,
} from "../src/lib/pins";

const pin = (n: number, text: string, extra: Partial<Comment> = {}): Comment =>
  ({ n, path: "/", pathKnown: true, x: 0.5, y: 0.5, viewport: "desktop", text, at: n, status: "open", ...extra });

describe("pin coordinates", () => {
  const rect = { left: 100, top: 50, width: 400, height: 200 };
  it("are fractions of the frame, rounded and kept inside it", () => {
    expect(pinFromClick(300, 150, rect)).toEqual({ x: 0.5, y: 0.5 });
    expect(pinFromClick(100, 50, rect)).toEqual({ x: 0, y: 0 });
    expect(pinFromClick(133.33, 116.666, rect)).toEqual({ x: 0.0833, y: 0.3333 });
    expect(pinFromClick(10, 999, rect)).toEqual({ x: 0, y: 1 });          // a click on the border clamps
    expect(pinFromClick(1, 1, { ...rect, width: 0 })).toBeNull();
  });
  it("draw back at the same spot, whatever size the frame is now", () => {
    expect(pinStyle({ x: 0.25, y: 0.9 })).toEqual({ left: "25%", top: "90%" });
  });
  it("open their note inside the frame, even on a phone", () => {
    expect(popoverPlacement({ x: 0.5, y: 0.1 }, 1000, 256)).toEqual({ left: 372, width: 256, vertical: "below" });
    expect(popoverPlacement({ x: 0.01, y: 0.9 }, 1000, 256)).toEqual({ left: 8, width: 256, vertical: "above" });
    expect(popoverPlacement({ x: 0.99, y: 0.5 }, 1000, 256)).toEqual({ left: 736, width: 256, vertical: "below" });
    expect(popoverPlacement({ x: 0.9, y: 0.5 }, 390, 256)).toEqual({ left: 126, width: 256, vertical: "below" });  // 126 + 256 = 390 - 8
    expect(popoverPlacement({ x: 0.5, y: 0.5 }, 200, 256)).toEqual({ left: 8, width: 184, vertical: "below" });   // narrower than the note
  });
  it("are drawn only on their page and width, and every pin is still listed", () => {
    const pins = [pin(1, "a", { path: "/tools" }), pin(2, "b", { path: "/tools/", viewport: "phone" }), pin(3, "c", { path: "/" })];
    expect(pinsOnScreen(pins, "/tools", "desktop").map((p) => p.n)).toEqual([1]);
    expect(pinsOnScreen(pins, "/tools", "phone").map((p) => p.n)).toEqual([2]);
    expect(samePath("/", "/")).toBe(true);
    expect(samePath("/tools/", "/tools")).toBe(true);
    expect(samePath("/tools", "/tool")).toBe(false);
  });
});

describe("messages from the preview", () => {
  const origin = "https://pawfect-abc.vercel.app";
  it("count only from the preview's origin, with the bridge's shape", () => {
    expect(bridgePath({ origin, data: { type: "studio:path", path: "/tools" } }, origin)).toBe("/tools");
    expect(bridgePath({ origin: "https://evil.example", data: { type: "studio:path", path: "/tools" } }, origin)).toBeNull();
    expect(bridgePath({ origin: "https://pawfect-abc.vercel.app.evil.example", data: { type: "studio:path", path: "/x" } }, origin)).toBeNull();
    expect(bridgePath({ origin, data: { type: "studio:path", path: "/tools" } }, null)).toBeNull();
    expect(bridgePath({ origin, data: { type: "other", path: "/tools" } }, origin)).toBeNull();
    expect(bridgePath({ origin, data: "studio:path /tools" }, origin)).toBeNull();
    expect(bridgePath({ origin, data: null }, origin)).toBeNull();
  });
  it("must carry a page path, not an address or a script", () => {
    for (const bad of ["//evil.example/x", "https://evil.example", "javascript:alert(1)", "/a b", "/a?token=1", "", 7, "/" + "x".repeat(400)]) {
      expect(bridgePath({ origin, data: { type: "studio:path", path: bad } }, origin)).toBeNull();
    }
  });
  it("the preview's origin is https (or a local http server)", () => {
    expect(previewOrigin("https://pawfect-abc.vercel.app/some/page")).toBe(origin);
    expect(previewOrigin("http://localhost:3000/")).toBe("http://localhost:3000");
    expect(previewOrigin("http://pawfect.example")).toBeNull();
    expect(previewOrigin("javascript:alert(1)")).toBeNull();
    expect(previewOrigin("not a url")).toBeNull();
    expect(previewOrigin(null)).toBeNull();
  });
  it("opens a page of the app on the preview's origin only", () => {
    expect(pageUrl("https://pawfect-abc.vercel.app/", "/tools")).toBe(`${origin}/tools`);
    expect(pageUrl("https://pawfect-abc.vercel.app/", "//evil.example")).toBe(`${origin}/`);
    expect(pathOf("https://pawfect-abc.vercel.app/book")).toBe("/book");
    expect(pathOf("https://pawfect-abc.vercel.app")).toBe("/");
    expect(pathOf("nope")).toBe("/");
  });
});

describe("pins", () => {
  it("are checked before they are kept", () => {
    const ok = checkPin({ path: "/tools", pathKnown: true, x: 0.123456, y: 1, viewport: "phone", text: "  Bigger title  " });
    expect(ok).toEqual({ ok: true, pin: { path: "/tools", pathKnown: true, x: 0.1235, y: 1, viewport: "phone", text: "Bigger title" } });
    expect(checkPin({ path: "tools", pathKnown: true, x: 0, y: 0, viewport: "phone", text: "ok ok" }).ok).toBe(false);
    expect(checkPin({ path: "/", pathKnown: true, x: 1.2, y: 0, viewport: "phone", text: "ok ok" }).ok).toBe(false);
    expect(checkPin({ path: "/", pathKnown: true, x: NaN, y: 0, viewport: "phone", text: "ok ok" }).ok).toBe(false);
    expect(checkPin({ path: "/", pathKnown: true, x: 0, y: 0, viewport: "tablet", text: "ok ok" }).ok).toBe(false);
    expect(checkPin({ path: "/", pathKnown: true, x: 0, y: 0, viewport: "phone", text: " " }).ok).toBe(false);
    expect(checkPin({ path: "/", pathKnown: true, x: 0, y: 0, viewport: "phone", text: "x".repeat(COMMENT_TEXT_MAX + 1) }).ok).toBe(false);
    expect(isPagePath("/p/[id]")).toBe(true);
  });
  it("are numbered 1, 2, ... and numbers aren't reused", () => {
    expect(nextCommentNumber(undefined)).toBe(1);
    expect(nextCommentNumber([pin(1, "a"), pin(4, "b")])).toBe(5);
    expect(nextCommentNumber([pin(1, "a")], 6)).toBe(7);                   // pins 2-6 were deleted
  });
  it("say what they were sent as", () => {
    expect(pinStatus({ status: "open" })).toBe("Open");
    expect(pinStatus({ status: "resolved" })).toBe("Resolved");
    expect(pinStatus({ status: "sent", sentAs: { kind: "quick", n: 3 } })).toBe("Sent · quick 3");
    expect(pinStatus({ status: "sent", sentAs: { kind: "change", n: 2 } })).toBe("Sent · change 2");
  });
});

describe("the request built from pins", () => {
  it("has one line per pin, oldest first, with the page and the width", () => {
    const pins = [pin(3, "Make the\nheading   bigger", { path: "/", viewport: "desktop" }),
                  pin(1, "Rename Borrow to Reserve", { path: "/tools", viewport: "phone" })];
    expect(requestText(pins)).toBe("On /tools (phone): Rename Borrow to Reserve\nOn / (desktop): Make the heading bigger");
  });
  it("only open pins of this project can be sent", () => {
    const comments = [pin(1, "a"), pin(2, "b", { status: "sent", sentAs: { kind: "quick", n: 1 } }), pin(3, "c", { status: "resolved" })];
    expect(pinsToSend(comments, [])).toMatchObject({ ok: false });
    expect(pinsToSend(comments, [9])).toEqual({ ok: false, message: "Pin 9 doesn't exist any more." });
    expect(pinsToSend(comments, [1, 2])).toEqual({ ok: false, message: "Pin 2 was already sent." });
    expect(pinsToSend(comments, [3])).toEqual({ ok: false, message: "Pin 3 was already resolved." });
    expect(pinsToSend([pin(2, "b"), pin(1, "a")], [2, 1, 2])).toMatchObject({ ok: true, pins: [{ n: 1 }, { n: 2 }] });
  });
  it("marks exactly the sent pins with the request's number", () => {
    const out = markSent([pin(1, "a"), pin(2, "b")], [2], "change", 4);
    expect(out[0].status).toBe("open");
    expect(out[1]).toMatchObject({ status: "sent", sentAs: { kind: "change", n: 4 } });
  });
});

describe("PM triage: quick change or change request", () => {
  it("suggests a quick change when every note is short wording or style", () => {
    for (const t of ["Rename Borrow to Reserve", "Make this button green", "Typo: recieve", "More spacing between the cards",
                     "Bigger heading", "Center the logo"]) {
      expect(isCopyOrStyle(t), t).toBe(true);
    }
    expect(suggestSendAs([pin(1, "Rename Borrow to Reserve"), pin(2, "Make this button green")])).toBe("quick");
  });
  it("suggests a change request for data, accounts or features, long notes, or nothing selected", () => {
    for (const t of ["Save the pet's breed when booking", "Add a search box for tools", "Let staff cancel bookings",
                     "Send an email when a booking is made", "Only admins should see this button",
                     "This list is wrong", "Rename this " + "and that ".repeat(20)]) {
      expect(isCopyOrStyle(t), t).toBe(false);
    }
    expect(suggestSendAs([pin(1, "Make this button green"), pin(2, "Add a search box for tools")])).toBe("change");
    expect(suggestSendAs([])).toBe("change");
  });
  it("suggests a change request when the request wouldn't fit a quick change", () => {
    const many = Array.from({ length: 20 }, (_, i) => pin(i + 1, "Make this button green and bigger please", { path: "/tools/library" }));
    expect(requestText(many).length).toBeGreaterThan(QUICK_TEXT_MAX);
    expect(suggestSendAs(many)).toBe("change");
  });
});

// ------------------------------------------------------------------------------ Convex handlers against a fake row

describe("comment mutations", () => {
  const saved = process.env.OWNER_PASSPHRASE;
  beforeEach(() => { process.env.OWNER_PASSPHRASE = "pass"; });
  afterEach(() => { process.env.OWNER_PASSPHRASE = saved; });

  // A one-row stand-in for ctx.db and the scheduler: what the mutations read and write.
  function fakeCtx(row: Record<string, unknown> | null) {
    const patches: Record<string, unknown>[] = [];
    const scheduled: unknown[] = [];
    const db = {
      get: async (id: string) => (id === "p1" ? row : null),
      patch: async (_id: string, p: Record<string, unknown>) => {
        patches.push(p);
        if (row) for (const [k, v] of Object.entries(p)) { if (v === undefined) delete row[k]; else row[k] = v; }
      },
    };
    return { ctx: { db, scheduler: { runAfter: async (...a: unknown[]) => { scheduled.push(a); } } }, patches, scheduled };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const run = (fn: unknown, ctx: unknown, args: Record<string, unknown>) => (fn as any)._handler(ctx, { key: "pass", id: "p1", ...args });
  const built = () => ({ status: "done", repo: "o/r", plan: { tasks: [] }, costUsd: 0.5, budgetUsd: 10 } as Record<string, unknown>);
  const drop = (ctx: unknown, text: string, extra: Record<string, unknown> = {}) =>
    run(add, ctx, { path: "/tools", pathKnown: true, x: 0.5, y: 0.25, viewport: "phone", text, ...extra });

  it("add, edit, resolve, reopen and delete pins", async () => {
    const row = built();
    const { ctx } = fakeCtx(row);
    expect(await drop(ctx, " Rename Borrow to Reserve ")).toBe(1);
    expect(await drop(ctx, "Bigger heading", { path: "/", pathKnown: false, viewport: "desktop" })).toBe(2);
    const comments = () => row.comments as Comment[];
    expect(comments()[0]).toMatchObject({ n: 1, path: "/tools", pathKnown: true, x: 0.5, y: 0.25, viewport: "phone",
                                          text: "Rename Borrow to Reserve", status: "open" });
    expect(comments()[1].pathKnown).toBe(false);
    await run(update, ctx, { n: 1, text: "Rename Borrow to Reserve, everywhere" });
    expect(comments()[0].text).toBe("Rename Borrow to Reserve, everywhere");
    await run(resolve, ctx, { n: 2, resolved: true });
    expect(comments()[1].status).toBe("resolved");
    await run(resolve, ctx, { n: 2, resolved: false });
    expect(comments()[1].status).toBe("open");
    await run(remove, ctx, { n: 2 });
    expect(comments().map((c) => c.n)).toEqual([1]);
    expect(await drop(ctx, "Another")).toBe(3);                          // numbers aren't reused
  });

  it("need the owner passphrase and a real project, and turn away bad pins", async () => {
    const { ctx, patches } = fakeCtx(built());
    await expect(run(add, ctx, { key: "wrong", path: "/", pathKnown: true, x: 0, y: 0, viewport: "phone", text: "Hello" }))
      .rejects.toThrow();
    await expect(run(add, ctx, { id: "nope", path: "/", pathKnown: true, x: 0, y: 0, viewport: "phone", text: "Hello" }))
      .rejects.toThrow();
    await expect(drop(ctx, "Hello", { x: 2 })).rejects.toThrow();
    await expect(drop(ctx, "Hello", { path: "https://evil.example" })).rejects.toThrow();
    await expect(run(update, ctx, { n: 1, text: "Hello" })).rejects.toThrow("Pin 1 doesn't exist any more.");
    expect(patches).toHaveLength(0);
  });

  it("send open pins as one quick change, through the quick change's own path, and mark them sent", async () => {
    const row = built();
    const { ctx, scheduled } = fakeCtx(row);
    await drop(ctx, "Rename Borrow to Reserve");
    await drop(ctx, "Make this button green", { path: "/", viewport: "desktop" });
    await drop(ctx, "Not this one");
    expect(await run(sendComments, ctx, { commentIds: [2, 1], as: "quick" })).toEqual({ kind: "quick", n: 1 });
    expect(row).toMatchObject({ status: "queued", mode: "quick" });
    expect(row.quicks).toEqual([{ n: 1, at: expect.any(Number),
                                  text: "On /tools (phone): Rename Borrow to Reserve\nOn / (desktop): Make this button green" }]);
    expect(scheduled).toHaveLength(1);
    const comments = row.comments as Comment[];
    expect(comments.map((c) => [c.status, c.sentAs?.n])).toEqual([["sent", 1], ["sent", 1], ["open", undefined]]);
    // sent pins can't be sent, edited, reopened or deleted again
    await expect(run(sendComments, ctx, { commentIds: [1], as: "change" })).rejects.toThrow("Pin 1 was already sent.");
    await expect(run(update, ctx, { n: 1, text: "Changed my mind" })).rejects.toThrow();
    await expect(run(resolve, ctx, { n: 1, resolved: false })).rejects.toThrow();
    await expect(run(remove, ctx, { n: 1 })).rejects.toThrow();
  });

  it("send as a change request, through requestChange's own path", async () => {
    const row = built();
    const { ctx } = fakeCtx(row);
    row.changes = [{ n: 1, text: "earlier", at: 1 }];
    await drop(ctx, "Let staff cancel bookings from this list");
    expect(await run(sendComments, ctx, { commentIds: [1], as: "change" })).toEqual({ kind: "change", n: 2 });
    expect(row).toMatchObject({ status: "queued", mode: "change", changeFrom: "done" });
    expect((row.changes as { text: string }[])[1].text).toBe("On /tools (phone): Let staff cancel bookings from this list");
    expect((row.comments as Comment[])[0]).toMatchObject({ status: "sent", sentAs: { kind: "change", n: 2 } });
  });

  it("follow the same rules as asking directly, and leave the pins open when a rule says no", async () => {
    const cases: [Record<string, unknown>, "quick" | "change"][] = [
      [{ status: "building" }, "quick"],
      [{ status: "building" }, "change"],
      [{ repo: undefined }, "quick"],
      [{ repo: undefined }, "change"],
      [{ costUsd: 10 }, "change"],                                          // the spending limit is reached
      [{ status: "failed", plan: undefined }, "change"],
    ];
    for (const [over, as] of cases) {
      // the same row, asked directly and through pins: the same answer
      const direct = fakeCtx({ ...built(), ...over });
      const fn = as === "quick" ? requestQuickChange : requestChange;
      const directError = await run(fn, direct.ctx, { text: "On /tools (phone): Rename Borrow to Reserve" })
        .then(() => null, (e: { data?: unknown }) => e.data);
      expect(directError, JSON.stringify(over)).toBeTruthy();

      const row = { ...built(), ...over };
      const { ctx, scheduled } = fakeCtx(row);
      row.comments = [pin(1, "Rename Borrow to Reserve", { path: "/tools", viewport: "phone" })];
      const pinError = await run(sendComments, ctx, { commentIds: [1], as }).then(() => null, (e: { data?: unknown }) => e.data);
      expect(pinError).toBe(directError);
      expect((row.comments as Comment[])[0].status).toBe("open");
      expect(scheduled).toHaveLength(0);
    }
  });

  it("a quick change too long for one still says so, and the pins stay open", async () => {
    const row = built();
    const { ctx } = fakeCtx(row);
    row.comments = Array.from({ length: 4 }, (_, i) => pin(i + 1, "x".repeat(300)));
    await expect(run(sendComments, ctx, { commentIds: [1, 2, 3, 4], as: "quick" })).rejects.toThrow();
    expect((row.comments as Comment[]).every((c) => c.status === "open")).toBe(true);
    expect(row.quicks).toBeUndefined();
  });
});
