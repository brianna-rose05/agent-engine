import { Bot, ClipboardCheck, ClipboardList, Code2, Cog, Compass, Sparkles, User } from "lucide-react";
import type { Role } from "@/lib/types";

export type Who = Role | "engine" | "you" | "tech lead" | "PM";

export const WHO: Record<Who, { label: string; bg: string; fg: string; Icon: typeof Bot }> = {
  planner: { label: "Planner", bg: "bg-planner-bg", fg: "text-planner", Icon: Sparkles },
  qa: { label: "QA agent", bg: "bg-qa-bg", fg: "text-qa", Icon: ClipboardCheck },
  dev: { label: "Dev agent", bg: "bg-dev-bg", fg: "text-dev", Icon: Code2 },
  "tech lead": { label: "Tech lead", bg: "bg-lead-bg", fg: "text-lead", Icon: Compass },
  PM: { label: "PM", bg: "bg-pm-bg", fg: "text-pm", Icon: ClipboardList },
  engine: { label: "Engine", bg: "bg-engine-bg", fg: "text-engine", Icon: Cog },
  you: { label: "You", bg: "bg-you-bg", fg: "text-you", Icon: User },
};

export function Avatar({ who, size = 28, active = false }: { who: Who; size?: number; active?: boolean }) {
  const w = WHO[who];
  return (
    <span
      title={w.label}
      className={`inline-grid shrink-0 place-items-center rounded-full ${w.bg} ${w.fg} ${active ? "breathe" : ""}`}
      style={{ width: size, height: size }}
    >
      <w.Icon size={size * 0.52} strokeWidth={1.6} />
    </span>
  );
}

const PILL: Record<string, string> = {
  draft: "bg-planner-bg text-planner",
  queued: "bg-canvas text-muted",
  planning: "bg-planner-bg text-planner",
  awaiting_approval: "bg-you-bg text-you",
  building: "bg-dev-bg text-dev",
  shipping: "bg-qa-bg text-qa",
  done: "bg-dev-bg text-dev",
  rejected: "bg-canvas text-muted",
  failed: "bg-bad-bg text-bad",
  stopped: "bg-you-bg text-you",
};
const PILL_TEXT: Record<string, string> = {
  draft: "Setting up",
  queued: "Queued",
  planning: "Planning",
  awaiting_approval: "Needs your approval",
  building: "Building",
  shipping: "Shipping",
  done: "Done",
  rejected: "Plan sent back",
  failed: "Needs attention",
  stopped: "Spending limit reached",
};

export function StatusPill({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${PILL[status] ?? PILL.queued}`}>
      <span className="size-1.5 rounded-full bg-current" />
      {PILL_TEXT[status] ?? status}
    </span>
  );
}

/** One task's status (board drawer): the engine's word for it, in plain English. */
const TASK_PILL: Record<string, [string, string]> = {
  queued: ["Up next", "bg-canvas text-muted"],
  working: ["Working", "bg-dev-bg text-dev"],
  checking: ["Checking", "bg-check-bg text-check"],
  disputing: ["Referee checking the tests", "bg-check-bg text-check"],
  reviewing: ["Tech lead reviewing", "bg-lead-bg text-lead"],
  merging: ["Merging", "bg-check-bg text-check"],
  merged: ["Merged", "bg-dev-bg text-dev"],
  passed: ["Tests accepted", "bg-qa-bg text-qa"],
  failed: ["Failed", "bg-bad-bg text-bad"],
  blocked: ["Paused", "bg-bad-bg text-bad"],
  error: ["Error", "bg-bad-bg text-bad"],
  stopped: ["Stopped at the limit", "bg-you-bg text-you"],
};

export function TaskStatusPill({ status }: { status?: string }) {
  const [text, cls] = status ? TASK_PILL[status] ?? [status, TASK_PILL.queued[1]] : ["Not started", TASK_PILL.queued[1]];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      <span className="size-1.5 rounded-full bg-current" />
      {text}
    </span>
  );
}

export function Mono({ children }: { children: React.ReactNode }) {
  return <code className="rounded-md bg-canvas px-1.5 py-0.5 font-mono text-[12px] text-muted">{children}</code>;
}
