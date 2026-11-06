"use client";

import { use } from "react";
import { MotionConfig } from "motion/react";
import { ProjectProvider, useProject } from "@/lib/project-store";
import { Shell } from "@/components/Shell";
import { TopBar } from "@/components/TopBar";
import { ViewOnlyBanner } from "@/components/Access";

function Frame({ children }: { children: React.ReactNode }) {
  const { project, state, mode } = useProject();
  const counts = {
    all: state.feed.length,
    planning: state.feed.filter((f) => f.channel === "planning").length,
    tests: state.feed.filter((f) => f.channel === "tests").length,
    build: state.feed.filter((f) => f.channel === "build").length,
  };
  return (
    <Shell projectNav={{ id: project.id, counts }} projectName={project.name}>
      <TopBar />
      {mode === "live" && <ViewOnlyBanner />}
      <main className="flex-1">{children}</main>
    </Shell>
  );
}

export default function ProjectLayout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <MotionConfig reducedMotion="user" transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}>
      <ProjectProvider id={id}>
        <Frame>{children}</Frame>
      </ProjectProvider>
    </MotionConfig>
  );
}
