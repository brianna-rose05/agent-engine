"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAction, useQuery } from "convex/react";
import { Sparkles, UserPlus } from "lucide-react";
import { api, liveEnabled, useOwner } from "@/lib/convex";
import { errorText } from "@/components/OwnerGate";
import { PASSWORD_MIN, checkName, checkPassword } from "../../../convex/credentials";

/*
 * /join?token=... : the invite link the owner sends (docs/accounts.md). The person sets their name and a password,
 * which creates their account and signs them in. The link works once, for 7 days.
 */

export default function JoinPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col gap-4 px-6 py-20">
      <Link href="/" className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
        <span className="grid size-7 place-items-center rounded-lg bg-planner-bg text-planner">
          <Sparkles size={15} strokeWidth={1.7} />
        </span>
        Studio
      </Link>
      {liveEnabled ? (
        <Suspense fallback={null}>
          <Join />
        </Suspense>
      ) : (
        <p className="text-sm text-muted">Invites need the live app. This is the demo.</p>
      )}
    </main>
  );
}

type Info = { state: "unknown" } | { state: "open" | "used" | "expired"; email: string; role: string } | undefined;

const field = "rounded-xl border border-line bg-surface px-3 py-2.5 text-[15px] outline-none focus:ring-2 focus:ring-planner/25";

function Join() {
  const token = useSearchParams().get("token") ?? "";
  const info = useQuery(api.accounts.inviteInfo, token ? { token } : "skip") as Info;
  const accept = useAction(api.accounts.acceptInvite);
  const { setKey } = useOwner();
  const router = useRouter();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!token || info?.state === "unknown") {
    return <Notice title="This invite link doesn't work" text="Check that you copied the whole link, or ask the owner for a new one." />;
  }
  if (!info) return <p className="text-sm text-muted">Checking your invite…</p>;
  if (info.state === "used") return <Notice title="This invite was already used" text="Sign in with your email and password." signIn />;
  if (info.state === "expired") return <Notice title="This invite has expired" text="Invites work for 7 days. Ask the owner for a new one." />;

  const submit = async () => {
    const n = checkName(name);
    const p = checkPassword(password);
    if (!n.ok) return setError(n.message);
    if (!p.ok) return setError(p.message);
    if (password !== again) return setError("The two passwords don't match.");
    setBusy(true);
    setError(null);
    try {
      const r = (await accept({ token, name, password })) as { token: string };
      setKey(r.token);
      router.replace("/");
    } catch (e) {
      setError(errorText(e, "Couldn't create your account. Try again in a moment."));
      setBusy(false);
    }
  };

  return (
    <>
      <span className="grid size-10 place-items-center rounded-xl bg-you-bg text-you">
        <UserPlus size={18} strokeWidth={1.6} />
      </span>
      <h2 className="text-xl font-semibold tracking-tight">Join Studio</h2>
      <p className="text-sm text-muted">
        You&apos;re invited as {info.role === "owner" ? "an owner" : `a ${info.role}`} with <span className="text-ink">{info.email}</span>.
        Choose your name and a password.
      </p>
      <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <label className="flex flex-col gap-1 text-sm">
          Your name
          <input autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} className={field} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Password <span className="text-xs text-faint">at least {PASSWORD_MIN} characters</span>
          <input type="password" autoComplete="new-password" required minLength={PASSWORD_MIN} value={password}
                 onChange={(e) => setPassword(e.target.value)} className={field} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          The password again
          <input type="password" autoComplete="new-password" required value={again} onChange={(e) => setAgain(e.target.value)} className={field} />
        </label>
        {error && <p role="alert" className="text-sm text-bad">{error}</p>}
        <button disabled={busy} className="rounded-xl bg-ink px-4 py-2.5 text-sm font-medium text-white disabled:opacity-40">
          {busy ? "Creating your account…" : "Create account and sign in"}
        </button>
      </form>
    </>
  );
}

function Notice({ title, text, signIn = false }: { title: string; text: string; signIn?: boolean }) {
  return (
    <>
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      <p className="text-sm text-muted">{text}</p>
      {signIn && <Link href="/" className="self-start rounded-xl bg-ink px-4 py-2.5 text-sm font-medium text-white">Go to sign in</Link>}
    </>
  );
}
