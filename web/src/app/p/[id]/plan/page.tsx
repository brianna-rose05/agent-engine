"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Check, FileCode2, Loader2, MessageSquareReply, ShieldCheck } from "lucide-react";
import { useProject } from "@/lib/project-store";
import { currentPlanner, layers } from "@/lib/reduce";
import type { ChangeState, Plan, TaskState } from "@/lib/types";
import { Avatar, Mono } from "@/components/ui";
import { ChangeRequestBox } from "@/components/ChangeRequest";
import { BudgetLine } from "@/components/Budget";
import { ApiKeyCard } from "@/components/ApiKeyCard";
import { estimateBuild } from "@/lib/estimate";
import { QuickChangeBox } from "@/components/QuickChange";
import { PmCard } from "@/components/PM";
import { ArchitectReading, ArchitectVerdict, ArchitectWarnings } from "@/components/Architect";
import { pmSuggestion, priorityName } from "@/lib/pm";
import { priorityOf } from "../../../../../convex/pm";

export default function PlanPage() {
  const { state, approve, sendBack, project, liveStatus, liveError, budgetUsd, spentUsd } = useProject();
  const router = useRouter();
  const [note, setNote] = useState("");
  const [replying, setReplying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  const plan = state.plan;
  useEffect(() => { if (liveStatus === "draft") router.replace(`/p/${project.id}/setup`); }, [liveStatus, project.id, router]);

  if (!plan && liveError) {
    return (
      <div className="mx-auto flex max-w-xl flex-col items-center gap-3 px-6 py-24 text-center">
        <Avatar who="engine" size={48} />
        <h2 className="text-xl font-semibold tracking-tight">The team couldn&apos;t start</h2>
        <p className="text-muted">{liveError}</p>
      </div>
    );
  }

  if (!plan && (liveStatus === "queued" || liveStatus === "starting")) {
    return (
      <div className="mx-auto flex max-w-xl flex-col items-center gap-4 px-6 py-24 text-center">
        <Avatar who="engine" size={48} active />
        <h2 className="text-xl font-semibold tracking-tight">Getting the team ready</h2>
        <p className="text-muted">
          Creating a private GitHub repo for {project.name} and starting a cloud sandbox for the planner. This takes
          about a minute.
        </p>
        <Loader2 className="animate-spin text-faint motion-reduce:animate-none" size={18} />
      </div>
    );
  }

  if (!plan) return <PlannerAtWork />;

  const waiting = state.status === "awaiting_approval";
  const change = state.change;
  const changeWaiting = waiting && change?.decision === "pending" ? change : null;
  const changePlanning = state.status === "planning" && change?.decision === "planning" ? change : null;
  const parallelNow = layers(plan)[0]?.length ?? 0;
  // the planner has already run (its cost is in "spent so far"): estimate only what approving starts
  const estimate = waiting ? estimateBuild(changeWaiting ? changeWaiting.tasks : plan.tasks) : undefined;
  // the PM's budget guard (first plan only: a change's tasks are all Musts, the owner asked for them)
  const pm = estimate && !changeWaiting && budgetUsd !== undefined
    ? pmSuggestion(plan.tasks, estimate, spentUsd ?? state.cost_usd, budgetUsd) : null;
  const pmCard = pm && pm.kind !== "fits" ? pm : null;
  // the architect's review of what you're approving: the change's plan, or the build plan (docs/architect.md)
  const architect = changeWaiting ? changeWaiting.architect : state.architect;
  const decide = async (deferred?: string[]) => {
    setBusy(true);
    setApproveError(null);
    try {
      await approve(deferred);
      router.push(`/p/${project.id}/board`);
    } catch (e) {
      setApproveError(e instanceof Error ? e.message : "Couldn't approve the plan.");
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-6 md:py-8">
      {changePlanning && <ChangeAtWork change={changePlanning} />}
      {changeWaiting && <ChangeReview change={changeWaiting} />}

      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-muted">{change ? "The original plan" : "The plan"}</p>
          <h2 className="text-2xl font-semibold tracking-tight">
            {plan.tasks.length} features, {parallelNow} can start right away
          </h2>
          {!change && <div className="mt-1.5"><ArchitectVerdict review={state.architect} /></div>}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
          <FileCode2 size={15} strokeWidth={1.6} /> Shared contract
          {plan.contracts.map((c) => (
            <Mono key={c}>{c}</Mono>
          ))}
        </div>
      </div>

      <PlanMap plan={plan} />

      <div className="mt-8 grid gap-4 md:grid-cols-3">
        {[
          { who: "qa" as const, t: "Tests first", d: "A QA agent writes hidden acceptance tests for each feature before any code exists." },
          { who: "dev" as const, t: "Built in parallel", d: "Dev agents build features as soon as what they depend on is done." },
          { who: "engine" as const, t: "Nothing trusted", d: "The engine runs the hidden tests itself. A feature only merges if they pass." },
        ].map((x) => (
          <div key={x.t} className="flex gap-3 rounded-2xl border border-line bg-surface p-4">
            <Avatar who={x.who} />
            <div>
              <p className="text-sm font-medium">{x.t}</p>
              <p className="text-sm text-muted">{x.d}</p>
            </div>
          </div>
        ))}
      </div>

      <AnimatePresence>
        {waiting && (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            className="sticky bottom-4 mt-8 rounded-2xl border border-line bg-surface p-4 shadow-[0_8px_30px_rgba(0,0,0,0.06)]"
          >
            {replying ? (
              <div className="flex flex-col gap-3">
                <textarea
                  autoFocus
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={changeWaiting
                    ? "What should the planner do differently? e.g. leave the booking emails alone, only fix the time zone"
                    : "What should the planner change? e.g. split rentals and waitlist into two features"}
                  className="min-h-20 w-full resize-y rounded-xl border border-line bg-canvas p-3 text-sm outline-none focus:ring-2 focus:ring-planner/30"
                />
                <div className="flex justify-end gap-2">
                  <button onClick={() => setReplying(false)} className="rounded-lg px-3 py-2 text-sm text-muted hover:text-ink">
                    Cancel
                  </button>
                  <button
                    disabled={!note.trim() || busy}
                    onClick={async () => {
                      setBusy(true);
                      await sendBack(note.trim());
                      setBusy(false);
                    }}
                    className="rounded-lg bg-ink px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
                  >
                    Send back to planner
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <div className="basis-full">
                  <BudgetLine estimate={estimate} what={changeWaiting ? `change ${changeWaiting.n}` : "the build"} />
                </div>
                {pmCard && budgetUsd !== undefined && (
                  <div className="basis-full"><PmCard suggestion={pmCard} budget={budgetUsd} /></div>
                )}
                {architect?.warnings && (
                  <div className="basis-full"><ArchitectWarnings review={architect} /></div>
                )}
                <ShieldCheck className="text-you" size={20} strokeWidth={1.6} />
                <p className="mr-auto text-sm">
                  <span className="font-medium">{changeWaiting ? `Nothing changes until you approve change ${changeWaiting.n}.` : "Nothing is built until you approve."}</span>{" "}
                  <span className="text-muted">Agents start the moment you do.</span>
                </p>
                <button
                  onClick={() => setReplying(true)}
                  className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted ring-1 ring-line hover:text-ink"
                >
                  <MessageSquareReply size={15} strokeWidth={1.6} /> Send back
                </button>
                {pmCard?.kind === "defer" ? (
                  <>
                    <button
                      disabled={busy}
                      onClick={() => decide()}
                      title="Approve every feature. The team still stops at your limit."
                      className="rounded-lg px-3 py-2 text-sm text-muted ring-1 ring-line hover:text-ink disabled:opacity-40"
                    >
                      Build everything
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => decide(pmCard.tasks)}
                      className="flex items-center gap-2 rounded-lg bg-ink px-4 py-2 text-sm font-medium text-white transition-transform duration-150 hover:-translate-y-px disabled:opacity-40"
                    >
                      <Check size={15} strokeWidth={2} /> Save these for later
                    </button>
                  </>
                ) : (
                  <button
                    disabled={busy}
                    onClick={() => decide()}
                    className="flex items-center gap-2 rounded-lg bg-ink px-4 py-2 text-sm font-medium text-white transition-transform duration-150 hover:-translate-y-px"
                  >
                    <Check size={15} strokeWidth={2} />{" "}
                    {changeWaiting ? "Approve the change" : pmCard ? "Build everything" : "Approve and build"}
                  </button>
                )}
                {approveError && <p role="alert" className="basis-full text-xs text-bad">{approveError}</p>}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {state.status === "stopped" && (
        <section className="mt-8 rounded-2xl border border-you/30 bg-surface p-4" aria-labelledby="budget-stopped-title">
          <h3 id="budget-stopped-title" className="text-sm font-medium">The team stopped at your spending limit</h3>
          <p className="mb-2 mt-0.5 text-xs text-muted">
            Merged work stays. Raise the limit, then use Retry what failed to finish the rest.
          </p>
          <BudgetLine />
        </section>
      )}

      <div className="mt-8 empty:hidden">
        <ApiKeyCard />
      </div>

      <div className="mt-8 flex flex-col gap-3 empty:hidden">
        <QuickChangeBox />
        <ChangeRequestBox />
      </div>

      {!waiting && !changePlanning && (
        <button
          onClick={() => router.push(`/p/${project.id}/board`)}
          className="mt-8 flex items-center gap-2 text-sm text-muted hover:text-ink"
        >
          {state.status === "rejected" ? "Plan sent back. The planner will revise it."
            : ["done", "failed", "stopped"].includes(state.status) ? "See the board" : "Approved. Watch the board"}
          <ArrowRight size={14} />
        </button>
      )}
    </div>
  );
}

/** Features laid out left to right by what they wait on, with arrows for dependencies. */
function PlanMap({ plan }: { plan: Plan }) {
  const cols = layers(plan);
  const byId = Object.fromEntries(plan.tasks.map((t) => [t.id, t]));
  const box = useRef<HTMLDivElement>(null);
  const cards = useRef<Record<string, HTMLDivElement | null>>({});
  const [lines, setLines] = useState<{ d: string; key: string }[]>([]);

  useLayoutEffect(() => {
    const measure = () => {
      const root = box.current?.getBoundingClientRect();
      if (!root) return;
      const out: { d: string; key: string }[] = [];
      for (const t of plan.tasks) {
        for (const dep of t.depends_on) {
          const a = cards.current[dep]?.getBoundingClientRect();
          const b = cards.current[t.id]?.getBoundingClientRect();
          if (!a || !b) continue;
          const x1 = a.right - root.left, y1 = a.top + a.height / 2 - root.top;
          const x2 = b.left - root.left, y2 = b.top + b.height / 2 - root.top;
          const mx = (x1 + x2) / 2;
          out.push({ key: `${dep}-${t.id}`, d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2 - 4},${y2}` });
        }
      }
      setLines(out);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (box.current) ro.observe(box.current);
    return () => ro.disconnect();
  }, [plan]);

  return (
    <div className="overflow-x-auto scroll-thin">
      <div ref={box} className="relative flex min-w-max gap-14 pb-2">
        <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" aria-hidden>
          <defs>
            <marker id="arrow" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" fill="#c9c7c0" />
            </marker>
          </defs>
          {lines.map((l) => (
            <motion.path
              key={l.key}
              d={l.d}
              fill="none"
              stroke="#d6d4ce"
              strokeWidth={1.4}
              markerEnd="url(#arrow)"
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: 0.3 }}
            />
          ))}
        </svg>
        {cols.map((ids, i) => (
          <div key={i} className="flex w-64 flex-col justify-center gap-4">
            <p className="text-[11px] font-medium uppercase tracking-wider text-faint">
              {i === 0 ? "Starts right away" : `After step ${i}`}
            </p>
            {ids.map((id, j) => {
              const t = byId[id];
              return (
                <motion.div
                  key={id}
                  ref={(el) => {
                    cards.current[id] = el;
                  }}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.04 * (i * 3 + j) }}
                  className="relative rounded-2xl border border-line bg-surface p-4 shadow-[0_1px_2px_rgba(0,0,0,0.03)]"
                >
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 text-[11px] font-medium text-faint">
                      {t.id}
                      {t.priority && <PriorityPill priority={priorityOf(t)} />}
                    </span>
                    <Mono>{t.module}</Mono>
                  </div>
                  <p className="text-[15px] font-medium leading-snug">{t.title}</p>
                  <p className="mt-1.5 line-clamp-3 text-[13px] leading-relaxed text-muted" title={t.spec}>
                    {t.spec}
                  </p>
                  {t.depends_on.length > 0 && (
                    <p className="mt-2 text-xs text-faint">Uses {t.depends_on.map((d) => byId[d]?.title ?? d).join(", ")}</p>
                  )}
                </motion.div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Must / Should / Could on a plan card (shown when the plan has priorities). */
function PriorityPill({ priority }: { priority: ReturnType<typeof priorityOf> }) {
  const tone = priority === "must" ? "bg-ink/5 text-ink" : priority === "should" ? "bg-pm-bg text-pm" : "bg-canvas text-muted ring-1 ring-line";
  return <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${tone}`}>{priorityName(priority)}</span>;
}

const clockText = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/** While the planner works (10 to 25 minutes): what it did last and a timer that ticks every second, so a
 *  long run doesn't look stuck. Regression: the first live users saw one static line and gave up. */
function PlannerAtWork() {
  const { state, project } = useProject();
  const planner = currentPlanner(state);
  const elapsed = useElapsed(planner);

  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-4 px-6 py-24 text-center">
      <Avatar who="planner" size={48} active />
      <h2 className="text-xl font-semibold tracking-tight">The planner is working on your plan</h2>
      <p className="text-muted">
        It&apos;s splitting {project.name.toLowerCase()} into features that can be built in parallel, and writing the shared
        contract they&apos;ll all use. This usually takes 10 to 25 minutes. You&apos;ll approve it before anything is built.
      </p>
      <Elapsed elapsed={elapsed} />
      {planner?.status === "architect_reviewing" && <ArchitectReading />}
      <PlannerNotes notes={planner?.notes ?? []} empty="Reading your description…" />
    </div>
  );
}

/** Seconds the planner has worked, ticking every second; undefined until known. */
function useElapsed(planner: TaskState | undefined) {
  const { mode, clock, t0 } = useProject();
  const [wall, setWall] = useState(0); // browser time in seconds, 0 until the first tick
  useEffect(() => {
    const tick = () => setWall(Date.now() / 1000);
    const id = setInterval(tick, 1000);
    const first = setTimeout(tick, 0);
    return () => {
      clearInterval(id);
      clearTimeout(first);
    };
  }, []);
  const start = planner ? planner.started ?? planner.since : undefined;
  // Event times count from the first event: live, that is wall-clock t0; the demo replays on its own clock.
  const now = mode === "live" ? (t0 !== undefined && wall ? wall - t0 : undefined) : clock;
  return start !== undefined && now !== undefined ? Math.max(0, Math.floor(now - start)) : undefined;
}

function Elapsed({ elapsed }: { elapsed: number | undefined }) {
  return (
    <p className="flex items-center gap-2 text-sm text-muted">
      <Loader2 className="animate-spin text-faint motion-reduce:animate-none" size={15} />
      {elapsed !== undefined ? (
        <span className="tabular-nums">Working for {clockText(elapsed)}</span>
      ) : (
        <span>Starting</span>
      )}
    </p>
  );
}

function PlannerNotes({ notes, empty }: { notes: string[]; empty: string }) {
  return (
    <ol className="flex w-full flex-col gap-1 text-left" aria-live="polite" aria-label="What the planner did last">
      {notes.length ? (
        notes.map((n, i) => (
          <li
            key={`${i}-${n}`}
            className={`truncate rounded-lg px-3 py-1.5 font-mono text-[12px] ${
              i === notes.length - 1 ? "bg-surface text-ink ring-1 ring-line" : "text-faint"
            }`}
            title={n}
          >
            {n}
          </li>
        ))
      ) : (
        <li className="px-3 py-1.5 text-center text-sm text-faint">{empty}</li>
      )}
    </ol>
  );
}

/** While the change planner (C{n}PLAN) reads the code and plans the change: the request, a timer, its notes. */
function ChangeAtWork({ change }: { change: ChangeState }) {
  const { state } = useProject();
  const planner = currentPlanner(state);
  const elapsed = useElapsed(planner);
  return (
    <section className="mb-8 flex flex-col items-center gap-3 rounded-2xl border border-line bg-surface px-5 py-6 text-center">
      <Avatar who="planner" size={40} active />
      <h2 className="text-lg font-semibold tracking-tight">The planner is planning change {change.n}</h2>
      <p className="max-w-xl text-sm text-muted">&ldquo;{change.text}&rdquo;</p>
      <p className="max-w-xl text-sm text-muted">
        It reads the code and plans only what has to change. Merged work stays. You&apos;ll approve the change before
        anything is built.
      </p>
      <Elapsed elapsed={elapsed} />
      {planner?.status === "architect_reviewing" && <ArchitectReading />}
      <div className="w-full max-w-xl">
        <PlannerNotes notes={planner?.notes ?? []} empty="Reading the code and your request…" />
      </div>
    </section>
  );
}

/** A planned change waiting for approval: what will change, and each task (changed or new module). */
function ChangeReview({ change }: { change: ChangeState }) {
  return (
    <section className="mb-8 rounded-2xl border border-you/30 bg-surface p-5" aria-labelledby="change-review-title">
      <p className="text-sm text-muted">Change {change.n}, ready for your approval</p>
      <h2 id="change-review-title" className="text-xl font-semibold tracking-tight">
        {change.tasks.length} task{change.tasks.length === 1 ? "" : "s"} to make your change
      </h2>
      <p className="mt-1 text-sm text-muted">You asked: &ldquo;{change.text}&rdquo;</p>
      {change.summary && <p className="mt-3 text-[15px] leading-relaxed">{change.summary}</p>}
      {change.architect && <div className="mt-3"><ArchitectVerdict review={change.architect} /></div>}
      {change.contracts.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-muted">
          <FileCode2 size={15} strokeWidth={1.6} /> Contract edits
          {change.contracts.map((c) => <Mono key={c}>{c}</Mono>)}
        </div>
      )}
      <ol className="mt-4 grid gap-3 md:grid-cols-2">
        {change.tasks.map((t) => (
          <li key={t.id} className="rounded-xl border border-line bg-canvas/50 p-3">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-medium text-faint">{t.id}</span>
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                t.kind === "new" ? "bg-dev-bg text-dev" : "bg-check-bg text-check"}`}>
                {t.kind === "new" ? "New" : "Change"}
              </span>
              <span className="ml-auto"><Mono>{t.module}</Mono></span>
            </div>
            <p className="text-[15px] font-medium leading-snug">{t.title}</p>
            {t.depends_on.length > 0 && <p className="mt-1 text-xs text-faint">After {t.depends_on.join(", ")}</p>}
            <details className="mt-1.5">
              <summary className="cursor-pointer text-xs text-muted hover:text-ink">The spec</summary>
              <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-muted">{t.spec}</p>
            </details>
          </li>
        ))}
      </ol>
      {change.pages.length > 0 && (
        <p className="mt-3 text-xs text-faint">Pages checked after the change: {change.pages.join(", ")}</p>
      )}
    </section>
  );
}
