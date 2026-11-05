"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import demo from "@/demo/garden.json";
import { initialState, reduce } from "./reduce";
import { useMutation, useQuery } from "convex/react";
import { api, liveEnabled, useOwner } from "./convex";
import { OwnerGate } from "@/components/OwnerGate";
import type { EngineEvent, Project, ProjectState } from "./types";
import type { Wizard } from "../../convex/wizard";
import { canRequestChange, checkChangeText, nextChangeNumber, type ChangeRequest } from "../../convex/changes";
import { checkAnswerText } from "../../convex/answers";
import { isSetupCode, type SetupCodes } from "../../convex/setup";

type Store = {
  project: Project;
  state: ProjectState;
  mode: "demo" | "live";
  approve: (deferred?: string[]) => Promise<void>; // deferred: plan task ids the PM saves for the next version
  sendBack: (note: string) => Promise<void>;
  // demo controls
  speed: number;
  setSpeed: (s: number) => void;
  restart: () => void;
  clock: number;
  duration: number;
  t0?: number;                  // live: wall-clock seconds of the first event (event times count from it)
  liveStatus?: string;          // the project row's status (live mode): queued, starting, planning...
  liveError?: string | null;    // e.g. the worker couldn't be started
  wizard?: Wizard | null;       // setup wizard state (live mode)
  canRetry?: boolean;           // a stopped build that can retry only what failed
  previewUrl?: string | null;   // live preview of the finished app (Vercel), once deployed
  durableDb?: boolean;          // the preview has its own database, so its data is kept (docs/databases.md)
  canShip?: boolean;            // live: the project row allows shipping to production now (convex/ship.ts)
  shipQueued?: boolean;         // live: a ship or production rollback was asked for and its run hasn't ended
  production?: { url: string; version: number; at: number } | null; // live: what production runs now (project row)
  canChange: boolean;           // the owner can ask for a change now (docs/change-requests.md)
  changeHistory: ChangeRequest[]; // the change requests asked so far, oldest first
  requestChange: (text: string) => Promise<void>; // throws with a message to show when it can't be sent
  budgetUsd?: number;           // live: the project's spending limit (convex/budget.ts); the demo has none
  spentUsd?: number;            // live: what the project row says was spent so far, every run included
  setBudget?: (usd: number) => Promise<void>; // throws with a message to show when it can't be set
  answers: Record<string, string>; // your answers to the tech lead so far, {taskId: text} (convex/answers.ts)
  // answer the tech lead's question on a failed feature, then retry what failed; throws with a message to show
  answerAndRetry: (taskId: string, text: string) => Promise<void>;
  canBuildSaved?: boolean;      // live: features were saved for later and the team can build them now (convex/pm.ts)
  buildSaved?: () => Promise<void>; // live: build the saved features; throws with a message to show when it can't
  setupCodes?: SetupCodes;      // live, owner only: codes for the app's /owner-setup page (convex/setup.ts); the demo has none
};

/** A task agent is busy right now (the demo has no project row to ask). */
const RUNNING = new Set(["working", "checking", "merging", "disputing", "reviewing", "reviewing_code"]);
export const anyRunning = (s: ProjectState) => Object.values(s.tasks).some((t) => RUNNING.has(t.status));

/** Message of a Convex error (ConvexError's data is the friendly text), or a generic one. */
function errorText(e: unknown, fallback = "Couldn't send the change. Try again in a moment."): string {
  const data = (e as { data?: unknown })?.data;
  return typeof data === "string" ? data : fallback;
}

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
    setHistory([]);
  }, []);
  // The demo is a recording: a change request is kept on this page only, no team picks it up.
  const [history, setHistory] = useState<ChangeRequest[]>([]);
  const requestChange = useCallback(async (text: string) => {
    const checked = checkChangeText(text);
    if (!checked.ok) throw new Error(checked.message);
    setHistory((h) => [...h, { n: nextChangeNumber(h), text: checked.text, at: Date.now() }]);
  }, []);
  const canChange = canRequestChange(state.status, Boolean(state.plan), anyRunning(state));
  const answerAndRetry = useCallback(async (_taskId: string, text: string) => {
    const checked = checkAnswerText(text);
    if (!checked.ok) throw new Error(checked.message);
    throw new Error("This is a replay of a recorded run, so nobody picks up answers here.");
  }, []);
  return { state, approve, sendBack, speed, setSpeed, restart, clock, duration: DEMO_END,
           canChange, changeHistory: history, requestChange, answers: {}, answerAndRetry };
}

type LiveData = {
  project: Project & { status: string; error: string | null; wizard: Wizard | null; canRetry?: boolean; previewUrl?: string | null; durableDb?: boolean;
                      canShip?: boolean; shipping?: boolean; production?: { url: string; version: number; at: number } | null;
                      canChange?: boolean; changes?: ChangeRequest[]; budgetUsd?: number; costUsd?: number;
                      answers?: Record<string, string>; canBuildSaved?: boolean; setupCodes?: SetupCodes };
  events: { kind: EngineEvent["kind"]; task_id: string | null; data: Record<string, unknown>; ts: number }[];
} | null;

/** Live: the project's events from Convex, which pushes new ones as the engine writes them. */
function LiveProvider({ id, children }: { id: string; children: React.ReactNode }) {
  const { key } = useOwner();
  const data = useQuery(api.projects.get, key ? { key, id } : "skip") as LiveData | undefined;
  const decide = useMutation(api.projects.decide);
  const askChange = useMutation(api.projects.requestChange);
  const saveBudget = useMutation(api.projects.setBudget);
  const answer = useMutation(api.projects.answerAndRetry);
  const buildSavedNow = useMutation(api.projects.buildSaved);
  const ensureSetupCodes = useMutation(api.projects.ensureSetupCodes);
  // Projects made before owner setup codes existed get theirs the first time the owner opens them, so the next
  // worker run (and its deploys) already has them. Once per project per page load; existing codes never change.
  const codes = data?.project.setupCodes;
  const missingCodes = Boolean(data) && !(isSetupCode(codes?.preview) && isSetupCode(codes?.production));
  const ensured = useRef<string | null>(null);
  useEffect(() => {
    if (!missingCodes || !key || ensured.current === id) return;
    ensured.current = id;
    ensureSetupCodes({ key, id }).catch(() => { ensured.current = null; }); // try again on the next change
  }, [missingCodes, key, id, ensureSetupCodes]);
  const t0 = data?.events[0]?.ts;
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
    approve: async (deferred?: string[]) => {
      try {
        await decide({ key: key!, id, approved: true, ...(deferred?.length ? { deferred } : {}) });
      } catch (e) {
        throw new Error(errorText(e, "Couldn't approve the plan. Try again in a moment."));
      }
    },
    sendBack: async (note: string) => { await decide({ key: key!, id, approved: false, note }); },
    speed: 1, setSpeed: () => {}, restart: () => {}, clock: state.now, duration: state.now, t0,
    liveStatus: data?.project.status, liveError: data?.project.error ?? null, wizard: data?.project.wizard ?? null, canRetry: Boolean(data?.project.canRetry),
    previewUrl: data?.project.previewUrl ?? state.preview_url,
    durableDb: Boolean(data?.project.durableDb) || Boolean(state.durable_db),
    canShip: Boolean(data?.project.canShip),
    shipQueued: Boolean(data?.project.shipping),
    production: data?.project.production ?? null,
    canChange: Boolean(data?.project.canChange),
    changeHistory: data?.project.changes ?? [],
    budgetUsd: data?.project.budgetUsd,
    spentUsd: data?.project.costUsd,
    setBudget: async (usd: number) => {
      try {
        await saveBudget({ key: key!, id, budgetUsd: usd });
      } catch (e) {
        const d = (e as { data?: unknown })?.data;
        throw new Error(typeof d === "string" ? d : "Couldn't save the limit. Try again in a moment.");
      }
    },
    requestChange: async (text: string) => {
      const checked = checkChangeText(text);
      if (!checked.ok) throw new Error(checked.message);
      try {
        await askChange({ key: key!, id, text: checked.text });
      } catch (e) {
        throw new Error(errorText(e));
      }
    },
    answers: data?.project.answers ?? {},
    answerAndRetry: async (taskId: string, text: string) => {
      const checked = checkAnswerText(text);
      if (!checked.ok) throw new Error(checked.message);
      try {
        await answer({ key: key!, id, taskId, text: checked.text });
      } catch (e) {
        throw new Error(errorText(e, "Couldn't send your answer. Try again in a moment."));
      }
    },
    canBuildSaved: Boolean(data?.project.canBuildSaved),
    setupCodes: codes ?? {},
    buildSaved: async () => {
      try {
        await buildSavedNow({ key: key!, id });
      } catch (e) {
        throw new Error(errorText(e, "Couldn't start building the saved features. Try again in a moment."));
      }
    },
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
