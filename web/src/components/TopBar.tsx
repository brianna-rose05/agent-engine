"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "convex/react";
import { RefreshCw, RotateCcw } from "lucide-react";
import { api, useOwner } from "@/lib/convex";
import { motion } from "motion/react";
import { useProject } from "@/lib/project-store";
import { features, money } from "@/lib/reduce";
import { StatusPill } from "./ui";

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function TopBar() {
  const { project, state, mode, speed, setSpeed, restart, clock: t, duration, liveStatus, canRetry } = useProject();
  const fs = features(state);
  const done = fs.filter((f) => f.column === "done").length;
  const pct = fs.length ? done / fs.length : 0;

  return (
    <header className="sticky top-0 z-20 border-b border-line bg-canvas/85 backdrop-blur">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3 md:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="truncate text-[17px] font-semibold tracking-tight">{project.name}</h1>
          <StatusPill status={liveStatus === "draft" ? "draft" : state.status} />
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted">
          {fs.length > 0 && (
            <div className="flex items-center gap-2.5">
              <div className="h-1.5 w-28 overflow-hidden rounded-full bg-line">
                <motion.div className="h-full rounded-full bg-dev" animate={{ width: `${pct * 100}%` }} />
              </div>
              <span className="tabular-nums">
                {done}/{fs.length} done
              </span>
            </div>
          )}
          <span className="tabular-nums" title="Total spent on agents so far">
            {money(state.cost_usd)}
          </span>
          <span className="tabular-nums" title="Time since the project started">
            {clock(state.now)}
          </span>
          <span className="rounded-md bg-surface px-2 py-0.5 text-xs ring-1 ring-line">{project.model}</span>
          {mode === "live" && canRetry && <RetryFailed id={project.id} />}
          {mode === "live" && ["failed", "done", "rejected"].includes(liveStatus ?? "") && <Rebuild id={project.id} quiet={canRetry} />}

          {mode === "demo" && (
            <div className="flex items-center gap-1 rounded-lg bg-surface p-0.5 ring-1 ring-line" title="Replay speed">
              {[1, 4, 16].map((s) => (
                <button
                  key={s}
                  onClick={() => setSpeed(s)}
                  className={`rounded-md px-2 py-0.5 text-xs tabular-nums transition-colors duration-150 ${
                    speed === s ? "bg-ink text-white" : "text-muted hover:text-ink"
                  }`}
                >
                  {s}×
                </button>
              ))}
              <button onClick={restart} title="Replay from the start" className="rounded-md px-1.5 py-0.5 text-muted hover:text-ink">
                <RotateCcw size={13} strokeWidth={1.7} />
              </button>
            </div>
          )}
        </div>
      </div>
      {mode === "demo" && (
        <div className="h-0.5 bg-line/60">
          <div className="h-full bg-planner/50 transition-[width] duration-200" style={{ width: `${(t / duration) * 100}%` }} />
        </div>
      )}
    </header>
  );
}

/** Start a fresh build of a stopped project from the same approved setup (new repo, same requirements). */
/** Rerun only the features (and integration) that didn't merge, in the same repo. */
function RetryFailed({ id }: { id: string }) {
  const { key } = useOwner();
  const retry = useMutation(api.projects.retryFailed);
  const [busy, setBusy] = useState(false);
  return (
    <button disabled={busy} title="Keeps every merged feature and redoes only what didn't finish"
      onClick={async () => { setBusy(true); try { await retry({ key: key!, id }); } finally { setBusy(false); } }}
      className="flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1 text-xs font-medium text-white disabled:opacity-40">
      <RotateCcw size={12} /> {busy ? "Starting…" : "Retry what failed"}
    </button>
  );
}

function Rebuild({ id, quiet = false }: { id: string; quiet?: boolean }) {
  const { key } = useOwner();
  const router = useRouter();
  const rebuild = useMutation(api.projects.rebuild);
  const [busy, setBusy] = useState(false);
  return (
    <button disabled={busy} title="Same requirements and design, a fresh team and repo"
      onClick={async () => { setBusy(true); try { router.push(`/p/${await rebuild({ key: key!, id })}/plan`); } finally { setBusy(false); } }}
      className={`flex items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-medium disabled:opacity-40 ${
        quiet ? "text-muted ring-1 ring-line hover:text-ink" : "bg-ink text-white"}`}>
      <RefreshCw size={12} /> {busy ? "Starting…" : "Build again"}
    </button>
  );
}
