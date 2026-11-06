"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bell, BellRing } from "lucide-react";
import { useMutation, useQuery } from "convex/react";
import { api, useOwner } from "@/lib/convex";
import { badgeText, freshUnread, shouldAlert, timeAgo, type NotificationItem } from "@/lib/notify";

type Recent = { unread: number; items: NotificationItem[] };

const permissionNow = () => (typeof Notification === "undefined" ? undefined : Notification.permission);

/**
 * The bell in the sidebar: unread count, a dropdown of recent notifications linking to their project, and browser
 * alerts while the tab is hidden, once the owner has turned them on (never asked for automatically).
 */
export function NotificationBell({ align = "left" }: { align?: "left" | "right" }) {
  const { key } = useOwner();
  const data = useQuery(api.notifications.recent, key ? { key } : "skip") as Recent | undefined;
  const markRead = useMutation(api.notifications.markRead);
  const markAll = useMutation(api.notifications.markAllRead);
  const [open, setOpen] = useState(false);
  const [permission, setPermission] = useState<string | undefined>(undefined);
  const [now, setNow] = useState(0);
  const seen = useRef<Set<string>>(new Set());
  const loaded = useRef(false);
  const box = useRef<HTMLDivElement>(null);

  // The browser's permission exists only after hydration: read once on mount (React's documented exception).
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setPermission(permissionNow()), []);

  // browser alerts for notifications that arrive while the tab is hidden
  useEffect(() => {
    if (!data) return;
    const fresh = freshUnread(seen.current, data.items, !loaded.current);
    loaded.current = true;
    if (!shouldAlert(permissionNow(), document.hidden)) return;
    for (const n of fresh) {
      try {
        const alert = new Notification(n.title, { body: n.body, tag: n.id });
        alert.onclick = () => { window.focus(); window.location.assign(n.href); };
      } catch {
        /* some browsers only allow notifications from a service worker: the bell still shows it */
      }
    }
  }, [data]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  if (!key) return null;
  const unread = data?.unread ?? 0;
  const badge = badgeText(unread);

  const turnOn = async () => {
    try {
      setPermission(await Notification.requestPermission());
    } catch {
      setPermission(permissionNow());
    }
  };

  return (
    <div ref={box} className="relative">
      <button
        onClick={() => { setNow(Date.now()); setOpen((o) => !o); }}
        aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
        aria-expanded={open}
        className="relative grid size-8 place-items-center rounded-lg text-muted transition-colors duration-150 hover:bg-surface hover:text-ink"
      >
        {unread ? <BellRing size={16} strokeWidth={1.7} /> : <Bell size={16} strokeWidth={1.6} />}
        {badge && (
          <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-you px-1 text-center text-[10px] font-medium leading-4 text-white tabular-nums">
            {badge}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className={`absolute top-10 z-40 w-80 max-w-[calc(100vw-2rem)] rounded-2xl border border-line bg-surface shadow-[0_8px_30px_rgba(0,0,0,0.08)] ${
            align === "right" ? "right-0" : "left-0"}`}
        >
          <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
            <p className="mr-auto text-sm font-medium">Notifications</p>
            {unread > 0 && (
              <button onClick={() => markAll({ key })} className="text-xs text-muted hover:text-ink">Mark all read</button>
            )}
          </div>
          <ol className="max-h-80 overflow-y-auto scroll-thin">
            {data?.items.length ? data.items.map((n) => (
              <li key={n.id}>
                <Link
                  href={n.href}
                  onClick={() => { setOpen(false); if (!n.read) void markRead({ key, id: n.id }); }}
                  className="flex gap-2.5 px-3 py-2.5 hover:bg-canvas"
                >
                  <span className={`mt-1.5 size-2 shrink-0 rounded-full ${n.read ? "bg-transparent" : "bg-you"}`} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className={`block text-[13px] leading-snug ${n.read ? "text-muted" : "font-medium text-ink"}`}>{n.title}</span>
                    <span className="mt-0.5 block truncate text-xs text-muted" title={n.body}>{n.body}</span>
                    <span className="mt-0.5 block text-[11px] text-faint">{timeAgo(n.ts, now || n.ts)}</span>
                  </span>
                </Link>
              </li>
            )) : (
              <li className="px-3 py-6 text-center text-sm text-faint">Nothing yet. You&apos;ll hear when a plan needs you or a build finishes.</li>
            )}
          </ol>
          {permission === "default" && (
            <div className="border-t border-line px-3 py-2.5">
              <button onClick={turnOn} className="rounded-lg px-2.5 py-1 text-xs font-medium text-ink ring-1 ring-line hover:bg-canvas">
                Turn on alerts
              </button>
              <span className="ml-2 text-[11px] text-faint">when this tab is in the background</span>
            </div>
          )}
          {permission === "denied" && (
            <p className="border-t border-line px-3 py-2.5 text-[11px] text-faint">Alerts are blocked in this browser&apos;s site settings.</p>
          )}
        </div>
      )}
    </div>
  );
}
