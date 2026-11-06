"use client";

import { useState } from "react";
import { useAction } from "convex/react";
import { KeyRound, LogIn } from "lucide-react";
import { api, liveEnabled, useOwner, useOwnerCheck } from "@/lib/convex";

/** Live features need a signed-in person or the owner passphrase (docs/accounts.md). Demo mode doesn't. */
export function OwnerGate({ children }: { children: React.ReactNode }) {
  if (!liveEnabled) return <>{children}</>;
  return <Gate>{children}</Gate>;
}

/** Message of a Convex error (ConvexError's data is the friendly text), or a generic one. */
export function errorText(e: unknown, fallback: string): string {
  const data = (e as { data?: unknown })?.data;
  return typeof data === "string" ? data : fallback;
}

const field = "rounded-xl border border-line bg-surface px-3 py-2.5 text-[15px] outline-none focus:ring-2 focus:ring-planner/25";
const primary = "rounded-xl bg-ink px-4 py-2.5 text-sm font-medium text-white disabled:opacity-40";

function Gate({ children }: { children: React.ReactNode }) {
  const { key, setKey } = useOwner();
  const { state, message } = useOwnerCheck();
  const [mode, setMode] = useState<"account" | "passphrase">("account");
  if (state === "ok") return <>{children}</>;
  // a stored key that stopped working: a session that ended ("Please sign in again.") or a wrong passphrase
  const session = Boolean(key?.startsWith("sst_"));
  const stale = state === "wrong" && session ? message : null;
  return (
    <div className="mx-auto flex max-w-sm flex-col gap-4 px-6 py-24">
      <span className="grid size-10 place-items-center rounded-xl bg-you-bg text-you">
        {mode === "account" ? <LogIn size={18} strokeWidth={1.6} /> : <KeyRound size={18} strokeWidth={1.6} />}
      </span>
      {mode === "account" ? (
        <SignIn stale={stale} onSignedIn={setKey} />
      ) : (
        <Passphrase wrong={state === "wrong" && !session} checking={state === "checking"} onEnter={setKey} />
      )}
      <button
        type="button"
        onClick={() => setMode(mode === "account" ? "passphrase" : "account")}
        className="self-start text-sm text-muted underline-offset-2 hover:text-ink hover:underline"
      >
        {mode === "account" ? "Use the owner passphrase instead" : "Sign in with email instead"}
      </button>
    </div>
  );
}

function SignIn({ stale, onSignedIn }: { stale: string | null; onSignedIn: (token: string) => void }) {
  const signIn = useAction(api.accounts.signIn);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <h2 className="text-xl font-semibold tracking-tight">Sign in</h2>
      <p className="text-sm text-muted">
        Studio is invite-only. Use the email your invite went to. This browser keeps you signed in for 30 days.
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const r = (await signIn({ email, password })) as { token: string };
            onSignedIn(r.token);
          } catch (err) {
            setError(errorText(err, "Couldn't sign in. Try again."));
          } finally {
            setBusy(false);
          }
        }}
        className="flex flex-col gap-3"
      >
        <label className="flex flex-col gap-1 text-sm">
          Email
          <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={field} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Password
          <input type="password" autoComplete="current-password" required value={password}
                 onChange={(e) => setPassword(e.target.value)} className={field} />
        </label>
        {(error ?? stale) && <p className="text-sm text-bad">{error ?? stale}</p>}
        <button className={primary} disabled={busy || !email.trim() || !password}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
    </>
  );
}

function Passphrase({ wrong, checking, onEnter }: { wrong: boolean; checking: boolean; onEnter: (k: string) => void }) {
  const [draft, setDraft] = useState("");
  return (
    <>
      <h2 className="text-xl font-semibold tracking-tight">Enter the owner passphrase</h2>
      <p className="text-sm text-muted">
        The passphrase set in Convex always unlocks Studio as the owner. This browser remembers it.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim()) onEnter(draft.trim());
        }}
        className="flex flex-col gap-3"
      >
        <input type="password" autoComplete="current-password" value={draft} onChange={(e) => setDraft(e.target.value)}
               aria-label="Owner passphrase" className={field} />
        {wrong && <p className="text-sm text-bad">That passphrase didn&apos;t work.</p>}
        <button className={primary} disabled={checking}>{checking ? "Checking…" : "Unlock"}</button>
      </form>
    </>
  );
}
