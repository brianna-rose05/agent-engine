"use client";

import Link from "next/link";
import { useState } from "react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { ArrowRight, CircleCheck, Clock3, RefreshCw, X } from "lucide-react";
import { useProject } from "@/lib/project-store";
import { COLUMNS, INTEGRATION, features, money, type Column, type Feature } from "@/lib/reduce";
import type { TaskState } from "@/lib/types";
import { Avatar, Mono } from "@/components/ui";
import { Feed } from "@/components/Feed";
import { ChangeRequestBox } from "@/components/ChangeRequest";

const COL_TINT: Record<Column, string> = {
  queued: "bg-faint",
  tests: "bg-qa",
  building: "bg-dev",
  checking: "bg-check",
  done: "bg-dev",
  attention: "bg-bad",
};

export default function BoardPage() {
  const { state, project, canChange } = useProject();
  const [open, setOpen] = useState<string | null>(null);
  const fs = features(state);
  const selected = fs.find((f) => f.id === open) ?? null;

  if (!state.plan || state.status === "awaiting_approval" || state.status === "planning") {
    const waiting = state.status === "awaiting_approval";
    const change = state.plan && state.change && ["planning", "pending"].includes(state.change.decision) ? state.change : null;
    return (
      <div className="mx-auto flex max-w-xl flex-col items-center gap-4 px-6 py-24 text-center">
        <Avatar who={waiting ? "you" : "planner"} size={48} active={!waiting} />
        <h2 className="text-xl font-semibold tracking-tight">
          {change
            ? waiting ? `Change ${change.n} is ready for you` : `The planner is planning change ${change.n}`
            : waiting ? "The plan is ready for you" : "Planning comes first"}
        </h2>
        <p className="text-muted">
          {change
            ? waiting
              ? "Review what will change. The team builds it in the same repo when you approve, and merged work stays."
              : "It reads the code and plans only what has to change. Its cards join the board once you approve them."
            : waiting
            ? "Review the features and how they depend on each other. Building starts when you approve."
            : "The board fills up once the planner has split the project into features and you've approved them."}
        </p>
        <Link href={`/p/${project.id}/plan`} className="flex items-center gap-2 rounded-lg bg-ink px-4 py-2 text-sm font-medium text-white">
          {change ? (waiting ? "Review the change" : "Watch the planner") : waiting ? "Review the plan" : "See the plan"} <ArrowRight size={14} />
        </Link>
      </div>
    );
  }

  return (
    <div className="flex min-h-[calc(100dvh-57px)]">
      <div className="min-w-0 flex-1 overflow-x-auto scroll-thin px-4 py-5 md:px-6">
        {canChange && (
          <div className="sticky left-0 mb-4 max-w-3xl">
            <ChangeRequestBox compact />
          </div>
        )}
        <LayoutGroup>
          <div className="grid min-w-[900px] grid-cols-6 gap-3">
            {COLUMNS.map((c) => {
              const items = fs.filter((f) => f.column === c.id);
              return (
                <section key={c.id} className="flex min-h-[60vh] flex-col gap-2.5 rounded-2xl bg-surface/50 p-2.5 ring-1 ring-line/70">
                  <header className="px-1.5 pt-1">
                    <p className="flex items-center gap-2 text-sm font-medium">
                      <span className={`size-2 rounded-full ${COL_TINT[c.id]}`} />
                      {c.label}
                      <span className="ml-auto text-xs font-normal tabular-nums text-faint">{items.length}</span>
                    </p>
                    <p className="text-xs text-faint">{c.hint}</p>
                  </header>
                  <AnimatePresence>
                    {items.map((f) => (
                      <Card key={f.id} f={f} now={state.now} onOpen={() => setOpen(f.id)} titles={titles(fs)} />
                    ))}
                  </AnimatePresence>
                </section>
              );
            })}
          </div>
        </LayoutGroup>
      </div>

      <aside className="hidden w-80 shrink-0 flex-col border-l border-line bg-canvas 2xl:flex">
        <p className="border-b border-line px-4 py-3 text-sm font-medium">Activity</p>
        <div className="flex-1 overflow-y-auto px-3 py-3 scroll-thin">
          <Feed items={state.feed} newestFirst empty="Nothing yet." />
        </div>
      </aside>

      <AnimatePresence>{selected && <Drawer f={selected} onClose={() => setOpen(null)} />}</AnimatePresence>
    </div>
  );
}

const titles = (fs: Feature[]) => Object.fromEntries(fs.map((f) => [f.id, f.title]));
const since = (now: number, t?: TaskState) => (t ? Math.max(0, Math.round(now - t.since)) : 0);

function Card({ f, now, onOpen, titles }: { f: Feature; now: number; onOpen: () => void; titles: Record<string, string> }) {
  const integ = f.id === INTEGRATION;               // no QA step: checked by building the app and opening every page
  const testsDone = integ || f.qa?.status === "passed";
  const built = f.dev?.status === "merged";
  const doing =
    f.column === "tests" ? `Writing tests · ${since(now, f.qa)}s`
    : f.column === "building" ? `Building · ${since(now, f.dev)}s`
    : f.column === "checking" ? (integ ? "Building the app and opening every page" : "Running hidden tests")
    : f.column === "done" ? `Verified · ${money(f.cost_usd)}`
    : f.column === "attention" ? (f.dev?.error || f.qa?.error || "Stopped after 3 tries")
    : f.waitingOn.length ? (integ ? `Waiting for ${f.waitingOn.length} feature${f.waitingOn.length > 1 ? "s" : ""} to merge`
                                  : `Waiting on ${f.waitingOn.map((d) => titles[d] ?? d).join(", ")}`)
    : testsDone ? "Tests ready, waiting for a dev agent" : "Waiting for a QA agent";
  // What the agent on an active card is doing right now ("Wrote src/x.ts"); stale once the engine is checking.
  const working = f.active === "qa" ? f.qa : f.active === "dev" ? f.dev : undefined;
  const note = working?.status === "working" ? working.notes?.at(-1) : undefined;

  return (
    <motion.button
      layout
      layoutId={f.id}
      onClick={onOpen}
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.97 }}
      className="group flex w-full flex-col gap-2 rounded-xl border border-line bg-surface p-3 text-left shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-shadow duration-150 hover:shadow-[0_4px_16px_rgba(0,0,0,0.06)]"
    >
      <div className="flex items-center gap-2">
        {f.column === "done" ? (
          <span className="grid size-6 place-items-center rounded-full bg-dev-bg text-dev">
            <CircleCheck size={14} strokeWidth={1.8} />
          </span>
        ) : (
          <Avatar who={f.active ?? (f.column === "attention" ? "engine" : testsDone ? "dev" : "qa")} size={24} active={!!f.active} />
        )}
        <span className="text-[11px] font-medium text-faint">{f.id}</span>
        {f.tries > 1 && (
          <span className="ml-auto flex items-center gap-1 rounded-full bg-check-bg px-1.5 py-0.5 text-[11px] text-check">
            <RefreshCw size={10} strokeWidth={2} /> try {f.tries}
          </span>
        )}
      </div>
      <p className="text-[14px] font-medium leading-snug">{f.title}</p>
      <div className="flex gap-1" aria-label="Tests, build, verified">
        {[testsDone, built || f.column === "checking", built].map((on, i) => (
          <span key={i} className={`h-1 flex-1 rounded-full transition-colors duration-300 ${on ? (i === 0 ? "bg-qa" : "bg-dev") : "bg-line"}`} />
        ))}
      </div>
      <p className={`line-clamp-2 text-xs ${f.column === "attention" ? "text-bad" : "text-muted"}`}>{doing}</p>
      {note && (
        <p className="truncate font-mono text-[11px] text-faint" title={note} aria-live="polite">
          {note}
        </p>
      )}
    </motion.button>
  );
}

function Drawer({ f, onClose }: { f: Feature; onClose: () => void }) {
  const row = (label: string, t?: TaskState) => (
    <div className="rounded-xl border border-line p-3">
      <p className="mb-2 flex items-center gap-2 text-sm font-medium">
        <Avatar who={label === "Tests" ? "qa" : "dev"} size={22} /> {label}
        <span className="ml-auto text-xs font-normal text-faint">{t ? t.status : "not started"}</span>
      </p>
      {t?.attempts.length ? (
        <ol className="flex flex-col gap-1.5">
          {t.attempts.map((a) => (
            <li key={a.n} className="flex items-start gap-2 text-[13px]">
              <span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${a.passed ? "bg-dev" : "bg-check"}`} />
              <span className="flex-1">
                Try {a.n}: {a.passed ? "passed the engine's checks" : `rejected (${a.reason})`}
                <span className="block text-xs text-faint">
                  {a.seconds}s · {a.turns} turns · {money(a.cost_usd)}
                  {a.files_changed.length ? ` · ${a.files_changed.join(", ")}` : ""}
                </span>
                {!a.passed && a.output ? (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs text-muted hover:text-ink">See what failed</summary>
                    <pre className="mt-1 max-h-64 overflow-auto rounded-lg bg-canvas p-2 font-mono text-[11px] leading-snug whitespace-pre-wrap text-ink/80 scroll-thin">
                      {a.output}
                    </pre>
                  </details>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="flex items-center gap-1.5 text-[13px] text-faint">
          <Clock3 size={13} /> No attempts yet
        </p>
      )}
    </div>
  );
  return (
    <>
      <motion.div className="fixed inset-0 z-30 bg-ink/10" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
      <motion.aside
        initial={{ x: 40, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: 40, opacity: 0 }}
        className="fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col gap-4 overflow-y-auto border-l border-line bg-surface p-5 shadow-xl"
      >
        <div className="flex items-start gap-3">
          <div className="flex-1">
            <p className="text-xs text-faint">{f.id}</p>
            <h3 className="text-lg font-semibold tracking-tight">{f.title}</h3>
            <div className="mt-1">
              <Mono>{f.module}</Mono>
            </div>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-muted hover:bg-canvas hover:text-ink" aria-label="Close">
            <X size={17} />
          </button>
        </div>
        <p className="text-sm leading-relaxed text-muted">{f.spec}</p>
        {row("Tests", f.qa)}
        {row("Build", f.dev)}
        <p className="text-sm text-muted">
          Spent on this feature: <span className="font-medium text-ink">{money(f.cost_usd)}</span>
        </p>
      </motion.aside>
    </>
  );
}
