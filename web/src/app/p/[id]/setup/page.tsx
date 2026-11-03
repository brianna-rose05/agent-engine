"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertTriangle, ArrowRight, Check, Database, Layers, Loader2, Lock, MessageSquareReply, Palette, Plus, Route, Shield,
  Trash2, Users,
} from "lucide-react";
import { useAction, useMutation } from "convex/react";
import { api, useOwner } from "@/lib/convex";
import { useProject } from "@/lib/project-store";
import { Avatar } from "@/components/ui";
import type { Design, Feature, Priority, Question, Wizard } from "../../../../../convex/wizard";

type StepId = "describe" | "questions" | "requirements" | "stack" | "design" | "team";
const STEPS: { id: StepId; label: string }[] = [
  { id: "describe", label: "Describe" },
  { id: "questions", label: "Questions" },
  { id: "requirements", label: "Requirements" },
  { id: "stack", label: "Stack" },
  { id: "design", label: "Design" },
  { id: "team", label: "Team plan" },
];
const BUSY_TEXT: Record<string, string> = {
  questions: "Reading your description and picking the questions that matter",
  requirements: "Writing requirements from your answers",
  stack: "Matching a stack to your requirements",
  design: "Designing the data, pages and actions",
  loading: "Loading",
};

const errText = (e: unknown) =>
  e instanceof Error ? e.message.replace(/^.*ConvexError: /, "").split("\n")[0] : "Something went wrong.";

function useWizard() {
  const { key } = useOwner();
  const { project } = useProject();
  const id = project.id;
  const k = { key: key!, id };
  const m = {
    answer: useMutation(api.wizard.answer),
    lockQuestions: useMutation(api.wizard.lockQuestions),
    editStory: useMutation(api.wizard.editStory),
    editFeature: useMutation(api.wizard.editFeature),
    lockRequirements: useMutation(api.wizard.lockRequirements),
    lockStack: useMutation(api.wizard.lockStack),
    chooseLook: useMutation(api.wizard.chooseLook),
    lockDesign: useMutation(api.wizard.lockDesign),
    generateQuestions: useAction(api.wizard.generateQuestions),
    generateRequirements: useAction(api.wizard.generateRequirements),
    addStory: useAction(api.wizard.addStory),
    recommendStack: useAction(api.wizard.recommendStack),
    generateDesign: useAction(api.wizard.generateDesign),
  };
  return { k, m };
}

export default function SetupPage() {
  const { project, wizard, liveStatus, mode } = useProject();
  const current: StepId = liveStatus && liveStatus !== "draft" ? "team" : (wizard?.step ?? "questions");
  const [viewing, setViewing] = useState<StepId | null>(null);
  const shown = viewing ?? current;
  const reached = STEPS.findIndex((s) => s.id === current);

  if (mode === "demo") {
    return <Empty title="The replay starts at the plan" text="The recorded demo project skipped setup." />;
  }
  if (liveStatus === undefined) return <Busy what="loading" />;
  if (!wizard && liveStatus !== "draft") {
    return <Empty title="This project skipped setup" text="It was started straight from a description." />;
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 md:px-8 md:py-10">
      <ol className="mb-8 flex gap-1 overflow-x-auto pb-1">
        {STEPS.map((s, i) => {
          const done = i < reached;
          const on = s.id === shown;
          return (
            <li key={s.id} className="flex shrink-0 items-center gap-1">
              <button
                disabled={i > reached}
                onClick={() => setViewing(s.id === current ? null : s.id)}
                className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-sm transition-colors duration-150 ${
                  on ? "bg-surface font-medium text-ink shadow-sm ring-1 ring-line"
                    : done ? "text-ink hover:bg-surface/70" : "text-faint"
                }`}
              >
                <span className={`grid size-5 place-items-center rounded-full text-[11px] ${
                  done ? "bg-dev text-white" : on ? "bg-ink text-white" : "bg-line text-muted"}`}>
                  {done ? <Check size={12} strokeWidth={2.5} /> : i + 1}
                </span>
                {s.label}
              </button>
              {i < STEPS.length - 1 && <span className="h-px w-3 bg-line" />}
            </li>
          );
        })}
      </ol>

      <AnimatePresence mode="wait">
        <motion.div key={shown} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
          {wizard?.error && shown === current && hasDraft(wizard, current) && <ErrorBox text={wizard.error} />}
          {shown === "describe" && <DescribeStep name={project.name} description={project.description} />}
          {shown === "questions" && <QuestionsStep w={wizard!} readOnly={current !== "questions"} />}
          {shown === "requirements" && <RequirementsStep w={wizard!} readOnly={current !== "requirements"} />}
          {shown === "stack" && <StackStep w={wizard!} readOnly={current !== "stack"} />}
          {shown === "design" && <DesignStep w={wizard!} readOnly={current !== "design"} />}
          {shown === "team" && <TeamStep />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

/** Steps show their own error (with a retry) until they have a draft; after that errors show above it. */
const hasDraft = (w: Wizard, step: StepId) =>
  (step === "questions" && !!w.questions) || (step === "requirements" && !!w.requirements) ||
  (step === "stack" && !!w.stack) || (step === "design" && !!w.design);

/* ----------------------------------------------------------------- shared bits */
function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-3 px-6 py-24 text-center">
      <Avatar who="planner" size={48} />
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      <p className="text-muted">{text}</p>
    </div>
  );
}

function Busy({ what }: { what: string }) {
  return (
    <div className="flex flex-col items-center gap-4 py-20 text-center">
      <Avatar who="planner" size={48} active />
      <p className="text-lg font-medium tracking-tight">{BUSY_TEXT[what] ?? "Working"}…</p>
      <p className="max-w-md text-sm text-muted">Usually under a minute. The planner&apos;s draft is checked by code before you see it.</p>
      <Loader2 className="animate-spin text-faint motion-reduce:animate-none" size={18} />
    </div>
  );
}

function ErrorBox({ text, retry }: { text: string; retry?: () => void }) {
  return (
    <div className="mb-5 flex items-start gap-3 rounded-xl bg-bad-bg px-4 py-3 text-sm text-bad">
      <AlertTriangle size={16} className="mt-0.5 shrink-0" />
      <p className="flex-1">{text}</p>
      {retry && <button onClick={retry} className="font-medium underline">Try again</button>}
    </div>
  );
}

function Header({ title, text }: { title: string; text: string }) {
  return (
    <div className="mb-6">
      <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
      <p className="mt-1.5 max-w-2xl text-muted">{text}</p>
    </div>
  );
}

/** The approve bar at the bottom of each step, plus an optional "ask for changes" box. */
function ApproveBar({ label, onApprove, onComment, hint, readOnly, disabled }: {
  label: string; onApprove: () => Promise<unknown>; onComment?: (c: string) => Promise<unknown>; hint?: string;
  readOnly?: boolean; disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [comment, setComment] = useState("");
  const [open, setOpen] = useState(false);
  if (readOnly) {
    return <p className="mt-8 flex items-center gap-2 text-sm text-muted"><Lock size={14} /> Approved and locked.</p>;
  }
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true); setErr("");
    try { await f(); setComment(""); setOpen(false); } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  return (
    <div className="sticky bottom-0 mt-8 -mx-4 border-t border-line bg-canvas/90 px-4 py-4 backdrop-blur md:mx-0 md:rounded-2xl md:border md:bg-surface">
      {open && onComment && (
        <div className="mb-3 flex flex-col gap-2">
          <textarea autoFocus value={comment} onChange={(e) => setComment(e.target.value)}
            placeholder="What should change? e.g. “Staff should be able to cancel too” or “drop the reviews feature”"
            className="min-h-20 rounded-xl border border-line bg-canvas px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-planner/25" />
          <div className="flex justify-end gap-2">
            <button onClick={() => setOpen(false)} className="rounded-lg px-3 py-1.5 text-sm text-muted">Cancel</button>
            <button disabled={!comment.trim() || busy} onClick={() => run(() => onComment(comment))}
              className="rounded-lg bg-planner px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40">Revise it</button>
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <p className={`mr-auto text-xs ${err ? "text-bad" : "text-muted"}`}>{err || hint}</p>
        {onComment && !open && (
          <button onClick={() => setOpen(true)} className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm text-muted hover:text-ink">
            <MessageSquareReply size={15} /> Ask for changes
          </button>
        )}
        <button disabled={busy || disabled} onClick={() => run(onApprove)}
          className="flex items-center gap-2 rounded-xl bg-ink px-5 py-2.5 text-sm font-medium text-white transition-all duration-150 hover:-translate-y-px disabled:translate-y-0 disabled:opacity-35">
          {busy ? "Saving…" : label} <ArrowRight size={15} />
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- 1 describe */
function DescribeStep({ name, description }: { name: string; description: string }) {
  return (
    <>
      <Header title={name} text="What you described. Everything after this is drafted from it." />
      <p className="whitespace-pre-wrap rounded-2xl border border-line bg-surface p-5 text-[15px] leading-relaxed">{description}</p>
    </>
  );
}

/* ------------------------------------------------------------------ 2 questions */
function QuestionsStep({ w, readOnly }: { w: Wizard; readOnly: boolean }) {
  const { k, m } = useWizard();
  if (w.busy === "questions") return <Busy what="questions" />;
  if (!w.questions) {
    return <ErrorBox text={w.error ?? "No questions yet."} retry={() => m.generateQuestions(k)} />;
  }
  const musts = w.questions.filter((q) => q.gate === "must");
  const open = musts.filter((q) => !w.answers?.[q.id]).length;
  return (
    <>
      <Header title="A few questions first"
        text="Only the decisions your description leaves open. Each choice changes what gets built, and the planner's pick is pre-selected where it's safe to." />
      <div className="flex flex-col gap-4">
        {w.questions.map((q) => <QuestionCard key={q.id} q={q} w={w} readOnly={readOnly} />)}
      </div>
      {!!w.assumptions?.length && (
        <div className="mt-6 rounded-2xl border border-line bg-surface p-5">
          <p className="mb-2 text-sm font-medium">Assumed (no need to answer)</p>
          <ul className="flex flex-col gap-1.5 text-sm text-muted">
            {w.assumptions.map((a, i) => <li key={i} className="flex gap-2"><Check size={14} className="mt-0.5 shrink-0 text-dev" />{a.text}</li>)}
          </ul>
        </div>
      )}
      <ApproveBar label="Write the requirements" readOnly={readOnly} disabled={open > 0}
        hint={open ? `${open} required question${open > 1 ? "s" : ""} left` : "You can change anything later by asking for changes."}
        onApprove={() => m.lockQuestions(k)} />
    </>
  );
}

function QuestionCard({ q, w, readOnly }: { q: Question; w: Wizard; readOnly: boolean }) {
  const { k, m } = useWizard();
  const a = w.answers?.[q.id];
  const [other, setOther] = useState(a?.other ?? "");
  const pick = (option?: number, text?: string) => m.answer({ ...k, qid: q.id, option, other: text });
  return (
    <div className="rounded-2xl border border-line bg-surface p-5">
      <div className="mb-3 flex items-start gap-2">
        <p className="flex-1 font-medium">{q.question}</p>
        {q.gate === "must" && !a && <span className="rounded-full bg-you-bg px-2 py-0.5 text-[11px] text-you">Required</span>}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {q.options.map((o, i) => {
          const on = a?.option === i && !a?.other;
          return (
            <button key={i} disabled={readOnly} onClick={() => pick(i)}
              className={`rounded-xl border p-3 text-left transition-colors duration-150 ${
                on ? "border-planner/40 bg-planner-bg/50 ring-1 ring-planner/30" : "border-line hover:bg-canvas"} disabled:cursor-default`}>
              <p className="flex items-center gap-2 text-sm font-medium">
                {o.label}
                {i === q.recommended && <span className="rounded-full bg-dev-bg px-1.5 py-0.5 text-[11px] text-dev">Recommended</span>}
              </p>
              <p className="mt-0.5 text-xs text-muted">{o.changes}</p>
            </button>
          );
        })}
      </div>
      <p className="mt-3 text-xs text-muted">Why recommended: {q.reason}</p>
      {!readOnly && (
        <input value={other} onChange={(e) => setOther(e.target.value)} onBlur={() => other.trim() && other !== a?.other && pick(undefined, other)}
          placeholder="Something else? Type it here"
          className="mt-3 w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-planner/25" />
      )}
      {readOnly && a?.other && <p className="mt-2 text-sm">Your answer: {a.other}</p>}
    </div>
  );
}

/* --------------------------------------------------------------- 3 requirements */
const PRI: { id: Priority; label: string; c: string }[] = [
  { id: "must", label: "Must", c: "bg-you-bg text-you" },
  { id: "should", label: "Should", c: "bg-qa-bg text-qa" },
  { id: "could", label: "Could", c: "bg-canvas text-muted" },
  { id: "out", label: "Out", c: "bg-canvas text-faint line-through" },
];

function RequirementsStep({ w, readOnly }: { w: Wizard; readOnly: boolean }) {
  const { k, m } = useWizard();
  if (w.busy === "requirements" && !w.requirements) return <Busy what="requirements" />;
  if (!w.requirements) return <ErrorBox text={w.error ?? "No requirements yet."} retry={() => m.generateRequirements(k)} />;
  const stories = w.requirements.features.flatMap((f) => f.stories);
  const count = (p: Priority) => stories.filter((s) => s.priority === p).length;
  return (
    <>
      <Header title="Requirements"
        text="What the app must do, as stories with checks a test can prove. Musts are built first; Out is skipped. Change priorities, edit, or ask for changes." />
      <p className="mb-4 flex flex-wrap gap-2 text-xs">
        {PRI.map((p) => <span key={p.id} className={`rounded-full px-2 py-0.5 ${p.c}`}>{count(p.id)} {p.label}</span>)}
        {w.busy === "requirements" && <span className="flex items-center gap-1 text-planner"><Loader2 size={12} className="animate-spin" /> Revising…</span>}
      </p>
      <div className="flex flex-col gap-5">
        {w.requirements.features.map((f) => <FeatureCard key={f.id} f={f} w={w} readOnly={readOnly} />)}
      </div>
      {!readOnly && (
        <button onClick={() => m.editFeature({ ...k, name: "New feature" })}
          className="mt-4 flex items-center gap-1.5 text-sm text-muted hover:text-ink"><Plus size={14} /> Add a feature</button>
      )}
      {!!w.requirements.assumptions.length && (
        <div className="mt-6 rounded-2xl border border-line bg-surface p-5 text-sm">
          <p className="mb-2 font-medium">Assumptions</p>
          <ul className="list-disc pl-5 text-muted">{w.requirements.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul>
        </div>
      )}
      <ApproveBar label="Approve requirements" readOnly={readOnly} disabled={w.busy === "requirements"}
        hint={`${count("must")} Must and ${count("should")} Should stories will be built.`}
        onApprove={() => m.lockRequirements(k)}
        onComment={(comment) => m.generateRequirements({ ...k, comment })} />
    </>
  );
}

function FeatureCard({ f, w, readOnly }: { f: Feature; w: Wizard; readOnly: boolean }) {
  const { k, m } = useWizard();
  const [line, setLine] = useState("");
  const [adding, setAdding] = useState(false);
  const changed = new Set(w.changed ?? []);
  return (
    <section className={`rounded-2xl border bg-surface ${changed.has(f.id) ? "border-planner/40" : "border-line"}`}>
      <header className="flex items-start gap-3 border-b border-line px-5 py-3">
        <div className="flex-1">
          {readOnly ? <p className="font-medium">{f.name}</p> : (
            <input defaultValue={f.name} onBlur={(e) => e.target.value !== f.name && m.editFeature({ ...k, featureId: f.id, name: e.target.value })}
              className="w-full bg-transparent font-medium outline-none" />
          )}
          {f.summary && <p className="text-sm text-muted">{f.summary}</p>}
        </div>
        {!readOnly && (
          <button title="Remove feature" onClick={() => m.editFeature({ ...k, featureId: f.id, remove: true })}
            className="text-faint hover:text-bad"><Trash2 size={15} /></button>
        )}
      </header>
      <ul className="divide-y divide-line">
        {f.stories.map((s) => (
          <li key={s.id} className={`px-5 py-3 ${changed.has(s.id) ? "bg-planner-bg/40" : ""} ${s.priority === "out" ? "opacity-55" : ""}`}>
            <div className="flex flex-wrap items-start gap-2">
              <p className="flex-1 text-[15px]"><span className="mr-2 font-mono text-[11px] text-faint">{s.id}</span>{s.text}</p>
              <div className="flex gap-0.5 rounded-lg bg-canvas p-0.5">
                {PRI.map((p) => (
                  <button key={p.id} disabled={readOnly} onClick={() => m.editStory({ ...k, storyId: s.id, priority: p.id })}
                    className={`rounded-md px-2 py-0.5 text-[11px] ${s.priority === p.id ? p.c.replace("line-through", "") + " font-medium ring-1 ring-line" : "text-faint"}`}>
                    {p.label}
                  </button>
                ))}
              </div>
              {!readOnly && (
                <button title="Remove story" onClick={() => m.editStory({ ...k, storyId: s.id, remove: true })} className="text-faint hover:text-bad">
                  <Trash2 size={14} />
                </button>
              )}
            </div>
            <ul className="mt-1.5 flex flex-col gap-0.5 pl-1 text-sm text-muted">
              {s.criteria.map((c, i) => <li key={i} className="flex gap-2"><Check size={13} className="mt-1 shrink-0 text-faint" />{c}</li>)}
            </ul>
          </li>
        ))}
      </ul>
      {!readOnly && (
        <div className="px-5 py-3">
          {adding ? (
            <form className="flex gap-2" onSubmit={async (e) => {
              e.preventDefault(); if (!line.trim()) return;
              setAdding(false); await m.addStory({ ...k, featureId: f.id, line }); setLine("");
            }}>
              <input autoFocus value={line} onChange={(e) => setLine(e.target.value)} placeholder="e.g. customers can leave a review"
                className="flex-1 rounded-lg border border-line bg-canvas px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-planner/25" />
              <button className="rounded-lg bg-ink px-3 py-1.5 text-sm text-white">Add</button>
            </form>
          ) : (
            <button onClick={() => setAdding(true)} className="flex items-center gap-1.5 text-sm text-muted hover:text-ink">
              <Plus size={14} /> Add a story
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------------- 4 stack */
function StackStep({ w, readOnly }: { w: Wizard; readOnly: boolean }) {
  const { k, m } = useWizard();
  if (w.busy === "stack" || (!w.stack && !w.error)) return <Busy what="stack" />;
  if (!w.stack) return <ErrorBox text={w.error ?? ""} retry={() => m.recommendStack(k)} />;
  return (
    <>
      <Header title="Stack" text={w.stack.summary} />
      <div className="overflow-hidden rounded-2xl border border-line bg-surface">
        {w.stack.layers.map((l) => (
          <div key={l.layer} className="grid gap-1 border-b border-line px-5 py-4 last:border-0 md:grid-cols-[140px_1fr]">
            <p className="text-sm text-muted">{l.layer}</p>
            <div>
              <p className="flex items-center gap-2 font-medium">{l.choice}
                <span className="rounded-full bg-dev-bg px-1.5 py-0.5 text-[11px] text-dev">{l.tier}</span></p>
              <p className="mt-0.5 text-sm text-muted">{l.reason}</p>
              {!!l.alternatives.length && (
                <p className="mt-1.5 text-xs text-faint">Also planned: {l.alternatives.map((a) => a.name).join(", ")} (coming soon)</p>
              )}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-muted">Only Verified stacks can be built today: they have a template, tests that run in every sandbox, and a proven build.</p>
      <ApproveBar label="Approve stack" readOnly={readOnly} onApprove={() => m.lockStack(k)} hint="Next: the data model, pages and actions." />
    </>
  );
}

/* --------------------------------------------------------------------- 5 design */
function DesignStep({ w, readOnly }: { w: Wizard; readOnly: boolean }) {
  const { k, m } = useWizard();
  const [tab, setTab] = useState<"data" | "pages" | "actions" | "look">("data");
  if (w.busy === "design" && !w.design) return <Busy what="design" />;
  if (!w.design) return <ErrorBox text={w.error ?? "No design yet."} retry={() => m.generateDesign(k)} />;
  const d: Design = w.design;
  const TABS = [
    { id: "data", label: `Data (${d.tables.length})`, Icon: Database },
    { id: "pages", label: `Pages and flows (${d.pages.length})`, Icon: Route },
    { id: "actions", label: `Actions (${d.actions.length})`, Icon: Users },
    { id: "look", label: "Look", Icon: Palette },
  ] as const;
  return (
    <>
      <Header title="Design" text="What the app stores, the pages people see, and who can do what. The team builds exactly this." />
      <div className="mb-4 flex flex-wrap gap-1">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm ${tab === t.id ? "bg-surface font-medium ring-1 ring-line" : "text-muted"}`}>
            <t.Icon size={14} /> {t.label}
          </button>
        ))}
        {w.busy === "design" && <span className="flex items-center gap-1 text-sm text-planner"><Loader2 size={13} className="animate-spin" /> Revising…</span>}
      </div>

      {tab === "data" && (
        <div className="grid gap-4 md:grid-cols-2">
          {d.tables.map((t) => (
            <div key={t.name} className="rounded-2xl border border-line bg-surface p-4">
              <p className="font-mono text-sm font-medium">{t.name}</p>
              <p className="mb-2 text-sm text-muted">{t.purpose}</p>
              <ul className="flex flex-col gap-1 text-sm">
                {t.fields.map((f) => (
                  <li key={f.name} title={f.why} className="flex gap-2">
                    <span className="font-mono text-[13px]">{f.name}</span>
                    <span className="text-xs text-faint">{f.type}</span>
                    <span className="truncate text-xs text-muted">{f.why}</span>
                  </li>
                ))}
              </ul>
              <ul className="mt-3 flex flex-col gap-1 border-t border-line pt-2 text-xs text-muted">
                {t.security.map((r, i) => <li key={i} className="flex gap-1.5"><Shield size={12} className="mt-0.5 shrink-0 text-dev" />{r}</li>)}
              </ul>
            </div>
          ))}
        </div>
      )}

      {tab === "pages" && (
        <>
          <div className="grid gap-3 md:grid-cols-2">
            {d.pages.map((p) => (
              <div key={p.id} className="rounded-2xl border border-line bg-surface p-4">
                <p className="font-medium">{p.name} <span className="font-mono text-xs text-faint">{p.route}</span></p>
                <p className="text-sm text-muted">{p.purpose}</p>
                <p className="mt-2 text-xs text-faint">Stories {p.stories.join(", ") || "none"} · uses {p.tables.join(", ") || "no tables"}</p>
              </div>
            ))}
          </div>
          {!!d.flows.length && (
            <div className="mt-4 flex flex-col gap-2">
              {d.flows.map((f) => (
                <div key={f.name} className="flex flex-wrap items-center gap-1.5 rounded-xl bg-surface px-4 py-2.5 text-sm ring-1 ring-line">
                  <span className="mr-2 font-medium">{f.name}</span>
                  {f.steps.map((s, i) => (
                    <span key={i} className="flex items-center gap-1.5">
                      <span className="rounded-md bg-canvas px-2 py-0.5 text-xs">{d.pages.find((p) => p.id === s)?.name ?? s}</span>
                      {i < f.steps.length - 1 && <ArrowRight size={12} className="text-faint" />}
                    </span>
                  ))}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {tab === "actions" && (
        <div className="flex flex-col gap-4">
          {[...new Set(d.actions.map((a) => a.who))].map((who) => (
            <div key={who} className="rounded-2xl border border-line bg-surface p-4">
              <p className="mb-2 font-medium">{who}</p>
              <ul className="flex flex-col gap-1.5 text-sm">
                {d.actions.filter((a) => a.who === who).map((a) => (
                  <li key={a.id} className="flex gap-2">
                    <span className={`mt-0.5 h-fit rounded px-1.5 text-[11px] ${a.kind === "write" ? "bg-engine-bg text-engine" : "bg-qa-bg text-qa"}`}>{a.kind}</span>
                    <span className="flex-1">{a.sentence}</span>
                    <span className="text-xs text-faint">{d.pages.find((p) => p.id === a.page)?.name}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {tab === "look" && (
        <div className="grid gap-3 md:grid-cols-3">
          {d.looks.map((l) => {
            const on = (w.look ?? d.looks[0]?.id) === l.id;
            return (
              <button key={l.id} disabled={readOnly} onClick={() => m.chooseLook({ ...k, look: l.id })}
                className={`rounded-2xl border bg-surface p-4 text-left ${on ? "border-planner/40 ring-2 ring-planner/30" : "border-line"}`}>
                <div className="mb-3 flex overflow-hidden rounded-lg" style={{ borderRadius: l.radius }}>
                  {l.palette.map((c) => <span key={c.hex + c.name} title={c.name} className="h-10 flex-1" style={{ background: c.hex }} />)}
                </div>
                <p className="font-medium">{l.name}</p>
                <p className="text-sm text-muted">{l.description}</p>
                <p className="mt-1 text-xs text-faint">{l.font} · corners {l.radius}</p>
              </button>
            );
          })}
        </div>
      )}

      <ApproveBar label="Approve design and start the team" readOnly={readOnly} disabled={w.busy === "design"}
        hint="The planner turns this into tasks; you approve those before anything is built."
        onApprove={() => m.lockDesign(k)} onComment={(comment) => m.generateDesign({ ...k, comment })} />
    </>
  );
}

/* ----------------------------------------------------------------- 6 team plan */
function TeamStep() {
  const router = useRouter();
  const { project } = useProject();
  return (
    <div className="flex flex-col items-center gap-4 py-16 text-center">
      <Avatar who="planner" size={48} active />
      <h2 className="text-xl font-semibold tracking-tight">Setup is locked. The team is planning.</h2>
      <p className="max-w-md text-muted">
        The planner is splitting your requirements and design into tasks with tests. You&apos;ll approve the task plan next.
      </p>
      <button onClick={() => router.push(`/p/${project.id}/plan`)}
        className="flex items-center gap-2 rounded-xl bg-ink px-5 py-2.5 text-sm font-medium text-white">
        <Layers size={15} /> Open the team plan
      </button>
    </div>
  );
}
