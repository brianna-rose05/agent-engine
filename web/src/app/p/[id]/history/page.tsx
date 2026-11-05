"use client";

import { History } from "lucide-react";
import { useMutation } from "convex/react";
import { api, useOwner } from "@/lib/convex";
import { anyRunning, useProject } from "@/lib/project-store";
import { CheckpointList } from "@/components/Checkpoints";
import { Avatar } from "@/components/ui";
import { canRollback } from "../../../../../convex/checkpoints";

/** Message of a Convex error (ConvexError's data is the friendly text), or a generic one. */
function errorText(e: unknown): string {
  const data = (e as { data?: unknown })?.data;
  return typeof data === "string" ? data : "Couldn't start the rollback. Try again in a moment.";
}

/** Rolling back starts a worker, so only the live app can; it needs Convex, which the replay doesn't have. */
function LiveHistory() {
  const { state, project, t0, liveStatus } = useProject();
  const { key } = useOwner();
  const rollbackTo = useMutation(api.checkpoints.rollbackTo);
  const status = liveStatus ?? state.status;
  const allowed = canRollback(status, anyRunning(state));
  return (
    <CheckpointList
      history={state.history}
      t0={t0}
      blocked={allowed ? undefined : "You can roll back once the team has finished what it's doing."}
      onRollback={allowed ? async (n) => {
        try {
          await rollbackTo({ key: key!, id: project.id, n });
        } catch (e) {
          throw new Error(errorText(e));
        }
      } : undefined}
    />
  );
}

export default function HistoryPage() {
  const { state, mode } = useProject();
  return (
    <div className="mx-auto max-w-3xl px-4 py-6 md:px-6">
      <div className="mb-4 border-b border-line pb-4">
        <h2 className="flex items-center gap-1.5 text-lg font-semibold tracking-tight">
          <History size={18} strokeWidth={1.7} className="text-faint" />
          History
        </h2>
        <p className="text-sm text-muted">
          A checkpoint is saved every time a build or a change finishes. Rolling back adds one commit with that
          checkpoint&apos;s files; nothing is deleted.
        </p>
      </div>
      {mode === "live" ? <LiveHistory /> : <CheckpointList history={state.history} />}
      {(state.retros ?? []).length > 0 && (
        <section aria-labelledby="retro-title" className="mt-6 flex flex-col gap-2">
          <div>
            <h3 id="retro-title" className="text-sm font-medium">Retro notes</h3>
            <p className="text-xs text-muted">
              After each run the PM writes down what failed and why (docs/retro.md in the repo). The planner reads them
              before the next one.
            </p>
          </div>
          <ol className="flex flex-col gap-2">
            {[...(state.retros ?? [])].reverse().map((r) => (
              <li key={`${r.t}-${r.summary}`} className="flex gap-3 rounded-2xl border border-line bg-surface p-3">
                <Avatar who="PM" size={24} />
                <p className="min-w-0 flex-1 text-sm leading-relaxed text-ink/85">{r.summary}</p>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
