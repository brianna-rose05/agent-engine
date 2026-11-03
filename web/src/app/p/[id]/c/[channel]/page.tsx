"use client";

import { use } from "react";
import { Hash } from "lucide-react";
import { useProject } from "@/lib/project-store";
import { Feed } from "@/components/Feed";

const ABOUT: Record<string, string> = {
  all: "Everything the team says and does, in order.",
  planning: "The planner, and your decisions on its plan.",
  tests: "QA agents writing hidden tests, and what the engine accepted.",
  build: "Dev agents building, retries, and every verified merge.",
};

export default function ChannelPage({ params }: { params: Promise<{ channel: string }> }) {
  const { channel } = use(params);
  const { state } = useProject();
  const items = channel === "all" ? state.feed : state.feed.filter((f) => f.channel === channel);
  return (
    <div className="mx-auto max-w-3xl px-4 py-6 md:px-6">
      <div className="mb-4 border-b border-line pb-4">
        <h2 className="flex items-center gap-1.5 text-lg font-semibold tracking-tight">
          <Hash size={18} strokeWidth={1.7} className="text-faint" />
          {channel}
        </h2>
        <p className="text-sm text-muted">{ABOUT[channel] ?? ""}</p>
      </div>
      <Feed items={items} empty="Quiet so far." />
    </div>
  );
}
