"use client";

import { useState } from "react";
import { Hammer, Loader2 } from "lucide-react";
import { useProject } from "@/lib/project-store";
import { listText, type PmSuggestion } from "@/lib/pm";
import { money } from "@/lib/reduce";
import { Avatar, WHO } from "./ui";

/**
 * The PM's budget guard on the plan page: when the estimate is over the limit, which Should and Could features it
 * suggests saving for the next version (lib/pm.ts pmSuggestion), or that even that wouldn't fit. The choices
 * themselves ("Save these for later" / "Build everything") are the approval bar's buttons.
 */
export function PmCard({ suggestion, budget }: { suggestion: Exclude<PmSuggestion, { kind: "fits" }>; budget: number }) {
  const w = WHO.PM;
  return (
    <div className="flex gap-3 rounded-xl border border-pm/20 bg-pm-bg/60 p-3" role="status">
      <Avatar who="PM" size={26} />
      <div className="min-w-0 flex-1 text-sm">
        <p className={`text-xs font-medium ${w.fg}`}>{w.label}</p>
        {suggestion.kind === "defer" ? (
          <p className="leading-relaxed">
            The PM suggests saving {suggestion.titles.length === 1 ? "this" : "these"} for the next version to fit your{" "}
            {money(budget)} limit: <span className="font-medium">{listText(suggestion.titles)}</span>{" "}
            <span className="text-muted">(saves about {money(suggestion.saves)})</span>. Every Must feature is still built.
          </p>
        ) : (
          <p className="leading-relaxed">
            {suggestion.deferrable
              ? `Even saving every Should and Could feature for later wouldn't fit your ${money(budget)} limit.`
              : `Every feature that could be saved for later is a Must, so the PM won't cut any to fit your ${money(budget)} limit.`}{" "}
            <span className="text-muted">
              Raise the limit, or build everything: the team stops at the limit and you can raise it then.
            </span>
          </p>
        )}
      </div>
    </div>
  );
}

/** Build the features the PM saved for later (live only): a resume in the same repo, merged work stays. */
export function BuildSavedButton() {
  const { mode, canBuildSaved, buildSaved } = useProject();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (mode !== "live" || !buildSaved) return null;
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await buildSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't start building the saved features.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="flex flex-wrap items-center gap-2">
      <button onClick={go} disabled={busy || !canBuildSaved}
        title={canBuildSaved ? "Keeps every merged feature and builds the saved ones" : "You can build them once the team has finished"}
        className="flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40">
        {busy ? <Loader2 size={12} className="animate-spin" /> : <Hammer size={12} />}
        {busy ? "Starting…" : "Build saved features"}
      </button>
      {error && <span role="alert" className="text-xs text-bad">{error}</span>}
    </span>
  );
}
