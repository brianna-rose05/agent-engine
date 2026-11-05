"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import {
  ArrowRight, Check, ChevronRight, Circle, ExternalLink, GitCommitHorizontal, Loader2, PartyPopper, Rocket, RotateCcw,
  TriangleAlert, X,
} from "lucide-react";
import { api, useOwner } from "@/lib/convex";
import { anyRunning, useProject } from "@/lib/project-store";
import { shipChecks, shipRunning, versionNotes } from "@/lib/ship";
import { savedForLater } from "@/lib/pm";
import { OwnerSetup } from "@/components/OwnerSetup";
import { DesignWarnings } from "@/components/Designer";
import { designWarnings } from "@/lib/designer";
import { shortSha } from "@/lib/history";
import type { ShipCheckState, ShipRun, VersionState } from "@/lib/types";
import { commitUrl } from "../../../../../convex/checkpoints";
import { shipBlockedReason } from "../../../../../convex/ship";

/** Message of a Convex error (ConvexError's data is the friendly text), or a generic one. */
function errorText(e: unknown, fallback: string): string {
  const data = (e as { data?: unknown })?.data;
  return typeof data === "string" ? data : fallback;
}

/** When something happened: a date when the run's start time is known (live), else time into the run. */
function when(t: number, t0?: number) {
  if (t0 !== undefined) {
    return new Date((t0 + t) * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
  const m = Math.round(t / 60);
  return m < 1 ? "at the start" : `${m} min into the run`;
}

const host = (url: string) => url.replace(/^https:\/\//, "").replace(/\/$/, "");

/** Shipping starts a worker, so only the live app can; it needs Convex, which the replay doesn't have. */
function LiveShip() {
  const { project } = useProject();
  const { key } = useOwner();
  const shipNow = useMutation(api.ship.shipNow);
  const rollbackProduction = useMutation(api.ship.rollbackProduction);
  return (
    <ShipScreen
      onShip={async () => {
        try {
          await shipNow({ key: key!, id: project.id });
        } catch (e) {
          throw new Error(errorText(e, "Couldn't start the ship. Try again in a moment."));
        }
      }}
      onRollback={async (n) => {
        try {
          await rollbackProduction({ key: key!, id: project.id, n });
        } catch (e) {
          throw new Error(errorText(e, "Couldn't start the rollback. Try again in a moment."));
        }
      }}
    />
  );
}

export default function ShipPage() {
  const { mode } = useProject();
  return mode === "live" ? <LiveShip /> : <ShipScreen />;
}

function ShipScreen({ onShip, onRollback }: { onShip?: () => Promise<void>; onRollback?: (n: number) => Promise<void> }) {
  const { state, project, mode, t0, liveStatus, previewUrl, canShip, shipQueued } = useProject();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ship = state.ship;
  const run = ship?.run ?? null;
  const production = ship?.production ?? null;
  const versions = [...(ship?.versions ?? [])].reverse();
  const preview = previewUrl ?? state.preview_url;
  const running = shipRunning(state) || Boolean(shipQueued);
  const status = liveStatus ?? state.status;
  const hasRepo = Boolean(state.history?.repo) || Boolean(canShip);

  // Why the button is off, in one line (null when it's on)
  const blocked = mode !== "live" || !onShip
    ? "Shipping needs the live app. This project is a replay."
    : running
    ? "Production is being updated right now. Wait for it to finish."
    : canShip && !anyRunning(state)
    ? null
    : shipBlockedReason(status, anyRunning(state), hasRepo) ?? "Shipping isn't possible right now.";

  const celebrating = useCelebration(mode === "live" && liveStatus === undefined, production, run);

  const go = async () => {
    if (!onShip) return;
    setBusy(true);
    setError(null);
    try {
      await onShip();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't start the ship.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6 md:px-6">
      <header className="flex flex-col gap-3 border-b border-line pb-4">
        <div>
          <h2 className="flex items-center gap-1.5 text-lg font-semibold tracking-tight">
            <Rocket size={18} strokeWidth={1.7} className="text-faint" />
            Ship to production
          </h2>
          <p className="text-sm text-muted">
            Production is separate from the preview: its own address and its own database. Shipping runs the checks
            below, saves the code as the next version, and puts it live.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-sm">
          {preview ? (
            <a href={preview} target="_blank" rel="noopener noreferrer"
               className="flex min-w-0 items-center gap-1.5 rounded-lg bg-surface px-3 py-1.5 text-muted ring-1 ring-line hover:text-ink">
              <ExternalLink size={13} className="shrink-0" />
              <span className="shrink-0">Preview</span>
              <span className="truncate text-faint">{host(preview)}</span>
            </a>
          ) : (
            <span className="rounded-lg px-3 py-1.5 text-faint ring-1 ring-line">No preview yet</span>
          )}
          {production && (
            <a href={production.url} target="_blank" rel="noopener noreferrer"
               className="flex min-w-0 items-center gap-1.5 rounded-lg bg-dev-bg px-3 py-1.5 font-medium text-dev ring-1 ring-dev/20 hover:ring-dev/40">
              <span className="size-1.5 shrink-0 rounded-full bg-current" />
              <span className="shrink-0">Live · version {production.version}</span>
              <span className="truncate font-normal opacity-80">{host(production.url)}</span>
            </a>
          )}
        </div>
      </header>

      <RunBanner run={run} queued={Boolean(shipQueued) && !shipRunning(state)} production={production} celebrating={celebrating} />

      <OwnerSetup />

      <section aria-labelledby="checks-title" className="rounded-2xl border border-line bg-surface p-4">
        <h3 id="checks-title" className="text-sm font-medium">Checks</h3>
        <p className="mb-3 text-xs text-muted">
          {run?.rollback && !run.finished
            ? "A rollback puts back a version that already passed these checks, so they don't run again."
            : "Run on the code in the repo, one by one, every time you ship. The first one that fails stops the ship; warnings don't."}
        </p>
        <ol className="flex flex-col divide-y divide-line">
          {shipChecks(run && !run.rollback ? run : null).map((c) => (
            <CheckRow key={c.name} c={c} stopped={run?.state === "failed"} />
          ))}
        </ol>
      </section>

      <WhatsIn />
      <SavedForNext />

      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={go} disabled={Boolean(blocked) || busy}
                  className="flex items-center gap-2 rounded-lg bg-ink px-4 py-2 text-sm font-medium text-white transition-transform duration-150 enabled:hover:-translate-y-px disabled:opacity-40">
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Rocket size={15} strokeWidth={1.8} />}
            {busy ? "Starting…" : "Ship to production"}
          </button>
          <Link href={`/p/${project.id}/plan#change-request-title`}
                className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-muted ring-1 ring-line hover:text-ink">
            Keep building <ArrowRight size={14} />
          </Link>
        </div>
        {blocked && <p className="text-xs text-faint">{blocked}</p>}
        {error && <p role="alert" className="text-xs text-bad">{error}</p>}
      </section>

      <section aria-labelledby="versions-title" className="flex flex-col gap-3">
        <div>
          <h3 id="versions-title" className="text-sm font-medium">Versions</h3>
          <p className="text-xs text-muted">Every ship saves the code as a version (a <span className="font-mono">v</span> tag in the repo). Tags are never moved or deleted.</p>
        </div>
        {versions.length ? (
          <ol className="flex flex-col gap-2">
            {versions.map((v) => (
              <VersionRow key={v.n} v={v} t0={t0} repo={state.history?.repo ?? null} live={production?.version === v.n}
                onRollback={onRollback && !blocked && production?.version !== v.n ? () => onRollback(v.n) : undefined} />
            ))}
          </ol>
        ) : (
          <p className="rounded-2xl border border-dashed border-line px-4 py-8 text-center text-sm text-muted">
            Nothing shipped yet. Version 1 appears here once it&apos;s live.
          </p>
        )}
      </section>
    </div>
  );
}

/**
 * Whether to celebrate: a new version went live while this page was open (not one that was already live when it
 * loaded, and not a rollback). The key changes for every new version, so each gets its own burst.
 */
function useCelebration(loading: boolean, production: { version: number; t: number } | null, run: ShipRun | null): string | null {
  const seen = useRef<string | null | undefined>(undefined);
  const [key, setKey] = useState<string | null>(null);
  const current = production ? `${production.version}@${production.t}` : null;
  useEffect(() => {
    if (loading) return;
    if (seen.current === undefined) {
      seen.current = current; // what was live when the page opened
      return;
    }
    if (current && current !== seen.current && run?.state === "live" && !run.rollback) setKey(current);
    seen.current = current;
  }, [loading, current, run?.state, run?.rollback]);
  return key;
}

const CONFETTI = ["bg-dev", "bg-planner", "bg-qa", "bg-you", "bg-engine", "bg-check"];

function Confetti() {
  return (
    <span className="ship-confetti" aria-hidden>
      {Array.from({ length: 18 }, (_, i) => {
        const angle = (i / 18) * Math.PI * 2;
        const dist = 70 + (i % 3) * 28;
        return (
          <i key={i} className={CONFETTI[i % CONFETTI.length]}
             style={{ "--dx": `${Math.round(Math.cos(angle) * dist * 1.6)}px`, "--dy": `${Math.round(Math.sin(angle) * dist)}px`,
                      "--r": `${(i * 47) % 360}deg`, animationDelay: `${(i % 4) * 40}ms` } as React.CSSProperties} />
        );
      })}
    </span>
  );
}

/** What the running or last ship is doing, in one card. */
function RunBanner({ run, queued, production, celebrating }: {
  run: ShipRun | null; queued: boolean; production: { url: string; version: number } | null; celebrating: string | null;
}) {
  if (queued) {
    return (
      <div className="flex items-center gap-3 rounded-2xl border border-line bg-surface p-4 text-sm">
        <Loader2 size={16} className="animate-spin text-qa" /> Starting… the checks begin in a minute.
      </div>
    );
  }
  if (!run) return null;
  if (run.state === "checking" || run.state === "deploying") {
    return (
      <div className="flex items-center gap-3 rounded-2xl border border-qa/25 bg-qa-bg/60 p-4 text-sm text-ink">
        <Loader2 size={16} className="shrink-0 animate-spin text-qa" />
        {run.rollback
          ? `Putting version ${run.version} back in production…`
          : run.state === "checking" ? "Running the checks…" : "All checks passed. Saving the version and deploying it to production…"}
      </div>
    );
  }
  if (run.state === "failed") {
    return (
      <div role="status" className="rounded-2xl border border-bad/25 bg-bad-bg/60 p-4 text-sm">
        <p className="font-medium text-bad">{run.rollback ? `Production wasn't rolled back to version ${run.version}` : "This version wasn't shipped"}</p>
        <p className="mt-1 text-muted">
          {run.reason ?? "The ship stopped before it finished."} {production ? `Production is still on version ${production.version}.` : "Nothing was deployed."}
        </p>
      </div>
    );
  }
  // live
  if (!production) return null;
  return (
    <div key={celebrating ?? "live"} role="status"
         className={`relative rounded-2xl border border-dev/30 bg-dev-bg p-4 text-sm ${celebrating ? "ship-pop" : ""}`}>
      {celebrating && <Confetti />}
      <p className="flex items-center gap-2 font-medium text-dev">
        {run.rollback ? <RotateCcw size={16} /> : <PartyPopper size={16} />}
        {run.rollback ? `Production is back on version ${production.version}` : `Version ${production.version} is live`}
      </p>
      <a href={production.url} target="_blank" rel="noopener noreferrer"
         className="mt-1 inline-flex max-w-full items-center gap-1 break-all text-muted underline-offset-2 hover:text-ink hover:underline">
        {production.url} <ExternalLink size={12} className="shrink-0" />
      </a>
      {!run.rollback && run.checks.some((x) => x.status === "warning") && (
        <p className="mt-1 text-xs text-warn">
          Passed with warnings: {run.checks.filter((x) => x.status === "warning").map((x) => x.label).join(", ")}. The checks below say what to look at.
        </p>
      )}
    </div>
  );
}

const CHECK_ICON: Record<ShipCheckState["status"], React.ReactNode> = {
  pending: <Circle size={16} strokeWidth={1.6} className="text-faint" />,
  running: <Loader2 size={16} className="animate-spin text-qa" />,
  passed: <span className="grid size-4 place-items-center rounded-full bg-dev text-white"><Check size={11} strokeWidth={3} /></span>,
  warning: <span className="grid size-4 place-items-center rounded-full bg-warn text-white"><TriangleAlert size={10} strokeWidth={3} /></span>,
  failed: <span className="grid size-4 place-items-center rounded-full bg-bad text-white"><X size={11} strokeWidth={3} /></span>,
};

const CHECK_TEXT: Record<Exclude<ShipCheckState["status"], "pending">, string> = {
  running: "Running…", passed: "Passed", warning: "Passed with warnings", failed: "Failed",
};
const CHECK_TONE: Record<ShipCheckState["status"], string> = {
  pending: "text-faint", running: "text-qa", passed: "text-dev", warning: "text-warn", failed: "text-bad",
};
/** What the expandable detail is called: a failure's output, a warning's notes, or a passed check's summary. */
const DETAIL_TITLE: Partial<Record<ShipCheckState["status"], string>> = {
  failed: "What went wrong", warning: "Warnings", passed: "Details",
};

function CheckRow({ c, stopped }: { c: ShipCheckState; stopped: boolean }) {
  const text = c.status === "pending" ? (stopped ? "Not run" : "Waiting") : CHECK_TEXT[c.status];
  const title = c.detail ? DETAIL_TITLE[c.status] : undefined;
  return (
    <li className={`py-2.5 ${c.status === "warning" ? "-mx-2 rounded-xl bg-warn-bg/60 px-2" : ""}`}>
      <div className="flex items-center gap-3">
        <span className="grid size-5 shrink-0 place-items-center">{CHECK_ICON[c.status]}</span>
        <span className={`mr-auto text-sm ${c.status === "pending" ? "text-muted" : "text-ink"}`}>{c.label}</span>
        <span className={`text-xs ${CHECK_TONE[c.status]}`} aria-live="polite">{text}</span>
      </div>
      {title && (
        <details className="group ml-8 mt-2">
          <summary className={`flex cursor-pointer list-none items-center gap-1 text-xs hover:text-ink ${c.status === "warning" ? "text-warn" : "text-muted"}`}>
            <ChevronRight size={13} className="transition-transform duration-150 group-open:rotate-90" /> {title}
          </summary>
          <pre className="scroll-thin mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-canvas p-3 font-mono text-[12px] leading-relaxed text-muted">
            {c.detail}
          </pre>
        </details>
      )}
    </li>
  );
}

/** The features and changes the next version holds, in plain English. */
function WhatsIn() {
  const { state } = useProject();
  const { since, features, changes } = versionNotes(state);
  const empty = !features.length && !changes.length;
  return (
    <section aria-labelledby="whats-in-title" className="rounded-2xl border border-line bg-surface p-4">
      <h3 id="whats-in-title" className="text-sm font-medium">What&apos;s in this version</h3>
      <p className="mb-3 text-xs text-muted">
        {since ? `New since version ${since}.` : "The first version: everything built so far."}
      </p>
      {empty ? (
        <p className="text-sm text-muted">
          {since ? `Nothing new since version ${since}. Shipping again puts the same app live as a new version.` : "Nothing has been built yet."}
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {features.length > 0 && <Notes title="Features" items={features} />}
          {changes.length > 0 && <Notes title="Changes" items={changes} />}
        </div>
      )}
      <DesignWarnings warnings={designWarnings(state)} />
    </section>
  );
}

/** Should and Could features that aren't in this version: saved by the PM, or not merged yet. Never block shipping. */
function SavedForNext() {
  const { state, project } = useProject();
  const saved = savedForLater(state);
  if (!saved.length) return null;
  return (
    <section aria-labelledby="saved-next-title" className="rounded-2xl border border-pm/20 bg-pm-bg/40 p-4">
      <h3 id="saved-next-title" className="text-sm font-medium">Saved for the next version</h3>
      <p className="mb-3 text-xs text-muted">
        Should and Could features don&apos;t block shipping. Build them from the{" "}
        <Link href={`/p/${project.id}/board`} className="underline-offset-2 hover:text-ink hover:underline">board</Link> when you&apos;re ready.
      </p>
      <ul className="flex flex-col gap-1.5">
        {saved.map((x) => (
          <li key={x.id} className="flex gap-2 text-sm">
            <Circle size={14} strokeWidth={1.8} className="mt-0.5 shrink-0 text-pm" />
            <span className="min-w-0">{x.title}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Notes({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-faint">{title}</p>
      <ul className="flex flex-col gap-1.5">
        {items.map((x, i) => (
          <li key={`${i}-${x}`} className="flex gap-2 text-sm">
            <Check size={14} strokeWidth={2} className="mt-0.5 shrink-0 text-dev" />
            <span className="min-w-0">{x}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function VersionRow({ v, t0, repo, live, onRollback }: {
  v: VersionState; t0?: number; repo: string | null; live: boolean; onRollback?: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const url = v.sha ? commitUrl(repo, v.sha) : null;
  const sha = v.sha ? <span className="font-mono text-[12px]">{shortSha(v.sha)}</span> : null;

  const go = async () => {
    if (!onRollback) return;
    setBusy(true);
    setError(null);
    try {
      await onRollback();
      setConfirming(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't start the rollback.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className={`rounded-2xl border bg-surface p-4 ${live ? "border-dev/40 ring-1 ring-dev/20" : "border-line"}`}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-canvas text-xs font-semibold text-muted">v{v.n}</span>
        <div className="mr-auto min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
            Version {v.n}
            {live && <span className="rounded-full bg-dev-bg px-2 py-0.5 text-[11px] font-medium text-dev">Live</span>}
          </p>
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
            {when(v.t, t0)}
            {sha && (
              <>
                <span aria-hidden>·</span>
                <GitCommitHorizontal size={13} strokeWidth={1.7} className="text-faint" />
                {url ? <a href={url} target="_blank" rel="noreferrer" className="underline-offset-2 hover:text-ink hover:underline">{sha}</a> : sha}
              </>
            )}
            <span aria-hidden>·</span>
            <a href={v.url} target="_blank" rel="noopener noreferrer" className="truncate underline-offset-2 hover:text-ink hover:underline">
              {host(v.url)}
            </a>
          </p>
        </div>
        {onRollback && !live && !confirming && (
          <button onClick={() => setConfirming(true)}
                  className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-muted ring-1 ring-line hover:text-ink">
            <RotateCcw size={14} strokeWidth={1.7} /> Roll back production to this version
          </button>
        )}
      </div>
      {confirming && onRollback && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-canvas p-3">
          <p className="mr-auto max-w-md text-xs leading-relaxed text-muted">
            Production goes back to version {v.n}&apos;s code. Only the code goes back: the production database is kept as
            it is, so everything saved in it since then stays. The preview and the repo don&apos;t change.
          </p>
          <button onClick={() => setConfirming(false)} disabled={busy} className="rounded-lg px-3 py-1.5 text-sm text-muted hover:text-ink">
            Cancel
          </button>
          <button onClick={go} disabled={busy}
                  className="flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60">
            {busy && <Loader2 size={14} className="animate-spin" />} Roll back production
          </button>
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-bad">{error}</p>}
    </li>
  );
}
