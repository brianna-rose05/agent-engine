"use client";

import { TriangleAlert } from "lucide-react";
import { architectVerdict, architectWarnings, isSecurity, withoutSecurityTag } from "@/lib/architect";
import type { ArchitectReview } from "@/lib/types";
import { Avatar, WHO } from "./ui";

/** What the architect decided about the plan you're about to approve (docs/architect.md), as one line. */
export function ArchitectVerdict({ review }: { review: ArchitectReview | null | undefined }) {
  const v = architectVerdict(review);
  if (!v || !review) return null;
  const w = WHO.architect;
  return (
    <p className="flex items-center gap-2 text-sm">
      <Avatar who="architect" size={22} />
      <span className={`font-medium ${w.fg}`}>{w.label}</span>
      <span className={v.tone === "warn" ? "text-check" : "text-muted"}>{v.text}</span>
    </p>
  );
}

/** The architect's comments that are still open after the planner's second try: shown above the Approve button,
 *  so you approve knowing them. Nothing when there are none. */
export function ArchitectWarnings({ review }: { review: ArchitectReview | null | undefined }) {
  const comments = architectWarnings(review);
  if (!comments) return null;
  return (
    <section role="alert" aria-labelledby="architect-warnings-title"
             className="rounded-xl border border-check/40 bg-check-bg/60 p-3">
      <h3 id="architect-warnings-title" className="flex items-center gap-2 text-sm font-medium text-ink">
        <TriangleAlert size={16} strokeWidth={1.8} className="shrink-0 text-check" />
        The architect still has {comments.length === 1 ? "a concern" : `${comments.length} concerns`} about this plan
      </h3>
      <p className="mt-0.5 text-xs text-muted">
        It asked the planner to fix {comments.length === 1 ? "this" : "these"} once, and the second plan still has
        {comments.length === 1 ? " it" : " them"}. You decide: approve anyway, or send the plan back with what to change.
      </p>
      <ul className="mt-2 flex flex-col gap-1">
        {comments.map((c, i) => (
          <li key={i} className="flex gap-1.5 text-[13px] leading-relaxed text-ink/85">
            <span aria-hidden className="mt-2 size-1 shrink-0 rounded-full bg-check" />
            <span>
              {isSecurity(c) && (
                <span className="mr-1 rounded bg-bad-bg px-1 py-px text-[11px] font-medium text-bad">Security</span>
              )}
              {isSecurity(c) ? withoutSecurityTag(c) : c}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The architect at work on a plan that passed its checks (planner status architect_reviewing). */
export function ArchitectReading() {
  const w = WHO.architect;
  return (
    <p className="flex items-center gap-2 text-sm">
      <Avatar who="architect" size={22} active />
      <span className={`font-medium ${w.fg}`}>{w.label}</span>
      <span className="text-muted">Reviewing the plan&apos;s contracts, migrations and security before it comes to you.</span>
    </p>
  );
}
