"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import { ArrowRight, ClipboardCheck, Code2, ShieldCheck, Sparkles } from "lucide-react";
import demo from "@/demo/garden.json";
import { Shell } from "@/components/Shell";
import { useMutation } from "convex/react";
import { api, liveEnabled, useOwner } from "@/lib/convex";
import { OwnerGate } from "@/components/OwnerGate";

const MODELS = [
  { id: "haiku", name: "Haiku", note: "Fast and cheap. About $0.10 for a small project.", recommended: true },
  { id: "sonnet", name: "Sonnet", note: "Stronger reasoning, about 4× the cost." },
];

export default function NewProjectPage() {
  return (
    <Shell>
      <OwnerGate>{liveEnabled ? <LiveForm /> : <NewProject create={null} />}</OwnerGate>
    </Shell>
  );
}

function LiveForm() {
  const { key } = useOwner();
  const create = useMutation(api.projects.create);
  return (
    <NewProject
      create={async (name, description, model) =>
        (await create({ key: key!, name, description, model })) as string}
    />
  );
}

type Create = ((name: string, description: string, model: "haiku" | "sonnet") => Promise<string>) | null;

function NewProject({ create }: { create: Create }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [model, setModel] = useState("haiku");
  const ready = name.trim().length > 0 && description.trim().length >= 20;

  const useSample = () => {
    setName(demo.project.name);
    setDescription(demo.project.description.replace(/^# .*\n+/, ""));
  };

  const start = async () => {
    if (!create) return router.push("/p/demo/plan");     // demo mode: the recorded run
    setBusy(true);
    setError("");
    try {
      const id = await create(name, description, model as "haiku" | "sonnet");
      router.push(`/p/${id}/plan`);
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^.*ConvexError: /, "").split("\n")[0] : "Couldn't start the project.");
      setBusy(false);
    }
  };

  return (
    <>
      <main className="mx-auto w-full max-w-3xl px-4 py-10 md:px-8 md:py-16">
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
          <p className="mb-2 text-sm text-muted">New project</p>
          <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">What should the team build?</h1>
          <p className="mt-3 max-w-xl text-muted">
            Describe it like you would to a developer. A planner splits it into features, you approve the plan, then QA and
            dev agents build it in parallel. Every feature is checked by tests the builder never sees.
          </p>
        </motion.div>

        <div className="mt-8 flex flex-col gap-5 rounded-2xl border border-line bg-surface p-5 shadow-[0_1px_2px_rgba(0,0,0,0.03)] md:p-6">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Project name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Community garden"
              className="rounded-xl border border-line bg-canvas px-3 py-2.5 text-[15px] outline-none transition-shadow duration-150 focus:ring-2 focus:ring-planner/25"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="flex items-baseline justify-between text-sm font-medium">
              Description
              <button type="button" onClick={useSample} className="text-xs font-normal text-planner hover:underline">
                Use the sample
              </button>
            </span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Who uses it, what they need to do, and the rules that matter (prices, limits, edge cases)."
              className="min-h-56 resize-y rounded-xl border border-line bg-canvas px-3 py-2.5 text-[15px] leading-relaxed outline-none transition-shadow duration-150 focus:ring-2 focus:ring-planner/25"
            />
          </label>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1.5 text-sm font-medium">Model for every agent</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {MODELS.map((m) => (
                <button
                  type="button"
                  key={m.id}
                  onClick={() => setModel(m.id)}
                  className={`rounded-xl border p-3 text-left transition-colors duration-150 ${
                    model === m.id ? "border-planner/40 bg-planner-bg/50 ring-1 ring-planner/30" : "border-line hover:bg-canvas"
                  }`}
                >
                  <p className="flex items-center gap-2 text-sm font-medium">
                    {m.name}
                    {m.recommended && <span className="rounded-full bg-dev-bg px-1.5 py-0.5 text-[11px] text-dev">Recommended</span>}
                  </p>
                  <p className="mt-0.5 text-xs text-muted">{m.note}</p>
                </button>
              ))}
            </div>
          </fieldset>

          <div className="flex flex-wrap items-center gap-3 border-t border-line pt-5">
            <p className={`mr-auto text-xs ${error ? "text-bad" : "text-muted"}`}>
              {error || (liveEnabled ? "Nothing is built until you approve the plan." : "Demo mode: this opens a replay of a real build.")}
            </p>
            <button
              disabled={!ready || busy}
              onClick={start}
              className="flex items-center gap-2 rounded-xl bg-ink px-5 py-2.5 text-sm font-medium text-white transition-all duration-150 hover:-translate-y-px disabled:translate-y-0 disabled:opacity-35"
            >
              {busy ? "Starting…" : "Plan it"} <ArrowRight size={15} />
            </button>
          </div>
        </div>

        <ol className="mt-10 grid gap-3 sm:grid-cols-3">
          {[
            { Icon: Sparkles, c: "bg-planner-bg text-planner", t: "1. You approve a plan", d: "Features, how they connect, and the shared contract." },
            { Icon: ClipboardCheck, c: "bg-qa-bg text-qa", t: "2. Tests come first", d: "QA agents write hidden tests for each feature." },
            { Icon: Code2, c: "bg-dev-bg text-dev", t: "3. Agents build in parallel", d: "Each feature merges only when its tests pass." },
          ].map((s) => (
            <li key={s.t} className="flex gap-3 rounded-2xl p-2">
              <span className={`grid size-9 shrink-0 place-items-center rounded-xl ${s.c}`}>
                <s.Icon size={17} strokeWidth={1.6} />
              </span>
              <div>
                <p className="text-sm font-medium">{s.t}</p>
                <p className="text-sm text-muted">{s.d}</p>
              </div>
            </li>
          ))}
        </ol>
        <p className="mt-6 flex items-center gap-2 text-xs text-faint">
          <ShieldCheck size={13} /> The engine never takes an agent&apos;s word for it.
        </p>
      </main>
    </>
  );
}
