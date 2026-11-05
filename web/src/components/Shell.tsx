"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Hash, History, KanbanSquare, ListChecks, ListTree, Plus, Sparkles } from "lucide-react";
import { useQuery } from "convex/react";
import { api, liveEnabled, useOwner } from "@/lib/convex";
import { money } from "@/lib/reduce";

type Nav = { href: string; label: string; Icon: typeof Hash; count?: number };

export function Shell({
  children,
  projectNav,
  projectName,
}: {
  children: React.ReactNode;
  projectNav?: { id: string; counts: Record<string, number> };
  projectName?: string;
}) {
  const path = usePathname();
  const base = projectNav ? `/p/${projectNav.id}` : "";
  const views: Nav[] = projectNav
    ? [
        ...(projectNav.id !== "demo" ? [{ href: `${base}/setup`, label: "Setup", Icon: ListChecks }] : []),
        { href: `${base}/plan`, label: "Plan", Icon: ListTree },
        { href: `${base}/board`, label: "Board", Icon: KanbanSquare },
        ...(projectNav.id !== "demo" ? [{ href: `${base}/history`, label: "History", Icon: History }] : []), // docs/checkpoints.md
      ]
    : [];
  const channels: Nav[] = projectNav
    ? (["all", "planning", "tests", "build"] as const).map((c) => ({
        href: `${base}/c/${c}`, label: c, Icon: Hash, count: projectNav.counts[c],
      }))
    : [];

  const item = (n: Nav) => {
    const on = path === n.href;
    return (
      <Link
        key={n.href}
        href={n.href}
        className={`flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors duration-150 ${
          on ? "bg-surface font-medium text-ink shadow-sm ring-1 ring-line" : "text-muted hover:bg-surface/70 hover:text-ink"
        }`}
      >
        <n.Icon size={16} strokeWidth={1.6} />
        <span className="flex-1 truncate">{n.label}</span>
        {n.count ? <span className="rounded-full bg-canvas px-1.5 text-[11px] text-faint">{n.count}</span> : null}
      </Link>
    );
  };

  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col gap-6 border-r border-line bg-canvas px-3 py-4 md:flex">
        <Link href="/" className="flex items-center gap-2 px-2 text-[15px] font-semibold tracking-tight">
          <span className="grid size-7 place-items-center rounded-lg bg-planner-bg text-planner">
            <Sparkles size={15} strokeWidth={1.7} />
          </span>
          Studio
        </Link>

        <Link
          href="/"
          className="flex items-center justify-center gap-2 rounded-lg bg-ink px-3 py-2 text-sm font-medium text-white transition-transform duration-150 hover:-translate-y-px"
        >
          <Plus size={15} strokeWidth={1.8} /> New project
        </Link>

        <div className="flex flex-col gap-0.5">
          <p className="px-2.5 pb-1 text-[11px] font-medium uppercase tracking-wider text-faint">Projects</p>
          {liveEnabled && <LiveProjects path={path} />}
          <Link
            href="/p/demo/board"
            className={`flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm ${
              path.startsWith("/p/demo") ? "text-ink" : "text-muted hover:text-ink"
            }`}
          >
            <span className="size-2 rounded-full bg-faint" /> Community garden
            <span className="ml-auto text-[11px] text-faint">demo</span>
          </Link>
        </div>

        {projectNav && (
          <>
            <div className="flex flex-col gap-0.5">
              <p className="truncate px-2.5 pb-1 text-[11px] font-medium uppercase tracking-wider text-faint">{projectName}</p>
              {views.map(item)}
            </div>
            <div className="flex flex-col gap-0.5">
              <p className="px-2.5 pb-1 text-[11px] font-medium uppercase tracking-wider text-faint">Channels</p>
              {channels.map(item)}
            </div>
          </>
        )}

        <div className="mt-auto rounded-xl border border-line bg-surface p-3 text-xs leading-relaxed text-muted">
          {liveEnabled ? (
            <>
              <span className="font-medium text-ink">Live.</span> New projects run real agents in the cloud. The
              community garden is a replay.
            </>
          ) : (
            <>
              <span className="font-medium text-ink">Demo mode.</span> Replaying a real Haiku build. Connect Convex to run
              your own.
            </>
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-line bg-canvas px-4 py-2.5 md:hidden">
          <Link href="/" className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
            <span className="grid size-7 place-items-center rounded-lg bg-planner-bg text-planner">
              <Sparkles size={15} strokeWidth={1.7} />
            </span>
            Studio
          </Link>
          <Link href="/p/demo/board" className="text-sm text-muted">
            Community garden
          </Link>
        </div>
        {projectNav && (
          <nav className="flex gap-1 overflow-x-auto border-b border-line bg-canvas px-3 py-2 md:hidden">
            {[...views, ...channels].map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className={`whitespace-nowrap rounded-full px-3 py-1 text-sm ${path === n.href ? "bg-surface text-ink ring-1 ring-line" : "text-muted"}`}
              >
                {n.Icon === Hash ? `#${n.label}` : n.label}
              </Link>
            ))}
          </nav>
        )}
        {children}
      </div>
    </div>
  );
}

const DOT: Record<string, string> = {
  draft: "bg-you",
  done: "bg-dev", building: "bg-qa", planning: "bg-planner", starting: "bg-planner", queued: "bg-faint",
  awaiting_approval: "bg-you", approved: "bg-qa", failed: "bg-bad", rejected: "bg-faint",
};

function LiveProjects({ path }: { path: string }) {
  const { key } = useOwner();
  const rows = useQuery(api.projects.list, key ? { key } : "skip") as
    { id: string; name: string; status: string; costUsd: number }[] | undefined;
  if (!rows?.length) return null;
  return (
    <>
      {rows.map((p) => (
        <Link
          key={p.id}
          href={`/p/${p.id}/${p.status === "draft" ? "setup" : "board"}`}
          className={`flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm ${
            path.startsWith(`/p/${p.id}`) ? "text-ink" : "text-muted hover:text-ink"
          }`}
          title={`${p.status.replace("_", " ")} · ${money(p.costUsd)}`}
        >
          <span className={`size-2 shrink-0 rounded-full ${DOT[p.status] ?? "bg-faint"} ${p.status === "awaiting_approval" ? "breathe text-you" : ""}`} />
          <span className="truncate">{p.name}</span>
        </Link>
      ))}
    </>
  );
}
