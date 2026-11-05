/*
 * Comment pins on the preview (src/app/p/[id]/preview): the math and the checks the page needs, as pure functions.
 * The rules for storing and sending pins are in convex/comments.ts.
 */
import { isPagePath, type Comment, type Viewport } from "../../convex/comments";

export const PHONE_WIDTH = 390;
export const PHONE_HEIGHT = 844;

type Rect = { left: number; top: number; width: number; height: number };

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** Where a click on the overlay lands, as fractions (0..1) of the preview frame's width and height. */
export function pinFromClick(clientX: number, clientY: number, rect: Rect): { x: number; y: number } | null {
  if (!(rect.width > 0 && rect.height > 0)) return null;
  return { x: round4(clamp01((clientX - rect.left) / rect.width)), y: round4(clamp01((clientY - rect.top) / rect.height)) };
}

/** A pin's place in the frame as CSS percentages (the overlay is exactly the frame's size). */
export const pinStyle = (pin: { x: number; y: number }) => ({ left: `${pin.x * 100}%`, top: `${pin.y * 100}%` });

/**
 * Where a pin's note popover goes so it stays inside the frame (the phone frame is only 390px wide): `left` in pixels
 * from the frame's left edge, centered on the pin when there is room, and above the pin in the lower part of the frame.
 */
export function popoverPlacement(pin: { x: number; y: number }, frameWidth: number, popWidth: number, margin = 8):
  { left: number; width: number; vertical: "above" | "below" } {
  const width = Math.max(0, Math.min(popWidth, frameWidth - 2 * margin));
  const centered = pin.x * frameWidth - width / 2;
  const left = Math.round(Math.min(Math.max(margin, centered), Math.max(margin, frameWidth - margin - width)));
  return { left, width, vertical: pin.y > 0.6 ? "above" : "below" };
}

/** "/tools/" and "/tools" are the same page; "/" stays "/". */
export const samePath = (a: string, b: string) => (a.replace(/\/+$/, "") || "/") === (b.replace(/\/+$/, "") || "/");

/** Pins drawn on the frame right now: those on this page, dropped in this width. Every pin is still listed. */
export const pinsOnScreen = (pins: Comment[], path: string, viewport: Viewport) =>
  pins.filter((p) => samePath(p.path, path) && p.viewport === viewport);

/** The origin of the preview (https only, or http on localhost), or null when it isn't a usable address. */
export function previewOrigin(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol !== "https:" && !(local && u.protocol === "http:")) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** The page path of an address: the path the preview opens at. */
export function pathOf(url: string): string {
  try {
    const p = new URL(url).pathname;
    return isPagePath(p) ? p : "/";
  } catch {
    return "/";
  }
}

/** The preview address for a page of the app (same origin as the preview; the path is a checked page path). */
export function pageUrl(preview: string, path: string): string {
  const origin = previewOrigin(preview);
  if (!origin) return preview;
  return origin + (isPagePath(path) ? path : "/");
}

/**
 * The page path a message from the preview frame reports, or null. Only messages from the preview's own origin count
 * (the template's StudioBridge, src/lib/studio-bridge.tsx), and only `{type: "studio:path", path: "/..."}`.
 */
export function bridgePath(event: { origin: string; data: unknown }, expectedOrigin: string | null): string | null {
  if (!expectedOrigin || event.origin !== expectedOrigin) return null;
  const d = event.data as { type?: unknown; path?: unknown } | null;
  if (!d || typeof d !== "object" || d.type !== "studio:path") return null;
  return isPagePath(d.path) ? d.path : null;
}

/** What a pin's status says in the list. */
export function pinStatus(c: Pick<Comment, "status" | "sentAs">): string {
  if (c.status === "resolved") return "Resolved";
  if (c.status === "sent") return c.sentAs ? (c.sentAs.kind === "quick" ? `Sent · quick ${c.sentAs.n}` : `Sent · change ${c.sentAs.n}`) : "Sent";
  return "Open";
}
