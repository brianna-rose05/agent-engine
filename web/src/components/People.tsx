"use client";

import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { Check, Copy, Users } from "lucide-react";
import { api, useOwner, type Role } from "@/lib/convex";
import { errorText } from "./OwnerGate";

/*
 * People on /settings (owner only, docs/accounts.md): who has an account and with which role, open invites, and a
 * form to invite someone. The invite link is shown once, to copy; Studio also emails it when Resend is set up.
 */

type Person = { id: string; email: string; name: string; role: Role; createdAt: number };
type Invite = { id: string; email: string; role: Role; expiresAt: number; createdBy: string | null; state: "open" | "used" | "expired" };
type PeopleData = { me: string | null; users: Person[]; invites: Invite[] } | undefined;

const ROLES: { id: Role; label: string; about: string }[] = [
  { id: "viewer", label: "Viewer", about: "sees projects, changes nothing" },
  { id: "editor", label: "Editor", about: "starts projects, approves plans, asks for changes, ships" },
  { id: "owner", label: "Owner", about: "everything, including people, settings, keys and spending limits" },
];

const day = (t: number) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const select = "rounded-lg border border-line bg-canvas px-2 py-1 text-xs outline-none focus:ring-2 focus:ring-planner/30";

export function People() {
  const { key } = useOwner();
  const data = useQuery(api.accounts.people, key ? { key } : "skip") as PeopleData;
  const setRole = useMutation(api.accounts.setRole);
  const removePerson = useMutation(api.accounts.removePerson);
  const revokeInvite = useMutation(api.accounts.revokeInvite);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);

  const run = async (f: () => Promise<unknown>, fallback: string) => {
    setError(null);
    try {
      await f();
    } catch (e) {
      setError(errorText(e, fallback));
    }
  };

  return (
    <section className="rounded-2xl border border-line bg-surface p-4" aria-labelledby="people-title">
      <div className="flex gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-canvas text-muted"><Users size={15} strokeWidth={1.6} /></span>
        <div className="min-w-0 text-sm">
          <h3 id="people-title" className="font-medium">People</h3>
          <p className="text-xs text-muted">
            Invite people by email. Viewers can look, editors can run projects, owners can also manage people and
            settings. The owner passphrase always works too.
          </p>
        </div>
      </div>

      {data && (data.users.length > 0 || data.invites.length > 0) && (
        <ul className="mt-3 flex flex-col divide-y divide-line border-t border-line" aria-label="People and invites">
          {data.users.map((u) => {
            const me = u.id === data.me;
            return (
              <li key={u.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{u.name}{me && <span className="font-normal text-faint"> (you)</span>}</span>
                  <span className="block truncate text-xs text-muted">{u.email}</span>
                </span>
                <label className="sr-only" htmlFor={`role-${u.id}`}>Role for {u.name}</label>
                <select id={`role-${u.id}`} value={u.role} disabled={me} className={select}
                  onChange={(e) => run(() => setRole({ key: key!, userId: u.id, role: e.target.value }), "Couldn't change the role.")}>
                  {ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                </select>
                {!me && (confirm === u.id ? (
                  <span className="flex items-center gap-2 text-xs">
                    <button className="font-medium text-bad"
                      onClick={() => { setConfirm(null); void run(() => removePerson({ key: key!, userId: u.id }), "Couldn't remove them."); }}>
                      Remove {u.name.split(" ")[0]}
                    </button>
                    <button className="text-muted hover:text-ink" onClick={() => setConfirm(null)}>Keep</button>
                  </span>
                ) : (
                  <button className="text-xs text-muted hover:text-bad" onClick={() => setConfirm(u.id)}>Remove</button>
                ))}
              </li>
            );
          })}
          {data.invites.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
              <span className="min-w-0 flex-1">
                <span className="block truncate">{i.email}</span>
                <span className="block truncate text-xs text-muted">
                  {i.state === "expired" ? "Invite expired" : `Invited, link works until ${day(i.expiresAt)}`}
                  {i.createdBy && ` · by ${i.createdBy}`}
                </span>
              </span>
              <span className="text-xs capitalize text-muted">{i.role}</span>
              <button className="text-xs text-muted hover:text-bad"
                onClick={() => run(() => revokeInvite({ key: key!, inviteId: i.id }), "Couldn't revoke the invite.")}>
                {i.state === "expired" ? "Clear" : "Revoke"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-bad">{error}</p>}
      <InviteForm />
    </section>
  );
}

function InviteForm() {
  const { key } = useOwner();
  const invite = useAction(api.accounts.createInvite);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("editor");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ email: string; link: string; emailed: boolean } | null>(null);
  const [copied, setCopied] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    setMade(null);
    setCopied(false);
    try {
      const r = (await invite({ key: key!, email, role })) as { path: string; emailed: boolean };
      setMade({ email: email.trim(), link: `${window.location.origin}${r.path}`, emailed: r.emailed });
      setEmail("");
    } catch (e) {
      setError(errorText(e, "Couldn't create the invite. Try again in a moment."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 border-t border-line pt-3">
      <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <label htmlFor="invite-email" className="sr-only">Email to invite</label>
        <input id="invite-email" type="email" autoComplete="off" placeholder="name@example.com" value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-line bg-canvas px-2.5 py-1.5 text-[13px] outline-none focus:ring-2 focus:ring-planner/30" />
        <label htmlFor="invite-role" className="sr-only">Role</label>
        <select id="invite-role" value={role} onChange={(e) => setRole(e.target.value as Role)} className={`${select} py-1.5`}>
          {ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
        <button type="submit" disabled={busy || !email.trim()}
          className="rounded-lg bg-ink px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40">
          {busy ? "Inviting…" : "Invite"}
        </button>
        <p className="basis-full text-xs text-faint">{ROLES.find((r) => r.id === role)?.label}: {ROLES.find((r) => r.id === role)?.about}.</p>
      </form>
      {error && <p role="alert" className="mt-2 text-xs text-bad">{error}</p>}
      {made && (
        <div className="mt-2 flex flex-col gap-1.5 rounded-xl bg-canvas p-3 text-xs" role="status">
          <p className="text-ink">
            {made.emailed ? `Emailed to ${made.email}. You can also send them this link:` : `Send ${made.email} this link:`}{" "}
            <span className="text-muted">it works once, for 7 days, and isn&apos;t shown again.</span>
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md bg-surface px-2 py-1 font-mono text-[12px] ring-1 ring-line">{made.link}</code>
            <button type="button" aria-label="Copy the invite link"
              onClick={async () => { try { await navigator.clipboard.writeText(made.link); setCopied(true); } catch { /* select it by hand */ } }}
              className="flex items-center gap-1 rounded-lg px-2 py-1 font-medium ring-1 ring-line hover:bg-surface">
              {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
