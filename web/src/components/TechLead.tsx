"use client";

import { useState } from "react";
import { Loader2, RotateCcw } from "lucide-react";
import { useProject, anyRunning } from "@/lib/project-store";
import { modelName } from "@/lib/reduce";
import type { TaskState } from "@/lib/types";
import { ANSWER_MAX } from "../../convex/answers";
import { Avatar, WHO } from "./ui";

/** "Retried on Sonnet": the tech lead moved a feature's extra tries to a stronger model. */
export function RetriedOn({ model, compact = false }: { model?: string; compact?: boolean }) {
  if (!model) return null;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full bg-lead-bg font-medium text-lead ${
      compact ? "px-1.5 py-0.5 text-[11px]" : "px-2 py-0.5 text-xs"}`}>
      Retried on {modelName(model)}
    </span>
  );
}

/**
 * What the tech lead said about a feature that used all its tries (dev -> tech lead -> you): its guidance as a
 * message, and when it needs you, its question with an answer box that retries what failed.
 */
export function TechLeadThread({ task }: { task: TaskState }) {
  const review = task.review;
  const reviewing = task.status === "reviewing";
  if (!review && !reviewing && !task.question) return null;
  const w = WHO["tech lead"];
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-lead/20 bg-lead-bg/40 p-3">
      <div className="flex gap-3">
        <Avatar who="tech lead" size={26} active={reviewing} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-xs">
            <span className={`font-medium ${w.fg}`}>{w.label}</span>
            {review?.decision === "retry" && !review.error && <RetriedOn model={task.retry_model} compact />}
          </p>
          <p className="text-[13.5px] leading-relaxed text-ink/85">
            {reviewing
              ? "Reading the failed tries, the hidden tests and the code to decide what to do next."
              : review?.error
              ? "I couldn't review this feature (my run hit an error), so it comes to you."
              : review?.note || (review?.decision === "retry" ? "Trying again with a fresh look." : "This one needs your call.")}
          </p>
        </div>
      </div>
      {task.status === "failed" && task.question && <AnswerBox taskId={task.id} question={task.question} />}
    </div>
  );
}

function AnswerBox({ taskId, question }: { taskId: string; question: string }) {
  const { state, mode, canRetry, answers, answerAndRetry } = useProject();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const running = anyRunning(state);
  const length = text.trim().length;
  const blocked = mode === "demo" ? "This is a replay of a recorded run, so answers aren't sent anywhere."
    : running ? "The team is still at work. Answer once everything has stopped."
    : !canRetry ? "You can answer once the build has stopped." : null;
  const previous = answers[taskId];

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await answerAndRetry(taskId, text);
      setSent(true);
      setText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't send your answer. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  };

  const id = `answer-${taskId}`;
  return (
    <div className="flex flex-col gap-2 border-t border-lead/15 pt-3">
      <p className="text-[13.5px] font-medium leading-relaxed text-ink">{question}</p>
      {previous && <p className="text-xs text-muted">Your last answer: {previous}</p>}
      <label htmlFor={id} className="sr-only">Your answer for the tech lead</label>
      <textarea
        id={id}
        value={text}
        onChange={(e) => { setText(e.target.value); setSent(false); setError(null); }}
        maxLength={ANSWER_MAX}
        disabled={busy || sent}
        placeholder="Your answer, in plain words. The dev agent gets it on its next try."
        className="min-h-20 w-full resize-y rounded-xl border border-line bg-surface p-3 text-sm outline-none focus:ring-2 focus:ring-lead/30 disabled:opacity-60"
      />
      <div className="flex flex-wrap items-center gap-2">
        <p className={`mr-auto min-w-0 text-xs ${error ? "text-bad" : "text-faint"}`} role={error ? "alert" : undefined}>
          {error ?? (sent ? "Sent. The retry starts in about a minute." : blocked ?? `${length}/${ANSWER_MAX} characters`)}
        </p>
        <button
          disabled={busy || sent || Boolean(blocked) || length < 1}
          onClick={submit}
          className="flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" /> : <RotateCcw size={13} />}
          Answer and retry
        </button>
      </div>
    </div>
  );
}
