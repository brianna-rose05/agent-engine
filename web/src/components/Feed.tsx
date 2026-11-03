"use client";

import { AnimatePresence, motion } from "motion/react";
import type { FeedItem } from "@/lib/types";
import { Avatar, WHO } from "./ui";

const TONE: Record<string, string> = {
  good: "border-l-dev",
  warn: "border-l-check",
  bad: "border-l-bad",
};

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function Feed({ items, newestFirst = false, empty }: { items: FeedItem[]; newestFirst?: boolean; empty: string }) {
  const list = newestFirst ? [...items].reverse() : items;
  if (!list.length) return <p className="px-1 py-6 text-sm text-faint">{empty}</p>;
  return (
    <ol className="flex flex-col gap-1">
      <AnimatePresence initial={false}>
        {list.map((f, i) => (
          <motion.li
            key={`${f.t}-${f.who}-${f.text}`}
            layout
            initial={{ opacity: 0, y: newestFirst ? -6 : 6 }}
            animate={{ opacity: 1, y: 0 }}
            className={`flex gap-3 rounded-xl border-l-2 px-2 py-2 ${f.tone ? TONE[f.tone] : "border-l-transparent"} ${
              i % 2 ? "" : ""
            }`}
          >
            <Avatar who={f.who} size={26} />
            <div className="min-w-0 flex-1">
              <p className="flex items-baseline gap-2 text-xs">
                <span className={`font-medium ${WHO[f.who].fg}`}>{WHO[f.who].label}</span>
                <span className="tabular-nums text-faint">{clock(f.t)}</span>
              </p>
              <p className="text-[13.5px] leading-relaxed text-ink/85">{f.text}</p>
            </div>
          </motion.li>
        ))}
      </AnimatePresence>
    </ol>
  );
}
