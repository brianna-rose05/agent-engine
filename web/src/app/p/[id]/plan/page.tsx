"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Check, FileCode2, Loader2, MessageSquareReply, ShieldCheck } from "lucide-react";
import { useProject } from "@/lib/project-store";
import { layers } from "@/lib/reduce";
import type { Plan } from "@/lib/types";
import { Avatar, Mono } from "@/components/ui";

export default function PlanPage() {
  const { state, approve, sendBack, project, liveStatus, liveError } = useProject();
  const router = useRouter();
  const [note, setNote] = useState("");
  const [replying, setReplying] = useState(false);
  const [busy, setBusy] = useState(false);
  const plan = state.plan;

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

  if (!plan) {
    return (
      <div className="mx-auto flex max-w-xl flex-col items-center gap-4 px-6 py-24 text-center">
        <Avatar who="planner" size={48} active />
        <h2 className="text-xl font-semibold tracking-tight">The planner is reading your description</h2>
        <p className="text-muted">
          It&apos;s splitting {project.name.toLowerCase()} into features that can be built in parallel, and writing the shared
          contract they&apos;ll all use. You&apos;ll approve it before anything is built.
        </p>
        <Loader2 className="animate-spin text-faint motion-reduce:animate-none" size={18} />
      </div>
    );
  }

  const waiting = state.status === "awaiting_approval";
  const parallelNow = layers(plan)[0]?.length ?? 0;

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-6 md:py-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-muted">The plan</p>
          <h2 className="text-2xl font-semibold tracking-tight">
            {plan.tasks.length} features, {parallelNow} can start right away
          </h2>
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
                  placeholder="What should the planner change? e.g. split rentals and waitlist into two features"
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
                <ShieldCheck className="text-you" size={20} strokeWidth={1.6} />
                <p className="mr-auto text-sm">
                  <span className="font-medium">Nothing is built until you approve.</span>{" "}
                  <span className="text-muted">Agents start the moment you do.</span>
                </p>
                <button
                  onClick={() => setReplying(true)}
                  className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted ring-1 ring-line hover:text-ink"
                >
                  <MessageSquareReply size={15} strokeWidth={1.6} /> Send back
                </button>
                <button
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    await approve();
                    router.push(`/p/${project.id}/board`);
                  }}
                  className="flex items-center gap-2 rounded-lg bg-ink px-4 py-2 text-sm font-medium text-white transition-transform duration-150 hover:-translate-y-px"
                >
                  <Check size={15} strokeWidth={2} /> Approve and build
                </button>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {!waiting && (
        <button
          onClick={() => router.push(`/p/${project.id}/board`)}
          className="mt-8 flex items-center gap-2 text-sm text-muted hover:text-ink"
        >
          {state.status === "rejected" ? "Plan sent back. The planner will revise it." : "Approved. Watch the board"}
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
                    <span className="text-[11px] font-medium text-faint">{t.id}</span>
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
