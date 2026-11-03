"use client";

import { useState } from "react";
import { KeyRound } from "lucide-react";
import { liveEnabled, useOwner, useOwnerCheck } from "@/lib/convex";

/** Until real sign-in exists, live features need the owner passphrase (set in Convex). Demo mode doesn't. */
export function OwnerGate({ children }: { children: React.ReactNode }) {
  if (!liveEnabled) return <>{children}</>;
  return <Gate>{children}</Gate>;
}

function Gate({ children }: { children: React.ReactNode }) {
  const { setKey } = useOwner();
  const state = useOwnerCheck();
  const [draft, setDraft] = useState("");
  if (state === "ok") return <>{children}</>;
  return (
    <div className="mx-auto flex max-w-sm flex-col gap-4 px-6 py-24">
      <span className="grid size-10 place-items-center rounded-xl bg-you-bg text-you">
        <KeyRound size={18} strokeWidth={1.6} />
      </span>
      <h2 className="text-xl font-semibold tracking-tight">Enter your passphrase</h2>
      <p className="text-sm text-muted">
        Starting a project runs paid agents, so this is locked to you until sign-in is added. This browser remembers it.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim()) setKey(draft.trim());
        }}
        className="flex flex-col gap-3"
      >
        <input
          type="password"
          autoComplete="current-password"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="rounded-xl border border-line bg-surface px-3 py-2.5 text-[15px] outline-none focus:ring-2 focus:ring-planner/25"
        />
        {state === "wrong" && <p className="text-sm text-bad">That passphrase didn&apos;t work.</p>}
        <button className="rounded-xl bg-ink px-4 py-2.5 text-sm font-medium text-white disabled:opacity-40" disabled={state === "checking"}>
          {state === "checking" ? "Checking…" : "Unlock"}
        </button>
      </form>
    </div>
  );
}
