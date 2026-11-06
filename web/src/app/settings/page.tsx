"use client";

import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { Bell, KeyRound, Mail, Settings } from "lucide-react";
import { Shell } from "@/components/Shell";
import { OwnerGate } from "@/components/OwnerGate";
import { Mono } from "@/components/ui";
import { api, liveEnabled, useAccess, useOwner } from "@/lib/convex";
import { People } from "@/components/People";
import { SLACK_PREFIX, checkSlackWebhook } from "../../../convex/slack";

type SettingsData = { slack: { masked: string } | null; email: boolean; keySecretProblem: string | null } | undefined;

/** Message of a Convex error (ConvexError's data is the friendly text), or a generic one. */
function errorText(e: unknown, fallback: string): string {
  const data = (e as { data?: unknown })?.data;
  return typeof data === "string" ? data : fallback;
}

export default function SettingsPage() {
  return (
    <Shell>
      <main className="mx-auto w-full max-w-2xl px-4 py-6 md:px-6 md:py-10">
        <div className="mb-6 border-b border-line pb-4">
          <h2 className="flex items-center gap-1.5 text-lg font-semibold tracking-tight">
            <Settings size={18} strokeWidth={1.7} className="text-faint" />
            Settings
          </h2>
          <p className="text-sm text-muted">Who can use Studio, and where it tells you when a project needs you or finishes.</p>
        </div>
        {liveEnabled ? (
          <OwnerGate><LiveSettings /></OwnerGate>
        ) : (
          <p className="rounded-2xl border border-line bg-surface p-4 text-sm text-muted">
            Settings need the live app. Connect Convex to set up Slack notifications.
          </p>
        )}
      </main>
    </Shell>
  );
}

function LiveSettings() {
  const { isOwner } = useAccess();
  if (!isOwner) {
    return (
      <p className="rounded-2xl border border-line bg-surface p-4 text-sm text-muted">
        Settings and people are managed by the owner. Ask them if something here needs to change.
      </p>
    );
  }
  return <OwnerSettings />;
}

function OwnerSettings() {
  const { key } = useOwner();
  const data = useQuery(api.settings.get, key ? { key } : "skip") as SettingsData;
  if (!data) return null;
  return (
    <div className="flex flex-col gap-4">
      <People />
      <SlackCard masked={data.slack?.masked ?? null} />
      <section className="flex gap-3 rounded-2xl border border-line bg-surface p-4" aria-labelledby="email-title">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-canvas text-muted"><Mail size={15} strokeWidth={1.6} /></span>
        <div className="text-sm">
          <h3 id="email-title" className="font-medium">Email</h3>
          <p className="text-xs text-muted">
            {data.email ? "On: important notifications are emailed to the address set in Convex (NOTIFY_EMAIL)."
              : <>Off. Set <Mono>RESEND_API_KEY</Mono> and <Mono>NOTIFY_EMAIL</Mono> in Convex to turn it on.</>}
          </p>
        </div>
      </section>
      <section className="flex gap-3 rounded-2xl border border-line bg-surface p-4" aria-labelledby="keys-title">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-canvas text-muted"><KeyRound size={15} strokeWidth={1.6} /></span>
        <div className="text-sm">
          <h3 id="keys-title" className="font-medium">Your own Anthropic API keys</h3>
          <p className="text-xs text-muted">
            Each project can run on your own key: set it on the project&apos;s plan or setup page.{" "}
            {data.keySecretProblem ?? "Keys are stored encrypted."}
          </p>
        </div>
      </section>
    </div>
  );
}

function SlackCard({ masked }: { masked: string | null }) {
  const { key } = useOwner();
  const save = useMutation(api.settings.setSlackWebhook);
  const remove = useMutation(api.settings.removeSlackWebhook);
  const test = useAction(api.settings.testSlack);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const showForm = editing || !masked;

  const run = async (fn: () => Promise<{ ok: boolean; text: string } | null>) => {
    setBusy(true);
    setNote(null);
    try {
      setNote(await fn());
    } finally {
      setBusy(false);
    }
  };
  const submit = () => run(async () => {
    const checked = checkSlackWebhook(draft);
    if (!checked.ok) return { ok: false, text: checked.message };
    try {
      await save({ key: key!, url: checked.url });
      setDraft("");
      setEditing(false);
      return { ok: true, text: "Saved. Send a test message to check it." };
    } catch (e) {
      return { ok: false, text: errorText(e, "Couldn't save the webhook. Try again in a moment.") };
    }
  });
  const sendTest = () => run(async () => {
    try {
      const r = (await test({ key: key! })) as { ok: boolean; message: string };
      return { ok: r.ok, text: r.message };
    } catch (e) {
      return { ok: false, text: errorText(e, "Couldn't send the test message.") };
    }
  });
  const drop = () => run(async () => {
    try {
      await remove({ key: key! });
      return { ok: true, text: "Removed. Nothing is posted to Slack any more." };
    } catch (e) {
      return { ok: false, text: errorText(e, "Couldn't remove the webhook.") };
    }
  });

  return (
    <section className="rounded-2xl border border-line bg-surface p-4" aria-labelledby="slack-title">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="grid size-8 place-items-center rounded-lg bg-canvas text-muted"><Bell size={15} strokeWidth={1.6} /></span>
        <div className="min-w-0 flex-1 text-sm">
          <h3 id="slack-title" className="font-medium">Slack</h3>
          <p className="text-xs text-muted">
            {masked ? <>Every notification is posted to the channel of webhook <Mono>{masked}</Mono>.</>
              : "Post every notification (plans to approve, finished builds, ready to ship) to a Slack channel."}
          </p>
        </div>
        {masked && !editing && (
          <div className="flex items-center gap-2">
            <button onClick={sendTest} disabled={busy}
              className="rounded-lg bg-ink px-2.5 py-1 text-xs font-medium text-white disabled:opacity-40">
              Send a test message
            </button>
            <button onClick={() => { setEditing(true); setNote(null); }} disabled={busy}
              className="rounded-lg border border-line px-2.5 py-1 text-xs font-medium hover:bg-canvas disabled:opacity-40">
              Replace
            </button>
            <button onClick={drop} disabled={busy} className="text-xs text-muted hover:text-bad disabled:opacity-40">Remove</button>
          </div>
        )}
      </div>
      {showForm && (
        <form className="mt-3 flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <label htmlFor="slack-url" className="sr-only">Slack Incoming Webhook URL</label>
          <input id="slack-url" type="password" autoComplete="off" spellCheck={false} placeholder={`${SLACK_PREFIX}…`}
            value={draft} onChange={(e) => setDraft(e.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-line bg-canvas px-2.5 py-1.5 font-mono text-[13px] outline-none focus:ring-2 focus:ring-planner/30" />
          <button type="submit" disabled={busy || !draft.trim()}
            className="rounded-lg bg-ink px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40">
            Save
          </button>
          {masked && (
            <button type="button" onClick={() => { setEditing(false); setDraft(""); setNote(null); }} className="text-xs text-muted hover:text-ink">
              Cancel
            </button>
          )}
          <p className="basis-full text-xs text-faint">
            In Slack: create an app, turn on Incoming Webhooks, add one to a channel and copy its URL (docs/settings.md).
            Studio never shows it again after you save it.
          </p>
        </form>
      )}
      {note && <p className={`mt-2 text-xs ${note.ok ? "text-dev" : "text-bad"}`} role={note.ok ? "status" : "alert"}>{note.text}</p>}
    </section>
  );
}
