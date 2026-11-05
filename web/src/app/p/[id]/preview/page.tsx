"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  Check, ExternalLink, Eye, Loader2, Monitor, MousePointerClick, Pencil, Plus, RefreshCw, RotateCcw, Smartphone, Trash2, X,
} from "lucide-react";
import { api, useOwner } from "@/lib/convex";
import { useProject } from "@/lib/project-store";
import {
  PHONE_HEIGHT, PHONE_WIDTH, bridgePath, pageUrl, pathOf, pinFromClick, pinStatus, pinStyle, pinsOnScreen, popoverPlacement,
  previewOrigin, samePath,
} from "@/lib/pins";
import {
  COMMENT_TEXT_MAX, COMMENT_TEXT_MIN, requestText, suggestSendAs, type Comment, type SendAs, type Viewport,
} from "../../../../../convex/comments";

/** Message of a Convex error (ConvexError's data is the friendly text), or a generic one. */
function errorText(e: unknown, fallback: string): string {
  const data = (e as { data?: unknown })?.data;
  return typeof data === "string" ? data : fallback;
}

/**
 * The project's preview inside Studio, with comment pins: "+ Comment" drops a numbered pin anywhere on the page and
 * takes a note; selected pins go to the team as one quick change or one change request (convex/comments.ts). Pins
 * need Convex, so the replay shows only a note.
 */
export default function PreviewPage() {
  const { mode } = useProject();
  return mode === "live" ? <LivePreview /> : <DemoPreview />;
}

function DemoPreview() {
  const { state } = useProject();
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-6 md:px-6">
      <h2 className="text-lg font-semibold tracking-tight">Preview</h2>
      <p className="text-sm text-muted">
        Comment pins on the preview need the live app. This project is a replay.
      </p>
      {state.preview_url && (
        <a href={state.preview_url} target="_blank" rel="noopener noreferrer"
           className="flex w-fit items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-muted ring-1 ring-line hover:text-ink">
          <ExternalLink size={13} /> Open in tab
        </a>
      )}
    </div>
  );
}

type Data = { comments: Comment[]; next: number; canQuick: boolean; canChange: boolean } | null | undefined;

function LivePreview() {
  const { project, previewUrl } = useProject();
  const { key } = useOwner();
  const data = useQuery(api.comments.forProject, key ? { key, id: project.id } : "skip") as Data;
  if (!previewUrl || !previewOrigin(previewUrl)) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-2 px-4 py-6 md:px-6">
        <h2 className="text-lg font-semibold tracking-tight">Preview</h2>
        <p className="rounded-2xl border border-dashed border-line px-4 py-8 text-center text-sm text-muted">
          No preview yet. It appears here once the team has built the app.
        </p>
      </div>
    );
  }
  return <PreviewScreen preview={previewUrl} data={data} />;
}

type Draft = { x: number; y: number; width: number; text: string; busy: boolean; error: string | null }; // width: the frame's, in px

function PreviewScreen({ preview, data }: { preview: string; data: Data }) {
  const { project } = useProject();
  const { key } = useOwner();
  const add = useMutation(api.comments.add);
  const origin = previewOrigin(preview);

  const [viewport, setViewport] = useState<Viewport>("desktop");
  const [commenting, setCommenting] = useState(false);
  const [opened, setOpened] = useState(() => pathOf(preview)); // the page the frame was told to open
  const [frameKey, setFrameKey] = useState(0);                  // bump to reload the frame
  const [reported, setReported] = useState<string | null>(null); // the page the app says is open (StudioBridge)
  const [hasBridge, setHasBridge] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);

  const path = reported ?? opened;
  const comments = useMemo(() => data?.comments ?? [], [data]);
  const shown = pinsOnScreen(comments.filter((c) => c.status !== "resolved"), path, viewport);

  // The template's StudioBridge reports the open page; accept it only from the preview's own frame and origin.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (frame.current && e.source !== frame.current.contentWindow) return;
      const p = bridgePath(e, origin);
      if (!p) return;
      setReported(p);
      setHasBridge(true);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [origin]);

  const go = useCallback((to: string, vp?: Viewport) => {
    if (vp) setViewport(vp);
    setDraft(null);
    if (!samePath(to, reported ?? opened)) {
      setOpened(to);
      setReported(null);
      setFrameKey((k) => k + 1);
    }
  }, [opened, reported]);

  useEffect(() => {
    if (!draft && !commenting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (draft) setDraft(null);
      else setCommenting(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [draft, commenting]);

  const drop = (e: React.MouseEvent) => {
    if (!overlay.current) return;
    const at = pinFromClick(e.clientX, e.clientY, overlay.current.getBoundingClientRect());
    const width = overlay.current.getBoundingClientRect().width;
    // a second click moves the unsaved pin and keeps what was typed
    if (at) setDraft((d) => ({ ...at, width, text: d?.text ?? "", busy: false, error: null }));
  };

  const save = async () => {
    if (!draft) return;
    setDraft({ ...draft, busy: true, error: null });
    try {
      const n = await add({ key: key!, id: project.id, path, pathKnown: hasBridge && reported !== null, x: draft.x, y: draft.y,
                            viewport, text: draft.text });
      setDraft(null);
      setActive(n as number);
    } catch (e) {
      setDraft({ ...draft, busy: false, error: errorText(e, "Couldn't save the pin. Try again in a moment.") });
    }
  };

  const phone = viewport === "phone";
  const src = pageUrl(preview, opened);

  return (
    <div className="flex flex-col gap-4 px-4 py-4 md:px-6 lg:flex-row lg:items-start">
      <section className="flex min-w-0 flex-1 flex-col gap-3" aria-label="Preview">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg bg-surface p-0.5 ring-1 ring-line" role="group" aria-label="Width">
            {(["desktop", "phone"] as const).map((vp) => (
              <button key={vp} onClick={() => { setViewport(vp); setDraft(null); }} aria-pressed={viewport === vp}
                className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors duration-150 ${
                  viewport === vp ? "bg-ink text-white" : "text-muted hover:text-ink"}`}>
                {vp === "desktop" ? <Monitor size={13} /> : <Smartphone size={13} />}
                {vp === "desktop" ? "Desktop" : "Phone"}
              </button>
            ))}
          </div>
          <button onClick={() => { setCommenting((c) => !c); setDraft(null); }} aria-pressed={commenting}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium ${
              commenting ? "bg-you text-white" : "text-ink ring-1 ring-line hover:bg-surface"}`}>
            {commenting ? <X size={13} /> : <Plus size={13} />} {commenting ? "Done commenting" : "Comment"}
          </button>
          <span className="min-w-0 truncate rounded-md bg-surface px-2 py-1 font-mono text-[12px] text-muted ring-1 ring-line"
                title={hasBridge ? "The page the app says is open" : "The page the preview was opened at"}>
            {path}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={() => setFrameKey((k) => k + 1)} title="Reload the preview"
              className="rounded-lg p-1.5 text-muted ring-1 ring-line hover:text-ink">
              <RefreshCw size={13} />
              <span className="sr-only">Reload</span>
            </button>
            <a href={pageUrl(preview, path)} target="_blank" rel="noopener noreferrer"
               title="Your app's private preview address, on this page"
               className="flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 text-xs font-medium text-white hover:opacity-90">
              <ExternalLink size={12} /> Open in tab
            </a>
          </div>
        </div>

        {commenting && (
          <p className="flex items-center gap-1.5 text-xs text-muted" role="status">
            <MousePointerClick size={13} className="text-you" />
            Click anywhere on the page to drop a pin. Turn commenting off to click around the app. Esc stops.
          </p>
        )}

        <div className={`flex justify-center rounded-2xl border border-line ${phone ? "bg-canvas p-3" : "bg-surface"}`}>
          <div className={`relative overflow-hidden bg-white ${phone ? "rounded-[28px] ring-8 ring-ink/90" : "w-full rounded-2xl"}`}
               style={phone ? { width: PHONE_WIDTH, maxWidth: "100%", height: `min(${PHONE_HEIGHT}px, 78dvh)` } : { height: "min(860px, 78dvh)" }}>
            <iframe key={frameKey} ref={frame} src={src} title={`${project.name} preview`}
                    className="absolute inset-0 size-full border-0"
                    sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox" />
            {commenting && (
              <div ref={overlay} onClick={drop} aria-label="Click to drop a pin"
                   className="absolute inset-0 cursor-crosshair bg-you/[0.03] ring-2 ring-inset ring-you/40" />
            )}
            <div className="pointer-events-none absolute inset-0">
              {shown.map((c) => (
                <PinDot key={c.n} c={c} active={active === c.n} onClick={() => setActive(active === c.n ? null : c.n)} />
              ))}
              {draft && (
                <DraftPopover draft={draft} path={path} pathKnown={hasBridge && reported !== null}
                  onText={(text) => setDraft({ ...draft, text })} onCancel={() => setDraft(null)} onSave={save}
                  next={data?.next ?? comments.reduce((m, c) => Math.max(m, c.n), 0) + 1} />
              )}
            </div>
          </div>
        </div>
        <p className="text-xs text-faint">
          {hasBridge
            ? "The app tells Studio which page is open, so pins land on the right page."
            : `This app doesn't report its page to Studio yet (it gets that on its next change), so pins are saved on the page the preview was opened at: ${opened}.`}{" "}
          If the preview stays blank, its host doesn&apos;t allow showing it inside Studio: use Open in tab.
        </p>
      </section>

      <PinList comments={comments} data={data} path={path} viewport={viewport} active={active} setActive={setActive} go={go} />
    </div>
  );
}

const DOT: Record<Comment["status"], string> = { open: "bg-you", sent: "bg-dev", resolved: "bg-faint" };

function PinDot({ c, active, onClick }: { c: Comment; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} style={pinStyle(c)} title={c.text} aria-label={`Pin ${c.n}: ${c.text}`}
      className={`pointer-events-auto absolute grid size-7 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full rounded-bl-none text-[12px] font-semibold text-white shadow-md ring-2 ring-white transition-transform duration-150 ${DOT[c.status]} ${active ? "scale-125" : "hover:scale-110"}`}>
      {c.n}
    </button>
  );
}

function DraftPopover({ draft, path, pathKnown, next, onText, onCancel, onSave }: {
  draft: Draft; path: string; pathKnown: boolean; next: number;
  onText: (t: string) => void; onCancel: () => void; onSave: () => void;
}) {
  const place = popoverPlacement(draft, draft.width, 256);
  const length = draft.text.trim().length;
  return (
    <>
      <span style={pinStyle(draft)}
            className="absolute grid size-7 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full rounded-bl-none bg-you text-[12px] font-semibold text-white shadow-md ring-2 ring-white">
        {next}
      </span>
      <div role="dialog" aria-label={`Note for pin ${next}`}
           style={{ left: place.left, width: place.width, top: pinStyle(draft).top,
                    transform: place.vertical === "above" ? "translateY(calc(-100% - 20px))" : "translateY(20px)" }}
           className="pointer-events-auto absolute rounded-xl border border-line bg-surface p-3 shadow-lg">
        <label htmlFor="pin-note" className="text-xs text-muted">
          Pin {next} on <span className="font-mono">{path}</span>
        </label>
        <textarea id="pin-note" autoFocus value={draft.text} maxLength={COMMENT_TEXT_MAX}
          onChange={(e) => onText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && length >= COMMENT_TEXT_MIN) onSave(); }}
          placeholder="What should change here?"
          className="mt-1.5 min-h-20 w-full resize-y rounded-lg border border-line bg-canvas p-2 text-sm outline-none focus:ring-2 focus:ring-you/30" />
        {!pathKnown && (
          <p className="mt-1 text-[11px] leading-snug text-faint">Saved on the page the preview was opened at.</p>
        )}
        {draft.error && <p role="alert" className="mt-1 text-xs text-bad">{draft.error}</p>}
        <div className="mt-2 flex items-center justify-end gap-2">
          <button onClick={onCancel} className="rounded-lg px-2.5 py-1 text-xs text-muted hover:text-ink">Cancel</button>
          <button onClick={onSave} disabled={draft.busy || length < COMMENT_TEXT_MIN}
            className="flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1 text-xs font-medium text-white disabled:opacity-40">
            {draft.busy && <Loader2 size={12} className="animate-spin motion-reduce:animate-none" />} Save pin
          </button>
        </div>
      </div>
    </>
  );
}

function PinList({ comments, data, path, viewport, active, setActive, go }: {
  comments: Comment[]; data: Data; path: string; viewport: Viewport; active: number | null;
  setActive: (n: number | null) => void; go: (path: string, vp?: Viewport) => void;
}) {
  const { project } = useProject();
  const { key } = useOwner();
  const send = useMutation(api.comments.sendComments);
  const [selected, setSelected] = useState<number[]>([]);
  const [busy, setBusy] = useState<SendAs | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const open = comments.filter((c) => c.status === "open");
  const picked = open.filter((c) => selected.includes(c.n));
  const suggested = suggestSendAs(picked);
  // The suggestion is the highlighted button; the owner can always press the other one.
  const toggle = (n: number) => {
    setResult(null);
    setSelected((s) => (s.includes(n) ? s.filter((x) => x !== n) : [...s, n]));
  };

  const go2 = async (as: SendAs) => {
    setBusy(as);
    setResult(null);
    try {
      const r = (await send({ key: key!, id: project.id, commentIds: picked.map((c) => c.n), as })) as { kind: SendAs; n: number };
      setSelected([]);
      setResult({ ok: true, text: r.kind === "quick" ? `Sent as quick change ${r.n}.` : `Sent as change request ${r.n}.` });
    } catch (e) {
      setResult({ ok: false, text: errorText(e, "Couldn't send the pins. Try again in a moment.") });
    } finally {
      setBusy(null);
    }
  };

  const can = { quick: Boolean(data?.canQuick), change: Boolean(data?.canChange) };
  const label = { quick: "Send as quick change", change: "Send as change request" };

  return (
    <aside className="flex w-full shrink-0 flex-col gap-3 lg:sticky lg:top-20 lg:w-80" aria-labelledby="pins-title">
      <div>
        <h2 id="pins-title" className="text-sm font-medium">Pins</h2>
        <p className="text-xs text-muted">
          Pick pins and send them to the team together. Pins on other pages or widths are listed here and drawn when the
          preview shows them.
        </p>
      </div>

      {data === undefined ? (
        <p className="flex items-center gap-2 text-sm text-muted"><Loader2 size={14} className="animate-spin" /> Loading pins…</p>
      ) : comments.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted">
          No pins yet. Press Comment, then click the part of the page you want changed.
        </p>
      ) : (
        <ol className="flex flex-col gap-2">
          {[...comments].reverse().map((c) => (
            <PinRow key={c.n} c={c} here={samePath(c.path, path) && c.viewport === viewport} active={active === c.n}
              selected={selected.includes(c.n)} onToggle={() => toggle(c.n)}
              onShow={() => { setActive(c.n); go(c.path, c.viewport); }} />
          ))}
        </ol>
      )}

      {picked.length > 0 && (
        <div className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-3">
          <p className="text-xs text-muted">
            {picked.length} {picked.length === 1 ? "pin" : "pins"} selected. The PM suggests a{" "}
            <span className="font-medium text-ink">{suggested === "quick" ? "quick change" : "change request"}</span>
            {suggested === "quick" ? ": short wording and style notes." : ": these need more than wording or style."}
          </p>
          <details className="text-xs">
            <summary className="cursor-pointer text-muted hover:text-ink">What the team gets</summary>
            <pre className="mt-1.5 whitespace-pre-wrap break-words rounded-lg bg-canvas p-2 font-mono text-[11px] text-muted">{requestText(picked)}</pre>
          </details>
          {(["quick", "change"] as const).map((as) => (
            <button key={as} disabled={Boolean(busy) || !can[as]} onClick={() => go2(as)}
              title={can[as] ? undefined : as === "quick" ? "Quick changes need a finished app with nothing running." : "Change requests need a finished app with nothing running."}
              className={`flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-40 ${
                suggested === as ? "bg-ink text-white" : "text-ink ring-1 ring-line hover:bg-canvas"}`}>
              {busy === as && <Loader2 size={14} className="animate-spin motion-reduce:animate-none" />} {label[as]}
            </button>
          ))}
          {!can.quick && !can.change && <p className="text-xs text-faint">The team is busy. Send these once it has finished.</p>}
        </div>
      )}
      {result && (
        <p role={result.ok ? "status" : "alert"} className={`text-xs ${result.ok ? "text-dev" : "text-bad"}`}>
          {result.text}{" "}
          {result.ok && <Link href={`/p/${project.id}/board`} className="underline underline-offset-2">Follow it on the board</Link>}
        </p>
      )}
    </aside>
  );
}

function PinRow({ c, here, active, selected, onToggle, onShow }: {
  c: Comment; here: boolean; active: boolean; selected: boolean; onToggle: () => void; onShow: () => void;
}) {
  const { project } = useProject();
  const { key } = useOwner();
  const update = useMutation(api.comments.update);
  const resolve = useMutation(api.comments.resolve);
  const remove = useMutation(api.comments.remove);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (f: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    setError(null);
    try {
      await f();
      return true;
    } catch (e) {
      setError(errorText(e, fallback));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const args = { key: key!, id: project.id, n: c.n };

  return (
    <li className={`rounded-xl border bg-surface p-2.5 text-[13px] ${active ? "border-you/50 ring-1 ring-you/20" : "border-line"} ${
      c.status === "resolved" ? "opacity-70" : ""}`}>
      <div className="flex items-start gap-2">
        {c.status === "open" ? (
          <input type="checkbox" checked={selected} onChange={onToggle} aria-label={`Select pin ${c.n}`}
                 className="mt-1 size-3.5 shrink-0 accent-[var(--color-ink)]" />
        ) : <span className="w-3.5 shrink-0" />}
        <span className={`grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold text-white ${DOT[c.status]}`}>{c.n}</span>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-faint">
            <span className="font-mono text-muted">{c.path}</span>
            <span>· {c.viewport}</span>
            {!c.pathKnown && <span title="The app didn't report its page, so this is the page the preview was opened at">· page as opened</span>}
            <span className={`ml-auto ${c.status === "sent" ? "text-dev" : c.status === "open" ? "text-you" : ""}`}>{pinStatus(c)}</span>
          </p>
          {editing !== null ? (
            <div className="mt-1 flex flex-col gap-1.5">
              <label htmlFor={`pin-edit-${c.n}`} className="sr-only">Note for pin {c.n}</label>
              <textarea id={`pin-edit-${c.n}`} autoFocus value={editing} maxLength={COMMENT_TEXT_MAX}
                onChange={(e) => setEditing(e.target.value)}
                className="min-h-16 w-full resize-y rounded-lg border border-line bg-canvas p-2 text-sm outline-none focus:ring-2 focus:ring-you/30" />
              <div className="flex justify-end gap-2">
                <button onClick={() => setEditing(null)} className="rounded-lg px-2 py-0.5 text-xs text-muted hover:text-ink">Cancel</button>
                <button disabled={busy || editing.trim().length < COMMENT_TEXT_MIN}
                  onClick={async () => { if (await run(() => update({ ...args, text: editing }), "Couldn't save the note.")) setEditing(null); }}
                  className="rounded-lg bg-ink px-2.5 py-0.5 text-xs font-medium text-white disabled:opacity-40">Save</button>
              </div>
            </div>
          ) : (
            <p className="mt-0.5 whitespace-pre-wrap break-words text-ink/85">{c.text}</p>
          )}
          {editing === null && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {!here && c.status !== "resolved" && (
                <RowButton onClick={onShow} Icon={Eye}>Show</RowButton>
              )}
              {c.status === "open" && <RowButton onClick={() => setEditing(c.text)} Icon={Pencil} disabled={busy}>Edit</RowButton>}
              {c.status === "open" && (
                <RowButton onClick={() => run(() => resolve({ ...args, resolved: true }), "Couldn't resolve the pin.")} Icon={Check} disabled={busy}>Resolve</RowButton>
              )}
              {c.status === "resolved" && (
                <RowButton onClick={() => run(() => resolve({ ...args, resolved: false }), "Couldn't reopen the pin.")} Icon={RotateCcw} disabled={busy}>Reopen</RowButton>
              )}
              {c.status !== "sent" && (
                <RowButton onClick={() => run(() => remove(args), "Couldn't delete the pin.")} Icon={Trash2} disabled={busy}>Delete</RowButton>
              )}
            </div>
          )}
          {error && <p role="alert" className="mt-1 text-xs text-bad">{error}</p>}
        </div>
      </div>
    </li>
  );
}

function RowButton({ onClick, Icon, disabled, children }: {
  onClick: () => void; Icon: typeof Eye; disabled?: boolean; children: React.ReactNode;
}) {
  return (
    <button onClick={onClick} disabled={disabled}
      className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted ring-1 ring-line hover:text-ink disabled:opacity-40">
      <Icon size={11} /> {children}
    </button>
  );
}
