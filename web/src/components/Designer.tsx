"use client";

import { Monitor, Smartphone, TriangleAlert } from "lucide-react";
import { splitComment, widthLabel } from "@/lib/designer";
import type { DesignReview } from "@/lib/types";
import { Avatar, WHO } from "./ui";

/** One designer comment: "/book (390): ..." shows the page and a phone or desktop tag, then the problem. */
function Comment({ c, dot }: { c: string; dot: string }) {
  const { page, width, text } = splitComment(c);
  const label = widthLabel(width);
  const Icon = label === "phone" ? Smartphone : Monitor;
  return (
    <li className="flex gap-1.5 text-ink/85">
      <span aria-hidden className={`mt-2 size-1 shrink-0 rounded-full ${dot}`} />
      <span className="min-w-0">
        {page && (
          <span className="mr-1 inline-flex items-center gap-1 rounded bg-design-bg px-1 py-px align-[1px] font-mono text-[11px] text-design">
            {page}
            {label && <><Icon size={11} strokeWidth={1.8} aria-hidden /><span className="sr-only">({label})</span></>}
          </span>
        )}
        {text}
      </span>
    </li>
  );
}

/** What the designer said about one integration try (docs/designer.md), as a message in its thread on the board. */
export function DesignerMessage({ review }: { review: DesignReview }) {
  const w = WHO.designer;
  const headline = review.skipped
    ? `Skipped: ${review.reason ?? "no screenshots"}. The pages merged without a design review.`
    : review.error
    ? "I couldn't review the screenshots (my run hit an error), so the pages merged as they are."
    : review.warnings
    ? "These are still open. The pages merged anyway, and they're kept as design warnings:"
    : review.verdict === "changes"
    ? "Visual problems to fix before this merges:"
    : review.comments.length ? "Approved. Notes that don't block it:" : "Approved: every page looks right on desktop and phone.";
  return (
    <div className="flex gap-2.5 rounded-xl border border-design/20 bg-design-bg/40 p-2.5">
      <Avatar who="designer" size={22} />
      <div className="min-w-0 flex-1 text-[13px] leading-relaxed">
        <p className="flex flex-wrap items-baseline gap-2 text-xs">
          <span className={`font-medium ${w.fg}`}>{w.label}</span>
          <span className="text-faint">on try {review.attempt}</span>
          {review.verdict === "changes" && (
            <span className="rounded-full bg-check-bg px-1.5 py-0.5 text-[11px] font-medium text-check">
              {review.warnings ? "Design warnings" : "Asked for changes"}
            </span>
          )}
        </p>
        <p className="text-ink/85">{headline}</p>
        {review.comments.length > 0 && (
          <ul className="mt-1 flex flex-col gap-1">
            {review.comments.map((c, i) => <Comment key={i} c={c} dot="bg-design" />)}
          </ul>
        )}
        {review.reason && !review.skipped && <p className="mt-1 text-xs text-muted">{review.reason}</p>}
      </div>
    </div>
  );
}

/** The designer at work on an integration try that passed its whole-app check (task status design_review). */
export function DesignerLooking({ attempt }: { attempt: number }) {
  const w = WHO.designer;
  return (
    <div className="flex gap-2.5 rounded-xl border border-design/20 bg-design-bg/40 p-2.5">
      <Avatar who="designer" size={22} active />
      <div className="min-w-0 flex-1 text-[13px] leading-relaxed">
        <p className="flex flex-wrap items-baseline gap-2 text-xs">
          <span className={`font-medium ${w.fg}`}>{w.label}</span>
          <span className="text-faint">on try {attempt}</span>
        </p>
        <p className="text-ink/85">
          Try {attempt} passed the whole-app check. Looking at screenshots of every page, on desktop and phone, before it merges.
        </p>
      </div>
    </div>
  );
}

/** The last build's design warnings, read-only (Ship screen): what the designer still saw when the pages merged. They
 *  never block shipping; a change request or quick change fixes them. Nothing when there are none. */
export function DesignWarnings({ warnings }: { warnings: { comments: string[]; attempt: number } | null }) {
  if (!warnings) return null;
  const n = warnings.comments.length;
  return (
    <div role="note" aria-labelledby="design-warnings-title" className="mt-4 rounded-xl border border-check/40 bg-check-bg/50 p-3">
      <p id="design-warnings-title" className="flex items-center gap-2 text-sm font-medium text-ink">
        <TriangleAlert size={15} strokeWidth={1.8} className="shrink-0 text-check" />
        {n === 1 ? "A design warning" : `${n} design warnings`} from the last build
      </p>
      <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
        <Avatar who="designer" size={16} />
        The designer still saw {n === 1 ? "this" : "these"} after the integrator&apos;s fix. They don&apos;t block shipping;
        send a quick change to fix {n === 1 ? "it" : "them"}.
      </p>
      <ul className="mt-2 flex flex-col gap-1 text-[13px] leading-relaxed">
        {warnings.comments.map((c, i) => <Comment key={i} c={c} dot="bg-check" />)}
      </ul>
    </div>
  );
}
