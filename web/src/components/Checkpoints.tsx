"use client";

import { useState } from "react";
import { GitCommitHorizontal, History, Loader2, RotateCcw } from "lucide-react";
import { commitUrl } from "../../convex/checkpoints";
import { newestFirst, shortSha } from "@/lib/history";
import type { CheckpointState, HistoryState } from "@/lib/types";

/** When a checkpoint was saved: a date when the run's start time is known (live), else time into the run. */
function when(t: number, t0?: number) {
  if (t0 !== undefined) {
    return new Date((t0 + t) * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
  const m = Math.round(t / 60);
  return m < 1 ? "at the start" : `${m} min into the run`;
}

/**
 * Save points, newest first (docs/checkpoints.md). `onRollback` is absent when rolling back isn't possible
 * (the replay, or while the team is working); `blocked` says why, in one line.
 */
export function CheckpointList({ history, t0, onRollback, blocked }: {
  history: HistoryState | undefined;
  t0?: number;
  onRollback?: (n: number) => Promise<void>;
  blocked?: string;
}) {
  const list = newestFirst(history);
  if (!list.length) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-line px-6 py-16 text-center">
        <History size={28} strokeWidth={1.5} className="text-faint" />
        <p className="max-w-sm text-sm text-muted">
          No checkpoints yet. Every finished build or change is saved here, so you can roll the app back to it.
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {blocked && <p className="text-xs text-faint">{blocked}</p>}
      <ol className="flex flex-col gap-2">
        {list.map((c) => (
          <Row key={c.n} c={c} t0={t0} repo={history?.repo ?? null} current={history?.current === c.n} onRollback={onRollback} />
        ))}
      </ol>
    </div>
  );
}

function Row({ c, t0, repo, current, onRollback }: {
  c: CheckpointState; t0?: number; repo: string | null; current: boolean; onRollback?: (n: number) => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const url = commitUrl(repo, c.sha);
  const sha = <span className="font-mono text-[12px]">{shortSha(c.sha)}</span>;

  const go = async () => {
    if (!onRollback) return;
    setBusy(true);
    setError(null);
    try {
      await onRollback(c.n);
      setConfirming(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't start the rollback.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className={`rounded-2xl border bg-surface p-4 ${current ? "border-dev/40 ring-1 ring-dev/20" : "border-line"}`}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-canvas text-xs font-semibold text-muted">
          {c.n}
        </span>
        <div className="mr-auto min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
            <span className="truncate">{c.label || `Checkpoint ${c.n}`}</span>
            {current && <span className="rounded-full bg-dev-bg px-2 py-0.5 text-[11px] font-medium text-dev">current</span>}
          </p>
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
            {when(c.t, t0)}
            <span aria-hidden>·</span>
            <GitCommitHorizontal size={13} strokeWidth={1.7} className="text-faint" />
            {url ? <a href={url} target="_blank" rel="noreferrer" className="underline-offset-2 hover:text-ink hover:underline">{sha}</a> : sha}
          </p>
        </div>
        {onRollback && !current && !confirming && (
          <button onClick={() => setConfirming(true)}
                  className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-muted ring-1 ring-line hover:text-ink">
            <RotateCcw size={14} strokeWidth={1.7} /> Roll back to this
          </button>
        )}
      </div>
      {confirming && onRollback && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-canvas p-3">
          <p className="mr-auto max-w-md text-xs leading-relaxed text-muted">
            The app goes back to exactly how it was at checkpoint {c.n}, in one new commit, and the preview is redeployed.
            Later work stays in the repo&apos;s history, so you can roll forward again.
          </p>
          <button onClick={() => setConfirming(false)} disabled={busy} className="rounded-lg px-3 py-1.5 text-sm text-muted hover:text-ink">
            Cancel
          </button>
          <button onClick={go} disabled={busy}
                  className="flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60">
            {busy && <Loader2 size={14} className="animate-spin" />} Roll back
          </button>
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-bad">{error}</p>}
    </li>
  );
}
