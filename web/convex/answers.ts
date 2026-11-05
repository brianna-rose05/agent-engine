/*
 * Owner answers to the tech lead's questions (the escalation ladder: dev -> tech lead -> you). When the tech lead
 * escalates a failed feature, its question reaches the owner; the owner's answer is stored on the project row
 * (`answers: {taskId: text}`) and the next retry run hands it to that task's dev agent (worker.py resume).
 * Pure functions only, so Convex (projects.answerAndRetry) and the tests share the same rules.
 */

import { budgetOf, canSpendMore } from "./budget";

export const ANSWER_MAX = 2000;

/** Why a project can't retry what failed now, or null when it can. Shared by retryFailed and answerAndRetry. */
export function retryBlocker(p: { status: string; plan?: unknown; costUsd: number; budgetUsd?: number } | null): string | null {
  // stopped at the spending limit retries like failed, once the limit has room again
  if (!p || !["failed", "stopped"].includes(p.status) || !p.plan) return "Only a build that stopped after planning can be retried.";
  if (!canSpendMore(p.costUsd, budgetOf(p))) {
    return "This project has spent its limit. Raise the spending limit on the plan page, then retry.";
  }
  return null;
}

/** What a retry sets on the row: mode back to a plain build/retry, so projectForWorker doesn't take it for a change. */
export const RETRY_PATCH = { status: "queued", resume: true, mode: undefined, error: undefined };

export type Answers = Record<string, string>;

/** The answer text, trimmed, or the message to show the owner when it can't be used. */
export function checkAnswerText(text: string): { ok: true; text: string } | { ok: false; message: string } {
  const t = (text ?? "").trim();
  if (t.length < 1) return { ok: false, message: "Write an answer for the tech lead first." };
  if (t.length > ANSWER_MAX) return { ok: false, message: `Keep the answer under ${ANSWER_MAX} characters.` };
  return { ok: true, text: t };
}

type TaskEvent = { kind: string; taskId?: string | null; task_id?: string | null; data?: unknown };

/** The tasks whose latest state is failed (a later task_queued, e.g. a retry run, means it isn't failed any more). */
export function failedTasks(events: TaskEvent[]): Set<string> {
  const last = new Map<string, string>();
  for (const e of events) {
    const id = e.taskId ?? e.task_id;
    if (!id) continue;
    if (e.kind === "task_queued") last.set(id, "queued");
    if (e.kind === "task_status") {
      const status = (e.data as { status?: unknown } | null)?.status;
      if (typeof status === "string") last.set(id, status);
    }
  }
  return new Set([...last].filter(([, s]) => s === "failed").map(([id]) => id));
}

/** Whether an answer can be sent for this task: the text is usable and the task's latest state is failed. */
export function checkAnswer(taskId: string, text: string, failed: Set<string>):
    { ok: true; text: string } | { ok: false; message: string } {
  if (!failed.has(taskId)) {
    return { ok: false, message: "That feature isn't waiting for an answer. Only a feature that failed can be answered." };
  }
  return checkAnswerText(text);
}

/** The answers with this task's answer set (a later answer for the same task replaces the earlier one). */
export const withAnswer = (answers: Answers | undefined, taskId: string, text: string): Answers => ({ ...(answers ?? {}), [taskId]: text });
