"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import demo from "@/demo/garden.json";
import { initialState, reduce } from "./reduce";
import { supabaseBrowser, liveEnabled } from "./supabase";
import type { EngineEvent, Project, ProjectState } from "./types";

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

/** Live: read the project's events from Supabase and follow new ones as the engine writes them. */
function useLive(projectId: string): Omit<Store, "project" | "mode"> & { project: Project | null } {
  const [events, setEvents] = useState<EngineEvent[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const start = useRef<number | null>(null);

  useEffect(() => {
    if (!liveEnabled) return;
    const sb = supabaseBrowser();
    type Row = { id: number; kind: EngineEvent["kind"]; task_id: string | null; data: Record<string, unknown>; ts: string };
    const toEvent = (r: Row): EngineEvent => {
      const ms = Date.parse(r.ts);
      start.current ??= ms;
      return { t: (ms - start.current) / 1000, kind: r.kind, task_id: r.task_id, data: r.data };
    };
    let cancelled = false;
    sb.from("projects").select("id,name,description,model,created_at").eq("id", projectId).single()
      .then(({ data }) => !cancelled && data && setProject(data as Project));
    sb.from("events").select("*").eq("project_id", projectId).order("id")
      .then(({ data }) => !cancelled && data && setEvents((data as Row[]).map(toEvent)));
    const channel = sb.channel(`events-${projectId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "events", filter: `project_id=eq.${projectId}` },
          (payload) => setEvents((ev) => [...ev, toEvent(payload.new as Row)]))
      .subscribe();
    return () => {
      cancelled = true;
      sb.removeChannel(channel);
    };
  }, [projectId]);

  const state = useMemo(() => events.reduce(reduce, initialState()), [events]);
  const decide = (approved: boolean, note: string | null) => async () => {
    const { error } = await supabaseBrowser().rpc("decide_plan", { project: projectId, approved, note });
    if (error) throw error;
  };
  return {
    project, state,
    approve: decide(true, null),
    sendBack: (note: string) => decide(false, note)(),
    speed: 1, setSpeed: () => {}, restart: () => {}, clock: state.now, duration: state.now,
  };
}

export function ProjectProvider({ id, children }: { id: string; children: React.ReactNode }) {
  const isDemo = id === "demo" || !liveEnabled;
  const demoStore = useDemo();
  const liveStore = useLive(isDemo ? "" : id);
  const value: Store = isDemo
    ? { ...demoStore, mode: "demo", project: demo.project as Project }
    : { ...liveStore, mode: "live",
        project: liveStore.project ?? { id, name: "Loading…", description: "", model: "haiku", created_at: "" } };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const DEMO_SOURCE = demo.source;
