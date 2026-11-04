import type { Attempt, EngineEvent, FeedItem, Plan, ProjectState, Role, TaskState } from "./types";

export const initialState = (): ProjectState => ({
  status: "queued",
  plan: null,
  tasks: {},
  feed: [],
  cost_usd: 0,
  now: 0,
  preview_url: null,
});

export const money = (c: number) => (c > 0 && c < 0.01 ? `$${c.toFixed(4)}` : `$${c.toFixed(2)}`);

/** The engine's last task: an integrator wires every merged feature into pages (web apps). */
export const INTEGRATION = "INT";

/** Plan task id behind a QA task id ("T3-qa" -> "T3"). */
export const featureId = (taskId: string) => taskId.replace(/-qa$/, "");

const round = (x: number) => Math.round(x * 10000) / 10000;

function channelFor(role: Role): FeedItem["channel"] {
  return role === "planner" ? "planning" : role === "qa" ? "tests" : "build";
}

/** Apply one engine event. Pure: the same events always give the same screen. */
export function reduce(s: ProjectState, e: EngineEvent): ProjectState {
  const tasks = { ...s.tasks };
  const feed = [...s.feed];
  let { status, plan, cost_usd, preview_url } = s;
  const task = e.task_id ? tasks[e.task_id] : undefined;
  const say = (item: Omit<FeedItem, "t">) => feed.push({ t: e.t, ...item });
  const lookup = (t: TaskState) => plan?.tasks.find((p) => p.id === featureId(t.id));
  const name = (t: TaskState) => lookup(t)?.title ?? t.title.replace(/^Acceptance tests for /, "");
  const mod = (t: TaskState) => (t.id === INTEGRATION ? "the pages, sign-in and server actions" : lookup(t)?.module ?? "its module");

  switch (e.kind) {
    case "task_queued": {
      const d = e.data as { title: string; role: Role; depends_on: string[] };
      tasks[e.task_id!] = {
        id: e.task_id!, title: d.title, role: d.role, depends_on: d.depends_on,
        status: "queued", attempt: 0, attempts: [], cost_usd: 0, since: e.t,
      };
      if (d.role === "planner") {
        status = "planning";
        say({ who: "planner", channel: "planning", text: "Reading your description and drafting a plan." });
      }
      break;
    }
    case "task_status": {
      if (!task) break;
      const d = e.data as { status: string; attempt?: number; error?: string };
      const next: TaskState = { ...task, status: d.status, since: e.t, attempt: d.attempt ?? task.attempt };
      if (d.error) next.error = d.error;
      tasks[task.id] = next;
      const ch = channelFor(task.role);
      if (d.status === "working" && task.role !== "planner") {
        if ((d.attempt ?? 1) > 1) {
          say({ who: task.role, channel: ch, task_id: task.id, tone: "warn", text: `${name(task)}: trying again (try ${d.attempt}).` });
        } else {
          say({ who: task.role, channel: ch, task_id: task.id,
                text: task.role === "qa" ? `${name(task)}: writing acceptance tests.` : `${name(task)}: building ${mod(task)}.` });
        }
      } else if (d.status === "disputing") {
        say({ who: "engine", channel: "tests", task_id: task.id, tone: "warn",
              text: `${name(task)} keeps failing a few hidden tests, so a referee (a different model) is checking whether the tests match the spec.` });
      } else if (d.status === "merged" && task.role === "dev") {
        say({ who: "engine", channel: "build", task_id: task.id, tone: "good", text: `Verified and merged ${mod(task)}.` });
      } else if (d.status === "passed" && task.role === "qa") {
        say({ who: "engine", channel: "tests", task_id: task.id, tone: "good",
              text: `Accepted the tests for ${name(task)}. They all fail on the empty code, as they should, and stay hidden from the dev agent.` });
      } else if (d.status === "blocked") {
        say({ who: "engine", channel: ch, task_id: task.id, tone: "bad", text: `Paused ${name(task)}: ${d.error ?? "a dependency didn't finish"}.` });
      } else if (d.status === "failed" || d.status === "error") {
        say({ who: "engine", channel: ch, task_id: task.id, tone: "bad",
              text: `${name(task)} needs you: ${d.status === "error" ? d.error ?? "infrastructure error" : "3 tries, still not passing"}.` });
      }
      break;
    }
    case "attempt_finished": {
      if (!task) break;
      const a = e.data as unknown as Attempt;
      tasks[task.id] = { ...task, attempts: [...task.attempts, a], cost_usd: round(task.cost_usd + a.cost_usd) };
      cost_usd = round(cost_usd + a.cost_usd);
      if (!a.passed) {
        const claimed = a.claim.toLowerCase().startsWith("done");
        say({ who: "engine", channel: channelFor(task.role), task_id: task.id, tone: "warn",
              text: claimed
                ? `The agent on ${name(task)} said it was done, but the checks disagree (${a.reason}). Sent it back with the details.`
                : `Try ${a.n} on ${name(task)} was rejected: ${a.reason}.` });
      }
      break;
    }
    case "dispute_resolved": {
      if (!task) break;
      const d = e.data as { test_fixed: boolean; referee_error?: boolean };
      const fixed = Boolean(d.test_fixed);
      say({ who: "engine", channel: "tests", task_id: task.id, tone: fixed ? "good" : d.referee_error ? "bad" : undefined,
            text: d.referee_error
              ? `The referee couldn't run for ${name(task)} (the agent hit an error), so nobody has checked whether its tests match the spec.`
              : fixed
              ? `The referee found tests for ${name(task)} that contradicted the spec and corrected them. The dev agent gets another try.`
              : `The referee confirmed the tests for ${name(task)} match the spec, so the code needs fixing.` });
      break;
    }
    case "plan_ready": {
      plan = (e.data as { plan: Plan }).plan;
      status = "awaiting_approval";
      say({ who: "planner", channel: "planning",
            text: `Plan ready: ${plan.tasks.length} features and a shared contract (${plan.contracts.join(", ")}). Waiting for your approval.` });
      break;
    }
    case "plan_decision": {
      const d = e.data as { approved: boolean; note?: string };
      status = d.approved ? "building" : "rejected";
      say({ who: "you", channel: "planning",
            text: d.approved ? "Approved the plan. Building started." : `Sent the plan back${d.note ? `: ${d.note}` : "."}` });
      break;
    }
    case "build_resumed": {
      const d = e.data as { merged: string[]; retrying: string[] };
      status = "building";
      const kept = d.merged.filter((id) => id !== "PLAN").length;
      say({ who: "engine", channel: "build",
            text: `Retrying ${d.retrying.length} unfinished task${d.retrying.length === 1 ? "" : "s"} in the same repo. ` +
                  `The ${kept} feature${kept === 1 ? "" : "s"} that merged stay as they are.` });
      break;
    }
    case "project_finished": {
      const d = e.data as { status: "done" | "failed" };
      status = d.status;
      const devs = Object.values(tasks).filter((t) => t.role === "dev");
      const ok = devs.filter((t) => t.status === "merged").length;
      say({ who: "engine", channel: "build", tone: d.status === "done" ? "good" : "bad",
            text: `${d.status === "done" ? "Finished" : "Stopped"}: ${ok} of ${devs.length} features verified and merged, ${money(cost_usd)} in total.` });
      break;
    }
    case "preview_ready": {
      const url = (e.data as { url?: unknown }).url;
      if (typeof url !== "string" || !url.startsWith("https://")) break;
      preview_url = url;
      say({ who: "engine", channel: "build", tone: "good",
            text: `Preview is live at ${url}. It runs without a real database, so preview data resets.` });
      break;
    }
    case "preview_failed": {
      const d = e.data as { reason?: string };
      say({ who: "engine", channel: "build", tone: "warn",
            text: `Couldn't publish a preview: ${d.reason ?? "the deploy failed"}. The code is still in the repo.` });
      break;
    }
    case "preview_skipped": {
      const d = e.data as { reason?: string };
      say({ who: "engine", channel: "build",
            text: `No preview link this time (${d.reason ?? "previews are off"}). The code is in the repo.` });
      break;
    }
  }
  return { status, plan, tasks, feed, cost_usd, now: Math.max(s.now, e.t), preview_url };
}

/* --------------------------------------------------------------- board columns */
export type Column = "queued" | "tests" | "building" | "checking" | "done" | "attention";

export const COLUMNS: { id: Column; label: string; hint: string }[] = [
  { id: "queued", label: "Up next", hint: "Waiting for its turn" },
  { id: "tests", label: "Writing tests", hint: "QA agent, before any code" },
  { id: "building", label: "Building", hint: "Dev agent at work" },
  { id: "checking", label: "Checking", hint: "Engine runs the hidden tests" },
  { id: "done", label: "Done", hint: "Verified and merged" },
  { id: "attention", label: "Needs you", hint: "Failed, blocked or errored" },
];

export type Feature = {
  id: string;
  title: string;
  module: string;
  spec: string;
  depends_on: string[];
  column: Column;
  qa?: TaskState;
  dev?: TaskState;
  cost_usd: number;
  waitingOn: string[];
  active: Role | null;
  tries: number;
};

const BAD = new Set(["failed", "blocked", "error", "merge_conflict"]);

/** One card per planned feature, combining its QA task and its dev task, plus the integration card. */
export function features(s: ProjectState): Feature[] {
  if (!s.plan) return [];
  const integ = s.tasks[INTEGRATION];
  const cards = integ
    ? [...s.plan.tasks, { id: INTEGRATION, title: "Put it together: pages, sign-in and data", module: "src/app",
                          spec: "Wires every merged feature into a working website. Checked with a production build " +
                                "and by opening every page.", depends_on: integ.depends_on }]
    : s.plan.tasks;
  return cards.map((p) => {
    const qa = s.tasks[`${p.id}-qa`];
    const dev = s.tasks[p.id];
    let column: Column = "queued";
    let active: Role | null = null;
    if ((qa && BAD.has(qa.status)) || (dev && BAD.has(dev.status))) column = "attention";
    else if (dev?.status === "merged") column = "done";
    else if (dev && ["checking", "merging", "disputing"].includes(dev.status)) { column = "checking"; active = "dev"; }
    else if (dev?.status === "working") { column = "building"; active = "dev"; }
    else if (qa && ["working", "checking"].includes(qa.status)) { column = "tests"; active = "qa"; }
    const waitingOn = p.depends_on.filter((d) => s.tasks[d]?.status !== "merged");
    return {
      id: p.id, title: p.title, module: p.module, spec: p.spec, depends_on: p.depends_on, column, qa, dev,
      cost_usd: round((qa?.cost_usd ?? 0) + (dev?.cost_usd ?? 0)), waitingOn, active,
      tries: Math.max(dev?.attempts.length ?? 0, dev?.attempt ?? 0),
    };
  });
}

/** Dependency depth of each planned feature: 0 = can start right away. Used to lay out the plan. */
export function layers(plan: Plan): string[][] {
  const depth: Record<string, number> = {};
  const byId = Object.fromEntries(plan.tasks.map((t) => [t.id, t]));
  const visit = (id: string, seen: Set<string>): number => {
    if (id in depth) return depth[id];
    if (seen.has(id) || !byId[id]) return 0;
    seen.add(id);
    const deps = byId[id].depends_on.filter((d) => byId[d]);
    depth[id] = deps.length ? 1 + Math.max(...deps.map((d) => visit(d, seen))) : 0;
    return depth[id];
  };
  plan.tasks.forEach((t) => visit(t.id, new Set()));
  const out: string[][] = [];
  plan.tasks.forEach((t) => (out[depth[t.id]] ??= []).push(t.id));
  return out;
}
