"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import demo from "@/demo/garden.json";
import { initialState, reduce } from "./reduce";
import { useMutation, useQuery } from "convex/react";
import { api, liveEnabled, useOwner } from "./convex";
import { OwnerGate } from "@/components/OwnerGate";
import type { EngineEvent, Project, ProjectState } from "./types";
import type { Wizard } from "../../convex/wizard";

type Store = {
  project: Project;
  state: ProjectState;
  mode: "demo" | "live";
  approve: () => Promise<void>;
  sendBack: (note: string) => Promise<void>;
  // demo controls
  speed: number;
  setSpeed: (s: number) => void;
  restart: () => void;
  clock: number;
  duration: number;
  liveStatus?: string;          // the project row's status (live mode): queued, starting, planning...
  liveError?: string | null;    // e.g. the worker couldn't be started
  wizard?: Wizard | null;       // setup wizard state (live mode)
  canRetry?: boolean;           // a stopped build that can retry only what failed
  previewUrl?: string | null;   // live preview of the finished app (Vercel), once deployed
};

const Ctx = createContext<Store | null>(null);

export function useProject(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("useProject outside ProjectProvider");
  return s;
}

const DEMO_EVENTS = (demo.events as EngineEvent[]).slice().sort((a, b) => a.t - b.t);
const PLAN_READY_T = DEMO_EVENTS.find((e) => e.kind === "plan_ready")!.t;
const DECISION_T = DEMO_EVENTS.find((e) => e.kind === "plan_decision")!.t;
const DEMO_END = DEMO_EVENTS[DEMO_EVENTS.length - 1].t;

/** Replays a real recorded run. Pauses after the plan until the viewer approves, like the real app. */
function useDemo(): Omit<Store, "project" | "mode"> {
  const [clock, setClock] = useState(0);
  const [speed, setSpeed] = useState(4);
  const [decision, setDecision] = useState<null | { approved: boolean; note: string }>(null);
  const last = useRef<number | null>(null);

  useEffect(() => {
    let raf = 0;
    const tick = (now: number) => {
      const prev = last.current ?? now;
      last.current = now;
      setClock((c) => {
        const cap = decision?.approved ? DEMO_END : PLAN_READY_T;
        return Math.min(cap, c + ((now - prev) / 1000) * speed);
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      last.current = null;
    };
  }, [speed, decision]);

  const state = useMemo(() => {
    let s = initialState();
    for (const e of DEMO_EVENTS) {
      if (e.t > clock) break;
      if (e.kind === "plan_decision" && !decision?.approved) break;
      s = reduce(s, e);
    }
    if (decision && !decision.approved) {
      s = reduce(s, { t: clock, kind: "plan_decision", task_id: null, data: { approved: false, note: decision.note } });
    }
    return s;
  }, [clock, decision]);

  const approve = useCallback(async () => {
    setDecision({ approved: true, note: "" });
    setClock(DECISION_T);
  }, []);
  const sendBack = useCallback(async (note: string) => setDecision({ approved: false, note }), []);
  const restart = useCallback(() => {
    setDecision(null);
    setClock(0);
  }, []);
  return { state, approve, sendBack, speed, setSpeed, restart, clock, duration: DEMO_END };
}

type LiveData = {
  project: Project & { status: string; error: string | null; wizard: Wizard | null; canRetry?: boolean; previewUrl?: string | null };
  events: { kind: EngineEvent["kind"]; task_id: string | null; data: Record<string, unknown>; ts: number }[];
} | null;

/** Live: the project's events from Convex, which pushes new ones as the engine writes them. */
function LiveProvider({ id, children }: { id: string; children: React.ReactNode }) {
  const { key } = useOwner();
  const data = useQuery(api.projects.get, key ? { key, id } : "skip") as LiveData | undefined;
  const decide = useMutation(api.projects.decide);
  const state = useMemo(() => {
    if (!data) return initialState();
    const t0 = data.events[0]?.ts ?? 0;
    return data.events.reduce(
      (s, e) => reduce(s, { t: e.ts - t0, kind: e.kind, task_id: e.task_id, data: e.data }),
      initialState(),
    );
  }, [data]);
  const project: Project = data?.project ?? { id, name: data === null ? "Project not found" : "Loading…",
                                               description: "", model: "haiku", created_at: "" };
  const value: Store = {
    project, state, mode: "live",
    approve: async () => { await decide({ key: key!, id, approved: true }); },
    sendBack: async (note: string) => { await decide({ key: key!, id, approved: false, note }); },
    speed: 1, setSpeed: () => {}, restart: () => {}, clock: state.now, duration: state.now,
    liveStatus: data?.project.status, liveError: data?.project.error ?? null, wizard: data?.project.wizard ?? null, canRetry: Boolean(data?.project.canRetry),
    previewUrl: data?.project.previewUrl ?? state.preview_url,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function DemoProvider({ children }: { children: React.ReactNode }) {
  const demoStore = useDemo();
  return <Ctx.Provider value={{ ...demoStore, mode: "demo", project: demo.project as Project }}>{children}</Ctx.Provider>;
}

export function ProjectProvider({ id, children }: { id: string; children: React.ReactNode }) {
  if (id === "demo" || !liveEnabled) return <DemoProvider>{children}</DemoProvider>;
  return (
    <OwnerGate>
      <LiveProvider id={id}>{children}</LiveProvider>
    </OwnerGate>
  );
}

export const DEMO_SOURCE = demo.source;
