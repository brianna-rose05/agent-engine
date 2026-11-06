"use client";

import { EditGate, ViewOnlyNote } from "./Access";
import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { KeyRound } from "lucide-react";
import { useProject } from "@/lib/project-store";
import { api, useOwner } from "@/lib/convex";
import { checkAnthropicKey, keyLabel } from "../../convex/apiKey";

type KeyStatus = { own: boolean; last4: string | null; problem: string | null } | null | undefined;

/** Message of a Convex error (ConvexError's data is the friendly text), or a generic one. */
function errorText(e: unknown, fallback: string): string {
  const data = (e as { data?: unknown })?.data;
  return typeof data === "string" ? data : fallback;
}

/**
 * The project's own Anthropic API key (docs/settings.md, convex/projectKeys.ts): which key it runs on, paste one,
 * remove it. Live projects only (the replay has no row). The key is never shown again after saving: the screen only
 * ever gets its last 4 characters.
 */
export function ApiKeyCard() {
  const { mode } = useProject();
  if (mode !== "live") return null;
  // which key runs is for everyone to see; setting or removing it is the owner's (docs/accounts.md)
  return (
    <EditGate owner>
      <LiveApiKey />
      <ViewOnlyNote owner className="mt-1.5" />
    </EditGate>
  );
}

function LiveApiKey() {
  const { project } = useProject();
  const { key } = useOwner();
  const status = useQuery(api.projectKeys.status, key ? { key, id: project.id } : "skip") as KeyStatus;
  const save = useAction(api.projectKeys.set);
  const remove = useMutation(api.projectKeys.remove);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!status) return null;

  const submit = async () => {
    const checked = checkAnthropicKey(draft);
    if (!checked.ok) return setError(checked.message);
    setBusy(true);
    setError(null);
    try {
      await save({ key: key!, id: project.id, apiKey: checked.key });
      setDraft("");
      setOpen(false);
    } catch (e) {
      setError(errorText(e, "Couldn't save the key. Try again in a moment."));
    } finally {
      setBusy(false);
    }
  };
  const drop = async () => {
    setBusy(true);
    setError(null);
    try {
      await remove({ key: key!, id: project.id });
    } catch (e) {
      setError(errorText(e, "Couldn't remove the key. Try again in a moment."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="api-key-title" className="rounded-2xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="grid size-8 place-items-center rounded-lg bg-canvas text-muted">
          <KeyRound size={15} strokeWidth={1.6} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 id="api-key-title" className="text-sm font-medium">Anthropic API key</h3>
          <p className="text-xs text-muted">
            Runs on <span className="font-medium text-ink" data-testid="key-source">{keyLabel(status)}</span>.
            {status.own ? " Every agent of this project's next runs uses it." : " Paste your own to pay for this project's agents yourself."}
          </p>
        </div>
        {!open && (
          <div className="flex items-center gap-2">
            <button onClick={() => { setOpen(true); setError(null); }} disabled={busy}
              className="rounded-lg border border-line px-2.5 py-1 text-xs font-medium hover:bg-canvas disabled:opacity-40">
              {status.own ? "Replace" : "Use my own key"}
            </button>
            {status.own && (
              <button onClick={drop} disabled={busy} className="text-xs text-muted hover:text-bad disabled:opacity-40">
                Remove
              </button>
            )}
          </div>
        )}
      </div>
      {open && (
        <form className="mt-3 flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <label htmlFor="api-key-input" className="sr-only">Anthropic API key</label>
          <input id="api-key-input" type="password" autoComplete="off" spellCheck={false} placeholder="sk-ant-…" value={draft}
            onChange={(e) => setDraft(e.target.value)} autoFocus
            className="min-w-0 flex-1 rounded-lg border border-line bg-canvas px-2.5 py-1.5 font-mono text-[13px] outline-none focus:ring-2 focus:ring-planner/30" />
          <button type="submit" disabled={busy || !draft.trim()}
            className="rounded-lg bg-ink px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40">
            Save key
          </button>
          <button type="button" onClick={() => { setOpen(false); setDraft(""); setError(null); }} className="text-xs text-muted hover:text-ink">
            Cancel
          </button>
          <p className="basis-full text-xs text-faint">
            Stored encrypted. Studio never shows it again, only its last 4 characters. It applies from the next run.
          </p>
        </form>
      )}
      {status.problem && open && <p className="mt-2 text-xs text-you" role="status">{status.problem}</p>}
      {error && <p className="mt-2 text-xs text-bad" role="alert">{error}</p>}
    </section>
  );
}
