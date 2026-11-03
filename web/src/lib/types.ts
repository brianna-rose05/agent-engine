export type Role = "planner" | "qa" | "dev";

export type EngineEvent = {
  t: number; // seconds since the project started
  kind:
    | "task_queued"
    | "task_status"
    | "attempt_finished"
    | "plan_ready"
    | "plan_decision"
    | "project_finished";
  task_id: string | null;
  data: Record<string, unknown>;
};

export type PlanTask = { id: string; title: string; module: string; spec: string; depends_on: string[] };
export type Plan = { project: string; contracts: string[]; tasks: PlanTask[] };

export type Attempt = {
  n: number;
  passed: boolean;
  claim: string;
  reason: string;
  cost_usd: number;
  seconds: number;
  turns: number;
  files_changed: string[];
  output?: string; // the failure (test diff, type error) for rejected tries
};

export type TaskState = {
  id: string;
  title: string;
  role: Role;
  depends_on: string[];
  status: string; // queued | working | checking | merging | merged | passed | failed | blocked | error
  attempt: number;
  attempts: Attempt[];
  cost_usd: number;
  error?: string;
  since: number; // when the current status began
};

export type ProjectStatus =
  | "queued"
  | "planning"
  | "awaiting_approval"
  | "rejected"
  | "building"
  | "done"
  | "failed";

export type FeedItem = {
  t: number;
  who: Role | "engine" | "you";
  channel: "planning" | "tests" | "build";
  text: string;
  tone?: "good" | "warn" | "bad";
  task_id?: string | null;
};

export type ProjectState = {
  status: ProjectStatus;
  plan: Plan | null;
  tasks: Record<string, TaskState>;
  feed: FeedItem[];
  cost_usd: number;
  now: number;
};

export type Project = {
  id: string;
  name: string;
  description: string;
  model: "haiku" | "sonnet";
  created_at: string;
};
