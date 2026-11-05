/*
 * The app side of notifications (convex/notifications.ts writes them): which ones deserve a browser alert, and how
 * old they are. Pure, so it is unit-tested; the bell itself is src/components/Notifications.tsx.
 */

export type NotificationItem = {
  id: string;
  projectId: string;
  kind: string;
  title: string;
  body: string;
  ts: number; // ms since epoch
  read: boolean;
  href: string;
};

/**
 * Unread notifications that arrived after the page had loaded (`seen` holds every id shown so far, so a reload
 * never replays old ones as alerts). Returns them oldest first and adds them to `seen`.
 */
export function freshUnread(seen: Set<string>, items: NotificationItem[], first: boolean): NotificationItem[] {
  const fresh = first ? [] : items.filter((n) => !n.read && !seen.has(n.id));
  for (const n of items) seen.add(n.id);
  return fresh.sort((a, b) => a.ts - b.ts);
}

/** A browser alert only when the owner turned alerts on and isn't looking at the tab (they'd see the bell). */
export const shouldAlert = (permission: string | undefined, hidden: boolean) => permission === "granted" && hidden;

/** "just now", "5 min ago", "3 h ago", "2 d ago" */
export function timeAgo(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

/** The badge on the bell: hidden at 0, capped so it stays one character wide-ish. */
export const badgeText = (unread: number) => (unread <= 0 ? "" : unread > 9 ? "9+" : String(unread));
