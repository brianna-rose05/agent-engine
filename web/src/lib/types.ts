export type Role = "planner" | "qa" | "dev";

export type EngineEvent = {
  t: number; // seconds since the project started
  kind:
    | "task_queued"
    | "task_status"
    | "attempt_finished"
    | "plan_ready"
    | "plan_decision"
    | "dispute_resolved"
    | "build_resumed"
    | "project_finished"
    | "preview_ready"
    | "preview_failed"
    | "preview_skipped"
    | "agent_activity"
    | "change_started"
    | "change_plan_ready"
    | "checkpoint_created" | "rollback_started" | "rollback_done" | "rollback_failed"; // docs/checkpoints.md
  task_id: string | null;
  data: Record<string, unknown>;
};

export type PlanTask = { id: string; title: string; module: string; spec: string; depends_on: string[] };
export type Plan = { project: string; contracts: string[]; tasks: PlanTask[] };

/** A task in a planned change (changes/{n}.json): "change" rewrites an existing module's spec, "new" adds one. */
export type ChangeTask = PlanTask & { kind: "change" | "new" };

/** One change request as the app sees it: what was asked, then the planner's change plan and your decision. */
export type ChangeState = {
  n: number;
  text: string;            // the request, in the owner's words
  summary: string;         // empty until change_plan_ready
  contracts: string[];
  tasks: ChangeTask[];
  pages: string[];
  decision: "planning" | "pending" | "approved" | "rejected";
  before: ProjectStatus;   // status before the change started, restored if it is sent back
  rolled_back?: boolean;   // its work was rolled away by a rollback to an earlier checkpoint (off the board)
};

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
  started?: number; // when it first started working (the planner's elapsed timer)
  notes?: string[]; // what its agent did last ("Wrote src/x.ts"), newest last, current try only
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
  preview_url: string | null; // live preview of the finished app, once deployed
  changes: ChangeState[];      // change requests, oldest first
  change: ChangeState | null;  // the latest one (the same object as changes.at(-1))
  history?: HistoryState;      // checkpoints and rollbacks (lib/history.ts); absent until the first one
};

/** A save point (checkpoint_created): a `checkpoint-<n>` tag on main in the project's repo. */
export type CheckpointState = { n: number; tag: string; sha: string; label: string; t: number; merged: string[] | null };

export type HistoryState = {
  checkpoints: CheckpointState[];                         // oldest first
  current: number | null;                                 // the checkpoint main is at now, if any
  rolling: { n: number; before: ProjectStatus } | null;   // a rollback in progress
  repo: string | null;                                    // the project's GitHub repo (from project_finished)
};

export type Project = {
  id: string;
  name: string;
  description: string;
  model: "haiku" | "sonnet";
  created_at: string;
};
