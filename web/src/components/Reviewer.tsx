"use client";

import type { CodeReview } from "@/lib/types";
import { Avatar, WHO } from "./ui";

const SECURITY = /^security:\s*/i;

/** What the reviewer said about one try (docs/reviewer.md), as a message in the feature's thread on the board. */
export function ReviewerMessage({ review }: { review: CodeReview }) {
  const w = WHO.reviewer;
  const headline = review.skipped
    ? "Skipped: the spending limit didn't allow a review, so this try merged on its passing tests."
    : review.error
    ? "I couldn't review this try (my run hit an error), so it merged on its passing tests."
    : review.verdict === "changes"
    ? "Changes needed before this merges:"
    : review.comments.length ? "Approved. Notes that don't block it:" : "Approved.";
  return (
    <div className="flex gap-2.5 rounded-xl border border-review/20 bg-review-bg/40 p-2.5">
      <Avatar who="reviewer" size={22} />
      <div className="min-w-0 flex-1 text-[13px] leading-relaxed">
        <p className="flex flex-wrap items-baseline gap-2 text-xs">
          <span className={`font-medium ${w.fg}`}>{w.label}</span>
          <span className="text-faint">on try {review.attempt}</span>
          {review.verdict === "changes" && (
            <span className="rounded-full bg-check-bg px-1.5 py-0.5 text-[11px] font-medium text-check">Asked for changes</span>
          )}
        </p>
        <p className="text-ink/85">{headline}</p>
        {review.comments.length > 0 && (
          <ul className="mt-1 flex flex-col gap-1">
            {review.comments.map((c, i) => {
              const security = SECURITY.test(c);
              return (
                <li key={i} className="flex gap-1.5 text-ink/85">
                  <span aria-hidden className="mt-2 size-1 shrink-0 rounded-full bg-review" />
                  <span>
                    {security && (
                      <span className="mr-1 rounded bg-bad-bg px-1 py-px text-[11px] font-medium text-bad">Security</span>
                    )}
                    {security ? c.replace(SECURITY, "") : c}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {review.note && <p className="mt-1 text-xs text-muted">{review.note}</p>}
      </div>
    </div>
  );
}

/** The reviewer at work on a try that passed its checks (task status reviewing_code). */
export function ReviewerReading({ attempt }: { attempt: number }) {
  const w = WHO.reviewer;
  return (
    <div className="flex gap-2.5 rounded-xl border border-review/20 bg-review-bg/40 p-2.5">
      <Avatar who="reviewer" size={22} active />
      <div className="min-w-0 flex-1 text-[13px] leading-relaxed">
        <p className="flex flex-wrap items-baseline gap-2 text-xs">
          <span className={`font-medium ${w.fg}`}>{w.label}</span>
          <span className="text-faint">on try {attempt}</span>
        </p>
        <p className="text-ink/85">
          Try {attempt} passed every check. Reading its changes against the spec before it merges.
        </p>
      </div>
    </div>
  );
}
