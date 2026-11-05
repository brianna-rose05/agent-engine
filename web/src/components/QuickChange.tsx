"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { ArrowRight, Loader2, Zap } from "lucide-react";
import { anyRunning, useProject } from "@/lib/project-store";
import { api, useOwner } from "@/lib/convex";
import type { QuickState } from "@/lib/types";
import {
  QUICK_TEXT_MAX, QUICK_TEXT_MIN, canRequestQuickChange, checkQuickText, nextQuickNumber, type QuickChange,
} from "../../convex/quick";

const when = (at: number) =>
  new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

type Result = QuickState["result"] | "queued" | "replay";

const RESULT: Record<Result, { label: string; tone: string }> = {
  queued: { label: "Starting", tone: "text-faint" },
  running: { label: "Running", tone: "text-dev" },
  done: { label: "Merged", tone: "text-dev" },
  failed: { label: "Didn't pass the checks", tone: "text-bad" },
  blocked: { label: "Needs a change request", tone: "text-engine" },
  replay: { label: "Noted (replay)", tone: "text-faint" },
};

/**
 * Ask for a quick change to a finished app (engine/quick.py): wording, colors, spacing, labels, a missing link. One
 * dev agent edits only the pages and components, the whole app is checked, and it merges without an approval. Sits
 * next to the "Request a change" box, which is for features and data. When the agent finds a request is bigger than
 * that, one click sends the same words as a change request.
 */
export function QuickChangeBox({ compact = false }: { compact?: boolean }) {
  const { mode } = useProject();
  return mode === "live" ? <LiveQuick compact={compact} /> : <DemoQuick compact={compact} />;
}

function LiveQuick({ compact }: { compact: boolean }) {
  const { project } = useProject();
  const { key } = useOwner();
  const data = useQuery(api.quick.forProject, key ? { key, id: project.id } : "skip") as
    { canQuick: boolean; quicks: QuickChange[] } | null | undefined;
  const ask = useMutation(api.quick.requestQuickChange);
  const send = async (text: string) => {
    const checked = checkQuickText(text);
    if (!checked.ok) throw new Error(checked.message);
    try {
      await ask({ key: key!, id: project.id, text: checked.text });
    } catch (e) {
      const msg = (e as { data?: unknown })?.data;
      throw new Error(typeof msg === "string" ? msg : "Couldn't send the quick change. Try again in a moment.");
    }
  };
  return <QuickView compact={compact} canQuick={Boolean(data?.canQuick)} history={data?.quicks ?? []} send={send} />;
}

/** The demo is a recording: a quick change is kept on this page only, no agent picks it up. */
function DemoQuick({ compact }: { compact: boolean }) {
  const { state } = useProject();
  const [history, setHistory] = useState<QuickChange[]>([]);
  const send = async (text: string) => {
    const checked = checkQuickText(text);
    if (!checked.ok) throw new Error(checked.message);
    setHistory((h) => [...h, { n: nextQuickNumber(h), text: checked.text, at: Date.now() }]);
  };
  const canQuick = canRequestQuickChange(state.status, Boolean(state.plan), anyRunning(state));
  return <QuickView compact={compact} canQuick={canQuick} history={history} send={send} replay />;
}

function QuickView({ compact, canQuick, history, send, replay = false }: {
  compact: boolean; canQuick: boolean; history: QuickChange[]; send: (text: string) => Promise<void>; replay?: boolean;
}) {
  const { state, canChange, requestChange } = useProject();
  const [open, setOpen] = useState(!compact);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [escalated, setEscalated] = useState<Record<number, "sending" | "sent" | string>>({});
  if (!canQuick && history.length === 0) return null;
  const length = text.trim().length;

  // The engine's events say how a run is going; the project row keeps the result once it has finished.
  const resultOf = (q: QuickChange): Result =>
    replay ? "replay" : state.quicks.find((x) => x.n === q.n)?.result ?? q.result ?? "queued";
  const reasonOf = (q: QuickChange) => state.quicks.find((x) => x.n === q.n)?.reason ?? q.reason;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await send(text);
      setText("");
      setSent(true);
      if (compact) setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't send the quick change.");
    } finally {
      setBusy(false);
    }
  };

  const escalate = async (q: QuickChange) => {
    setEscalated((m) => ({ ...m, [q.n]: "sending" }));
    try {
      await requestChange(q.text);
      setEscalated((m) => ({ ...m, [q.n]: "sent" }));
    } catch (e) {
      setEscalated((m) => ({ ...m, [q.n]: e instanceof Error ? e.message : "Couldn't send the change request." }));
    }
  };

  return (
    <section className="rounded-2xl border border-line bg-surface p-4" aria-labelledby="quick-change-title">
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid size-7 place-items-center rounded-lg bg-dev-bg text-dev">
          <Zap size={15} strokeWidth={1.7} />
        </span>
        <div className="mr-auto min-w-0">
          <h3 id="quick-change-title" className="text-sm font-medium">Quick change</h3>
          <p className="text-xs text-muted">
            For wording, colors, spacing and links. One agent edits the pages, the whole app is checked, and it merges
            in minutes. No plan or approval.
          </p>
        </div>
        {canQuick && !open && (
          <button onClick={() => setOpen(true)} className="rounded-lg bg-ink px-3 py-1.5 text-sm font-medium text-white">
            Make a quick change
          </button>
        )}
      </div>

      {canQuick && open && (
        <div className="mt-3 flex flex-col gap-2">
          <label htmlFor="quick-text" className="sr-only">What should look or read differently?</label>
          <textarea
            id="quick-text"
            value={text}
            onChange={(e) => { setText(e.target.value); setSent(false); }}
            maxLength={QUICK_TEXT_MAX}
            placeholder={'e.g. Rename "Create an account" to "Join", and make the Book button green.'}
            className="min-h-16 w-full resize-y rounded-xl border border-line bg-canvas p-3 text-sm outline-none focus:ring-2 focus:ring-dev/30"
          />
          <div className="flex flex-wrap items-center gap-2">
            <p className={`mr-auto text-xs ${error ? "text-bad" : "text-faint"}`} role={error ? "alert" : undefined}>
              {error ?? (sent
                ? replay ? "Noted. This is a replay, so no agent will pick it up." : "Sent. A dev agent starts in about a minute."
                : `${length}/${QUICK_TEXT_MAX} characters`)}
            </p>
            {compact && (
              <button onClick={() => setOpen(false)} className="rounded-lg px-3 py-1.5 text-sm text-muted hover:text-ink">
                Cancel
              </button>
            )}
            <button
              disabled={busy || length < QUICK_TEXT_MIN}
              onClick={submit}
              className="flex items-center gap-2 rounded-lg bg-ink px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40"
            >
              {busy && <Loader2 size={14} className="animate-spin motion-reduce:animate-none" />}
              Send to a dev agent
            </button>
          </div>
        </div>
      )}

      {history.length > 0 && (
        <ol className="mt-3 flex flex-col gap-2 border-t border-line pt-3" aria-label="Quick changes so far">
          {[...history].reverse().map((q) => {
            const result = resultOf(q);
            const reason = reasonOf(q);
            const esc = escalated[q.n];
            const latest = q.n === history.at(-1)?.n;
            return (
              <li key={q.n} className="flex flex-col gap-1 text-[13px]">
                <div className="flex gap-3">
                  <span className="shrink-0 text-[11px] font-medium text-faint tabular-nums">Quick {q.n}</span>
                  <span className="min-w-0 flex-1 text-ink/85">{q.text}</span>
                  <span className={`shrink-0 text-xs ${RESULT[result].tone}`}>{RESULT[result].label}</span>
                  <span className="shrink-0 text-xs text-faint tabular-nums">{when(q.at)}</span>
                </div>
                {result === "blocked" && (
                  <div className="ml-12 flex flex-wrap items-center gap-2 rounded-lg bg-engine-bg px-3 py-2 text-xs text-ink/80">
                    <span className="mr-auto min-w-0">
                      {`This ${reason ?? "needs a change request"}.`}{" "}
                      Nothing was changed.
                    </span>
                    {esc === "sent" ? (
                      <span className="text-dev">Sent as a change request</span>
                    ) : latest && canChange ? (
                      <button
                        disabled={esc === "sending"}
                        onClick={() => escalate(q)}
                        className="flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1 font-medium text-white disabled:opacity-40"
                      >
                        {esc === "sending" ? <Loader2 size={12} className="animate-spin motion-reduce:animate-none" /> : <ArrowRight size={12} />}
                        Send as a change request instead
                      </button>
                    ) : null}
                    {esc && esc !== "sending" && esc !== "sent" && <span role="alert" className="w-full text-bad">{esc}</span>}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
