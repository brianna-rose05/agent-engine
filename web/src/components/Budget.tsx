"use client";

import { useState } from "react";
import { Wallet } from "lucide-react";
import { useProject } from "@/lib/project-store";
import { budgetFit, rangeText, type Estimate } from "@/lib/estimate";
import { money } from "@/lib/reduce";
import { BUDGET_MAX, BUDGET_MIN, checkBudget } from "../../convex/budget";

/**
 * The cost estimate next to the project's spending limit, with the limit editable in place (plan page: before
 * approving a plan or a change, and after a build stopped at the limit). The engine enforces the limit.
 */
export function BudgetLine({ estimate, what = "this build" }: { estimate?: Estimate; what?: string }) {
  const { budgetUsd, spentUsd, setBudget, state } = useProject();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const spent = spentUsd ?? state.cost_usd;
  const fit = estimate && budgetUsd !== undefined ? budgetFit(estimate, spent, budgetUsd) : "ok";

  const save = async () => {
    const checked = checkBudget(Number(value));
    if (!checked.ok) return setError(checked.message);
    setBusy(true);
    setError(null);
    try {
      await setBudget?.(checked.usd);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the limit.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted">
      <Wallet size={14} strokeWidth={1.6} className="shrink-0" />
      {estimate && (
        <span title={estimate.lines.map((l) => `${l.label}: ${rangeText(l)}`).join("\n")}>
          Estimated <span className="font-medium text-ink tabular-nums">{rangeText(estimate)}</span> for {what}
          {spent > 0 && <> ({money(spent)} spent so far)</>}
        </span>
      )}
      {budgetUsd !== undefined && !editing && (
        <>
          <span aria-hidden>·</span>
          <span>
            your limit <span className="font-medium text-ink tabular-nums">{money(budgetUsd)}</span>
          </span>
          {setBudget && (
            <button onClick={() => { setValue(String(budgetUsd)); setEditing(true); setError(null); }}
              className="text-planner hover:underline">
              Change
            </button>
          )}
        </>
      )}
      {editing && (
        <span className="flex items-center gap-1.5">
          <label htmlFor="budget-input" className="sr-only">Spending limit in dollars</label>
          <span aria-hidden>$</span>
          <input id="budget-input" type="number" min={BUDGET_MIN} max={BUDGET_MAX} step={1} value={value} autoFocus
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void save(); if (e.key === "Escape") setEditing(false); }}
            className="w-20 rounded-lg border border-line bg-canvas px-2 py-0.5 text-ink tabular-nums outline-none focus:ring-2 focus:ring-planner/30" />
          <button disabled={busy} onClick={save} className="rounded-lg bg-ink px-2.5 py-0.5 text-xs font-medium text-white disabled:opacity-40">
            Save
          </button>
          <button onClick={() => setEditing(false)} className="text-xs hover:text-ink">Cancel</button>
        </span>
      )}
      {fit !== "ok" && !editing && (
        <span className="basis-full text-xs text-you" role="status">
          {fit === "over"
            ? "Even the low estimate is over what's left of your limit: the team will stop before finishing unless you raise it."
            : "The high estimate is over what's left of your limit. If it runs long, the team stops at the limit and you can raise it then."}
        </span>
      )}
      {error && <span className="basis-full text-xs text-bad" role="alert">{error}</span>}
    </div>
  );
}
