"use client";

import { useState } from "react";
import { GitPullRequestArrow, Loader2 } from "lucide-react";
import { EditGate, ViewOnlyNote } from "./Access";
import { useProject } from "@/lib/project-store";
import { CHANGE_TEXT_MAX, CHANGE_TEXT_MIN } from "../../convex/changes";

const when = (at: number) =>
  new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/**
 * Ask the team for a change to a finished project (docs/change-requests.md). Shown only when canChange: the project is
 * done, or stopped after planning, and nothing is running. The planner plans only the change; you approve it first.
 */
export function ChangeRequestBox({ compact = false }: { compact?: boolean }) {
  const { canChange, changeHistory, requestChange, mode } = useProject();
  const [open, setOpen] = useState(!compact);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [upgrade, setUpgrade] = useState(false);
  if (!canChange) return null;
  const length = text.trim().length;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await requestChange(text, upgrade);
      setText("");
      setUpgrade(false);
      setSent(true);
      if (compact) setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't send the change.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <EditGate>
    <section className="rounded-2xl border border-line bg-surface p-4" aria-labelledby="change-request-title">
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid size-7 place-items-center rounded-lg bg-planner-bg text-planner">
          <GitPullRequestArrow size={15} strokeWidth={1.7} />
        </span>
        <div className="mr-auto min-w-0">
          <h3 id="change-request-title" className="text-sm font-medium">Request a change</h3>
          <p className="text-xs text-muted">
            For features and data. The planner plans only the change, you approve it, and the team builds it in the
            same repo. Merged work stays.
          </p>
          <ViewOnlyNote className="mt-1" />
        </div>
        {!open && (
          <button onClick={() => setOpen(true)} className="rounded-lg bg-ink px-3 py-1.5 text-sm font-medium text-white">
            Describe a change
          </button>
        )}
      </div>

      {open && (
        <div className="mt-3 flex flex-col gap-2">
          <label htmlFor="change-text" className="sr-only">What should change?</label>
          <textarea
            id="change-text"
            value={text}
            onChange={(e) => { setText(e.target.value); setSent(false); }}
            maxLength={CHANGE_TEXT_MAX}
            placeholder="e.g. Keep the groomer when the date changes, store times in the salon's time zone, and show the My bookings heading once."
            className="min-h-24 w-full resize-y rounded-xl border border-line bg-canvas p-3 text-sm outline-none focus:ring-2 focus:ring-planner/30"
          />
          <label className="flex items-start gap-2 text-xs text-muted">
            <input type="checkbox" checked={upgrade} onChange={(e) => setUpgrade(e.target.checked)} className="mt-0.5" />
            <span>
              Also move this app to the latest template versions. Apps built on older versions keep them until you
              ask; the team then updates the app&apos;s code to match.
            </span>
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <p className={`mr-auto text-xs ${error ? "text-bad" : "text-faint"}`} role={error ? "alert" : undefined}>
              {error ?? (sent
                ? mode === "demo" ? "Noted. This is a replay, so the team won't pick it up." : "Sent. The planner starts in about a minute."
                : `${length}/${CHANGE_TEXT_MAX} characters`)}
            </p>
            {compact && (
              <button onClick={() => setOpen(false)} className="rounded-lg px-3 py-1.5 text-sm text-muted hover:text-ink">
                Cancel
              </button>
            )}
            <button
              disabled={busy || length < CHANGE_TEXT_MIN}
              onClick={submit}
              className="flex items-center gap-2 rounded-lg bg-ink px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40"
            >
              {busy && <Loader2 size={14} className="animate-spin motion-reduce:animate-none" />}
              Send to the planner
            </button>
          </div>
        </div>
      )}

      {changeHistory.length > 0 && (
        <ol className="mt-3 flex flex-col gap-1.5 border-t border-line pt-3" aria-label="Changes requested so far">
          {[...changeHistory].reverse().map((c) => (
            <li key={c.n} className="flex gap-3 text-[13px]">
              <span className="shrink-0 text-[11px] font-medium text-faint tabular-nums">Change {c.n}</span>
              <span className="min-w-0 flex-1 text-ink/85">
                {c.text}
                {c.upgradeTemplate && <span className="ml-1.5 text-xs text-faint">(and template update)</span>}
              </span>
              {c.by && <span className="shrink-0 text-xs text-faint">by {c.by.name}</span>}
              <span className="shrink-0 text-xs text-faint tabular-nums">{when(c.at)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
    </EditGate>
  );
}
