"use client";

import { useState } from "react";
import { Check, Copy, KeyRound } from "lucide-react";
import { useProject } from "@/lib/project-store";
import { isSetupCode, ownerSetupUrl } from "../../convex/setup";

/**
 * How the owner becomes the admin of their app (convex/setup.ts): open the app's /owner-setup page, sign up, enter
 * the code. One row for the preview and one for production, each once that app exists. Live only: the demo is a
 * replay and has no codes, so nothing shows there.
 */
export function OwnerSetup() {
  const { mode, state, previewUrl, production, setupCodes } = useProject();
  if (mode !== "live" || !setupCodes) return null;
  const preview = previewUrl ?? state.preview_url ?? null;
  const live = state.ship?.production ?? production ?? null;
  const rows = [
    preview && isSetupCode(setupCodes.preview) ? { label: "Preview", url: preview, code: setupCodes.preview } : null,
    live && isSetupCode(setupCodes.production) ? { label: "Production", url: live.url, code: setupCodes.production } : null,
  ].filter((r): r is { label: string; url: string; code: string } => r !== null);
  if (!rows.length) return null;
  return (
    <section id="owner-setup" aria-labelledby="owner-setup-title" className="scroll-mt-24 rounded-2xl border border-you/20 bg-you-bg/40 p-4">
      <h3 id="owner-setup-title" className="flex items-center gap-1.5 text-sm font-medium">
        <KeyRound size={15} strokeWidth={1.7} className="text-you" /> Owner setup
      </h3>
      <p className="mb-3 text-xs text-muted">
        You&apos;re the owner of your app, which makes you its admin. Claim that once in each app with its code. Keep the
        codes private: the first person to enter one becomes the owner.
      </p>
      <ul className="flex flex-col gap-3">
        {rows.map((r) => <CodeRow key={r.label} {...r} />)}
      </ul>
      <p className="mt-3 text-xs text-faint">
        No owner setup page there? The app was built before it existed. Ask for a change that adds owner setup.
      </p>
    </section>
  );
}

function CodeRow({ label, url, code }: { label: string; url: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const page = ownerSetupUrl(url);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked: the code is on screen to select by hand */
    }
  };
  return (
    <li className="flex flex-col gap-2 rounded-xl bg-surface p-3 ring-1 ring-line">
      <p className="text-[11px] font-medium uppercase tracking-wider text-faint">{label}</p>
      <p className="text-sm leading-relaxed">
        Open{" "}
        <a href={page} target="_blank" rel="noopener noreferrer" className="break-all underline underline-offset-2 hover:text-you">
          {page}
        </a>
        , sign up, and enter this code:
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="select-all rounded-lg bg-canvas px-3 py-1.5 font-mono text-[15px] tracking-wider ring-1 ring-line">{code}</code>
        <button onClick={copy} aria-label={`Copy the ${label.toLowerCase()} setup code`}
                className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-muted ring-1 ring-line hover:text-ink">
          {copied ? <Check size={14} className="text-dev" /> : <Copy size={14} strokeWidth={1.7} />}
          <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
    </li>
  );
}
