import { withHistory } from "./history";
import { withShip } from "./ship";
import { listText } from "./pm";
import { priorityOf, type TaskPriority } from "../../convex/pm";
import type { Attempt, ChangeState, ChangeTask, EngineEvent, FeedItem, Plan, PlanTask, ProjectState, QuickState, Role, TaskState,
              TechLeadReview } from "./types";

export const initialState = (): ProjectState => ({
  status: "queued",
  plan: null,
  tasks: {},
  feed: [],
  cost_usd: 0,
  now: 0,
  preview_url: null,
  durable_db: false,
  changes: [],
  change: null,
  budget_reached: null,
  quicks: [],
  deferred: [],
  ready_to_ship: null,
  retros: [],
});

export const money = (c: number) => (c > 0 && c < 0.01 ? `$${c.toFixed(4)}` : `$${c.toFixed(2)}`);

/** The engine's last task: an integrator wires every merged feature into pages (web apps). */
export const INTEGRATION = "INT";

/** Plan task id behind a QA task id ("T3-qa" -> "T3"). */
export const featureId = (taskId: string) => taskId.replace(/-qa$/, "");

/** Planner id of change n ("C1PLAN"), and whether a task id is a change planner. */
export const changePlannerId = (n: number) => `C${n}PLAN`;
export const isChangePlanner = (taskId: string) => /^C\d+PLAN$/.test(taskId);

/** The planner the planning screen follows: the latest change's while a change is planned, else the first plan's. */
export function currentPlanner(s: ProjectState): TaskState | undefined {
  if (s.change) {
    const t = s.tasks[changePlannerId(s.change.n)];
    if (t) return t;
  }
  return s.tasks.PLAN ?? Object.values(s.tasks).find((t) => t.role === "planner" && !isChangePlanner(t.id));
}

/** Task id of quick change n ("Q1"), and whether a task id is a quick change. */
export const quickId = (n: number) => `Q${n}`;
export const isQuick = (taskId: string) => /^Q\d+$/.test(taskId);
/** How the engine says a quick change needs a change request (engine/quick.py blocked_reason). */
const NEEDS_CHANGE = "needs a change request";

/** Change tasks that belong on the board: those of approved changes, or any the engine has queued. */
export function boardChangeTasks(s: ProjectState): ChangeTask[] {
  return s.changes.flatMap((c) =>
    c.rolled_back ? [] : c.decision === "approved" || c.tasks.some((t) => s.tasks[t.id] || s.tasks[`${t.id}-qa`]) ? c.tasks : []);
}

/** Activity notes kept per task: the planning screen shows this many, a board card the latest. */
export const NOTES_KEPT = 5;

const round = (x: number) => Math.round(x * 10000) / 10000;

/** "sonnet" -> "Sonnet": how a model is named on screen. */
export const modelName = (m: string) => (m ? m[0].toUpperCase() + m.slice(1) : m);

function channelFor(role: Role): FeedItem["channel"] {
  return role === "planner" ? "planning" : role === "qa" ? "tests" : "build";
}

/** Apply one engine event. Pure: the same events always give the same screen. */
export function reduce(s: ProjectState, e: EngineEvent): ProjectState {
  // checkpoints and rollbacks wrap the rest (lib/history.ts), then shipping to production (lib/ship.ts)
  return withHistory(s, e, (s2, e2) => withShip(s2, e2, reduceEvent));
}

function reduceEvent(s: ProjectState, e: EngineEvent): ProjectState {
  const tasks = { ...s.tasks };
  const feed = [...s.feed];
  let { status, plan, cost_usd, preview_url, budget_reached } = s;
  let durable_db = Boolean(s.durable_db);
  let changes = s.changes;
  let quicks = s.quicks;
  // the PM: features saved for the next version, the latest ship gate, retro notes
  let deferred = s.deferred ?? [];
  let ready_to_ship = s.ready_to_ship ?? null;
  let retros = s.retros ?? [];
  const setQuick = (n: number, next: Partial<QuickState>) => {
    quicks = quicks.map((q) => (q.n === n ? { ...q, ...next } : q));
  };
  const runningQuick = quicks.at(-1)?.result === "running" ? quicks.at(-1) : undefined;
  const task = e.task_id ? tasks[e.task_id] : undefined;
  const say = (item: Omit<FeedItem, "t">) => feed.push({ t: e.t, ...item });
  const setChange = (n: number, next: Partial<ChangeState>) => {
    changes = changes.map((c) => (c.n === n ? { ...c, ...next } : c));
  };
  const latest = changes.at(-1);
  const lookup = (t: TaskState): PlanTask | ChangeTask | undefined => {
    const id = featureId(t.id);
    return plan?.tasks.find((p) => p.id === id) ?? changes.flatMap((c) => c.tasks).find((p) => p.id === id);
  };
  const changeKind = (t: TaskState) => (lookup(t) as ChangeTask | undefined)?.kind;
  const name = (t: TaskState) => lookup(t)?.title ?? t.title.replace(/^Acceptance tests for /, "");
  const mod = (t: TaskState) => (t.id === INTEGRATION ? "the pages, sign-in and server actions"
    : isQuick(t.id) ? "the pages and components" : lookup(t)?.module ?? "its module");

  switch (e.kind) {
    case "task_queued": {
      const d = e.data as { title: string; role: Role; depends_on: string[] };
      tasks[e.task_id!] = {
        id: e.task_id!, title: d.title, role: d.role, depends_on: d.depends_on,
        status: "queued", attempt: 0, attempts: [], cost_usd: 0, since: e.t,
      };
      if (d.role === "planner") {
        status = "planning";
        say({ who: "planner", channel: "planning",
              text: isChangePlanner(e.task_id!)
                ? "Reading the code and your change request, and planning only what has to change."
                : "Reading your description and drafting a plan." });
      }
      break;
    }
    case "task_status": {
      if (!task) break;
      const d = e.data as { status: string; attempt?: number; error?: string; missing?: string[] };
      if (d.status === "already_done") {     // a change that already holds on main: checked, no code needed
        say({ who: "engine", channel: "build", task_id: task.id, tone: "good",
              text: `${name(task)}: the change already holds on the current code. Its hidden tests pass on main, so no new code was needed.` });
        break;
      }
      if (d.status === "without") {          // the integrator goes ahead without screens whose tests failed
        const names = (d.missing ?? []).map((id) => plan?.tasks.find((p) => p.id === id)?.title ?? id);
        say({ who: "engine", channel: "build", task_id: task.id, tone: "warn",
              text: `Putting the app together without ${names.join(", ")}: ${names.length > 1 ? "those screens" : "that screen"} ` +
                    `didn't pass ${names.length > 1 ? "their" : "its"} hidden tests, so the integrator builds a simpler version, ` +
                    `checked only by the app build and page checks.` });
        break;
      }
      const next: TaskState = { ...task, status: d.status, since: e.t, attempt: d.attempt ?? task.attempt };
      if (d.error) next.error = d.error;
      if (d.status === "working") {
        next.started ??= e.t;
        next.notes = []; // a new try starts with a clean slate
      }
      if (d.status === "working" || d.status === "reviewing") delete next.question; // a question is only open once it failed
      if (d.status === "working" && deferred.includes(featureId(task.id))) {
        deferred = deferred.filter((id) => id !== featureId(task.id)); // a saved feature is being built now
      }
      tasks[task.id] = next;
      const ch = channelFor(task.role);
      if (d.status === "working" && task.role !== "planner") {
        if (task.review?.decision === "retry" && !task.review.error) {
          // the extra tries the tech lead asked for (4, 5), with its guidance and maybe a stronger model
          say({ who: task.role, channel: ch, task_id: task.id, tone: "warn",
                text: `${name(task)}: trying again with the tech lead's guidance (try ${d.attempt ?? next.attempt}` +
                      `${task.retry_model ? `, on ${modelName(task.retry_model)}` : ""}).` });
        } else if ((d.attempt ?? 1) > 1) {
          say({ who: task.role, channel: ch, task_id: task.id, tone: "warn", text: `${name(task)}: trying again (try ${d.attempt}).` });
        } else {
          say({ who: task.role, channel: ch, task_id: task.id,
                text: task.role === "qa" ? `${name(task)}: writing acceptance tests.` : `${name(task)}: building ${mod(task)}.` });
        }
      } else if (d.status === "disputing") {
        say({ who: "engine", channel: "tests", task_id: task.id, tone: "warn",
              text: `${name(task)} keeps failing a few hidden tests, so a referee (a different model) is checking whether the tests match the spec.` });
      } else if (d.status === "reviewing") {
        const tries = Math.max(task.attempts.length, d.attempt ?? task.attempt);
        say({ who: "tech lead", channel: ch, task_id: task.id, tone: "warn",
              text: `${name(task)} didn't pass after ${tries} ${tries === 1 ? "try" : "tries"}, so the tech lead (a different model) ` +
                    "is reading the attempts, the failing tests and the code to decide what to do next." });
      } else if (d.status === "failed" && task.question) {
        // escalated already said why, with the tech lead's question
      } else if (d.status === "merged" && task.role === "dev") {
        say({ who: "engine", channel: "build", task_id: task.id, tone: "good", text: `Verified and merged ${mod(task)}.` });
      } else if (d.status === "passed" && task.role === "qa") {
        say({ who: "engine", channel: "tests", task_id: task.id, tone: "good",
              text: changeKind(task) === "change"
                ? `Accepted the tests for ${name(task)}. At least one fails on the current code, as it should until the change is made, and they stay hidden from the dev agent.`
                : `Accepted the tests for ${name(task)}. They all fail on the empty code, as they should, and stay hidden from the dev agent.` });
      } else if (d.status === "blocked" && isQuick(task.id)) {
        // quick_blocked says it, with the way forward
      } else if (d.status === "blocked") {
        say({ who: "engine", channel: ch, task_id: task.id, tone: "bad", text: `Paused ${name(task)}: ${d.error ?? "a dependency didn't finish"}.` });
      } else if (d.status === "failed" || d.status === "error") {
        say({ who: "engine", channel: ch, task_id: task.id, tone: "bad",
              text: `${name(task)} needs you: ${d.status === "error" ? d.error ?? "infrastructure error"
                : isQuick(task.id) ? "2 tries, still not passing the whole-app check"
                : `${Math.max(3, task.attempts.length)} tries, still not passing`}.` });
      }
      break;
    }
    case "attempt_finished": {
      const a = e.data as unknown as Attempt;
      if (!task) {
        // referee and confirmation reviews (T1-review, T1-confirm) are never queued, but they cost money too
        cost_usd = round(cost_usd + Number(a.cost_usd ?? 0));
        break;
      }
      tasks[task.id] = { ...task, attempts: [...task.attempts, a], cost_usd: round(task.cost_usd + a.cost_usd) };
      cost_usd = round(cost_usd + a.cost_usd);
      if (!a.passed && !(isQuick(task.id) && a.reason.startsWith(NEEDS_CHANGE))) {
        const claimed = a.claim.toLowerCase().startsWith("done");
        say({ who: "engine", channel: channelFor(task.role), task_id: task.id, tone: "warn",
              text: claimed
                ? `The agent on ${name(task)} said it was done, but the checks disagree (${a.reason}). Sent it back with the details.`
                : `Try ${a.n} on ${name(task)} was rejected: ${a.reason}.` });
      }
      break;
    }
    case "agent_activity": {
      // Frequent (one every ~10 s per running agent): kept on the task, never added to the feed.
      if (!task) break;
      const d = e.data as { note?: string; notes?: string[] };
      const incoming = d.notes?.length ? d.notes : d.note ? [d.note] : [];
      if (incoming.length) tasks[task.id] = { ...task, notes: [...(task.notes ?? []), ...incoming].slice(-NOTES_KEPT) };
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
    case "tech_lead_review": {
      if (!task) break;
      const d = e.data as { decision?: string; note?: unknown; question?: unknown; stronger_model?: unknown; model?: unknown;
                            tech_lead_error?: unknown };
      const text = (x: unknown) => (typeof x === "string" ? x.trim() : "");
      const review: TechLeadReview = {
        decision: d.decision === "retry" ? "retry" : "escalate", note: text(d.note), stronger_model: Boolean(d.stronger_model),
        t: e.t, ...(text(d.question) ? { question: text(d.question) } : {}), ...(text(d.model) ? { model: text(d.model) } : {}),
        ...(d.tech_lead_error ? { error: true } : {}),
      };
      const next: TaskState = { ...task, review };
      delete next.retry_model;
      if (review.decision === "retry" && review.model) next.retry_model = review.model;
      tasks[task.id] = next;
      const ch = channelFor(task.role);
      if (review.error) {
        say({ who: "tech lead", channel: ch, task_id: task.id, tone: "bad",
              text: `The tech lead couldn't review ${name(task)} (its run hit an error), so it comes to you.` });
      } else if (review.decision === "retry") {
        say({ who: "tech lead", channel: ch, task_id: task.id,
              text: `Tech lead reviewed ${name(task)}: trying again${review.model ? ` on ${modelName(review.model)}` : ""}.` +
                    `${review.note ? ` ${review.note}` : ""}` });
      } else if (review.note) {
        say({ who: "tech lead", channel: ch, task_id: task.id, text: `Tech lead reviewed ${name(task)}: ${review.note}` });
      }
      break;
    }
    case "escalated": {
      if (!task) break;
      const q = (e.data as { question?: unknown }).question;
      const question = (typeof q === "string" && q.trim()) || task.review?.question ||
                       "The tech lead couldn't get this feature to pass. How should it work?";
      tasks[task.id] = { ...task, question };
      say({ who: "tech lead", channel: channelFor(task.role), task_id: task.id, tone: "bad",
            text: `Tech lead needs you on ${name(task)}: ${question}` });
      break;
    }
    case "plan_ready": {
      plan = (e.data as { plan: Plan }).plan;
      status = "awaiting_approval";
      say({ who: "planner", channel: "planning",
            text: `Plan ready: ${plan.tasks.length} features and a shared contract (${plan.contracts.join(", ")}). Waiting for your approval.` });
      break;
    }
    case "change_started": {
      const d = e.data as { n: number; text: string };
      const entry: ChangeState = { n: d.n, text: d.text, summary: "", contracts: [], tasks: [], pages: [],
                                   decision: "planning", before: latest?.n === d.n ? latest.before : status };
      changes = [...changes.filter((c) => c.n !== d.n), entry];
      status = "planning";
      say({ who: "you", channel: "planning", text: `Change ${d.n} requested: ${d.text}` });
      break;
    }
    case "change_plan_ready": {
      const d = e.data as { n: number; change: Partial<ChangeState> & { request?: string; tasks?: ChangeTask[] } };
      const c = d.change ?? {};
      const fields = { summary: c.summary ?? "", contracts: c.contracts ?? [], tasks: c.tasks ?? [], pages: c.pages ?? [],
                       decision: "pending" as const };
      if (changes.some((x) => x.n === d.n)) setChange(d.n, fields);
      else changes = [...changes, { n: d.n, text: c.request ?? "", before: status, ...fields }];  // change_started missed
      status = "awaiting_approval";
      const k = fields.tasks.length;
      say({ who: "planner", channel: "planning",
            text: `Change ${d.n} planned: ${k} task${k === 1 ? "" : "s"}. ${fields.summary ? `${fields.summary} ` : ""}Waiting for your approval.` });
      break;
    }
    case "plan_decision": {
      const d = e.data as { approved: boolean; note?: string };
      status = d.approved ? "building" : "rejected";
      if (d.approved) ready_to_ship = null; // a new run: its own ship gate
      if (latest?.decision === "pending") {
        setChange(latest.n, { decision: d.approved ? "approved" : "rejected" });
        say({ who: "you", channel: "planning",
              text: d.approved ? `Approved change ${latest.n}. Building started.`
                               : `Sent change ${latest.n} back${d.note ? `: ${d.note}` : "."}` });
        break;
      }
      say({ who: "you", channel: "planning",
            text: d.approved ? "Approved the plan. Building started." : `Sent the plan back${d.note ? `: ${d.note}` : "."}` });
      break;
    }
    case "budget_reached": {
      const d = e.data as { spent?: number; budget?: number };
      budget_reached = { spent: Number(d.spent ?? cost_usd), budget: Number(d.budget ?? 0) };
      say({ who: "engine", channel: "build", tone: "warn",
            text: `Reached the spending limit: ${money(budget_reached.spent)} of ${money(budget_reached.budget)}. ` +
                  `Agents already at work finish; nothing new starts. Raise the limit on the plan page, then retry what's left.` });
      break;
    }
    case "template_updated": {
      const files = (e.data as { files?: string[] }).files ?? [];
      say({ who: "engine", channel: "build",
            text: `Updated ${files.length} template file${files.length === 1 ? "" : "s"} to the current version (the app's own pages and code are unchanged).` });
      break;
    }
    case "build_resumed": {
      const d = e.data as { merged: string[]; retrying: string[] };
      status = "building";
      budget_reached = null;
      ready_to_ship = null;
      const retrying = new Set((d.retrying ?? []).map(featureId));
      deferred = deferred.filter((id) => !retrying.has(id)); // "Build saved features": they're being built now
      const kept = d.merged.filter((id) => id !== "PLAN").length;
      say({ who: "engine", channel: "build",
            text: `Retrying ${d.retrying.length} unfinished task${d.retrying.length === 1 ? "" : "s"} in the same repo. ` +
                  `The ${kept} feature${kept === 1 ? "" : "s"} that merged stay as they are.` });
      break;
    }
    case "quick_started": {
      const d = e.data as { n: number; text: string };
      const prev = quicks.find((q) => q.n === d.n);
      quicks = [...quicks.filter((q) => q.n !== d.n), { n: d.n, text: d.text, result: "running", before: prev?.before ?? status }];
      status = "building";
      say({ who: "you", channel: "build", task_id: quickId(d.n), text: `Quick change ${d.n} requested: ${d.text}` });
      break;
    }
    case "quick_blocked": {
      const d = e.data as { n: number; reason?: string };
      const reason = d.reason ?? NEEDS_CHANGE;
      setQuick(d.n, { result: "blocked", reason });
      say({ who: "engine", channel: "build", task_id: quickId(d.n), tone: "warn",
            text: `Quick change ${d.n} is bigger than a quick change (${reason.replace(/^needs a change request:?\s*/, "") || "it needs new data or a feature"}). ` +
                  "Nothing was changed. Send it as a change request instead, and the planner will plan it." });
      break;
    }
    case "project_finished": {
      const d = e.data as { status: "done" | "failed" | "rejected" | "stopped" | "blocked" };
      if (runningQuick || (quicks.at(-1)?.result === "blocked" && d.status === "blocked")) {
        // a quick change's run: one that didn't merge left the app as it was (Convex record does the same)
        const q = (runningQuick ?? quicks.at(-1))!;
        const result = q.result === "blocked" || d.status === "blocked" ? "blocked" : d.status === "done" ? "done" : "failed";
        setQuick(q.n, { result });
        status = result === "done" ? "done" : q.before;
        if (result === "done") {
          say({ who: "engine", channel: "build", tone: "good", task_id: quickId(q.n),
                text: `Quick change ${q.n} is live in the repo: types, tests, a production build and every page checked, then merged.` });
        } else if (result === "failed") {
          say({ who: "engine", channel: "build", tone: "bad", task_id: quickId(q.n),
                text: `Quick change ${q.n} didn't pass the whole-app check, so nothing was merged. The app is as it was.` });
        }
        break;
      }
      if (d.status === "rejected" && latest?.decision === "rejected") {
        // a sent-back change built nothing: the project is as it was (Convex record does the same)
        status = latest.before;
        say({ who: "engine", channel: "build", text: `Change ${latest.n} was sent back, so nothing was built. The app is as it was.` });
        break;
      }
      status = d.status as ProjectState["status"];
      const devs = Object.values(tasks).filter((t) => t.role === "dev" && !isQuick(t.id));
      const ok = devs.filter((t) => t.status === "merged").length;
      const later = deferred.length ? `, ${deferred.length} saved for the next version` : "";
      say({ who: "engine", channel: "build", tone: d.status === "done" ? "good" : d.status === "stopped" ? "warn" : "bad",
            text: `${d.status === "done" ? "Finished" : d.status === "stopped" ? "Stopped at the spending limit" : "Stopped"}: ` +
                  `${ok} of ${devs.length} features verified and merged${later}, ${money(cost_usd)} in total.` });
      break;
    }
    case "pm_deferred": {
      // the owner approved with "Save these for later": these features aren't built in this run
      const d = e.data as { tasks?: unknown; titles?: unknown };
      const ids = Array.isArray(d.tasks) ? d.tasks.filter((x): x is string => typeof x === "string") : [];
      if (!ids.length) break;
      deferred = [...new Set([...deferred, ...ids])];
      const given = Array.isArray(d.titles) ? d.titles.filter((x): x is string => typeof x === "string") : [];
      const titles = given.length === ids.length ? given : ids.map((id) => plan?.tasks.find((p) => p.id === id)?.title ?? id);
      say({ who: "PM", channel: "build",
            text: `Saving ${ids.length} feature${ids.length === 1 ? "" : "s"} for the next version, as you chose: ` +
                  `${listText(titles)}. Every Must feature is built now; build the saved ones later from the board.` });
      break;
    }
    case "ready_to_ship": {
      const d = e.data as { saved?: unknown; musts?: unknown };
      const saved = Array.isArray(d.saved) ? d.saved.filter((x): x is string => typeof x === "string") : [];
      const musts = Number(d.musts ?? 0);
      ready_to_ship = { saved, musts, t: e.t };
      const titles = saved.map((id) => plan?.tasks.find((p) => p.id === id)?.title ?? id);
      say({ who: "PM", channel: "build", tone: "good",
            text: `Ready to ship: every Must feature passes${musts > 0 ? ` (${musts} of ${musts})` : ""}.` +
                  (titles.length ? ` Saved for the next version: ${listText(titles)}.` : "") +
                  " Ship it from the Ship page when you're ready." });
      break;
    }
    case "retro_written": {
      const summary = String((e.data as { summary?: unknown }).summary ?? "").trim().slice(0, 600);
      if (!summary) break;
      retros = [...retros, { summary, t: e.t }];
      say({ who: "PM", channel: "build", text: `Retro notes for the next run: ${summary}` });
      break;
    }
    case "preview_ready": {
      const url = (e.data as { url?: unknown }).url;
      if (typeof url !== "string" || !url.startsWith("https://")) break;
      preview_url = url;
      say({ who: "engine", channel: "build", tone: "good",
            text: durable_db ? `Preview is live at ${url}. Its data is kept in the app's own database.`
                             : `Preview is live at ${url}. It runs without a real database, so preview data resets.` });
      break;
    }
    case "database_ready": {
      // docs/databases.md: the preview's own Postgres. Once a project has one it keeps it (the name never changes).
      const name = (e.data as { name?: unknown }).name;
      const first = !durable_db;
      durable_db = true;
      if (first) {
        say({ who: "engine", channel: "build", tone: "good",
              text: `The app has its own database${typeof name === "string" ? ` (${name})` : ""}, so preview data is kept between visits and deploys.` });
      }
      break;
    }
    case "database_failed": {
      const d = e.data as { reason?: string };
      say({ who: "engine", channel: "build", tone: "warn",
            text: `Couldn't set up the app's database: ${d.reason ?? "unknown error"}.` +
                  (durable_db ? " The preview keeps using the database it already has." : " The preview runs without one, so its data resets.") });
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
  return { status, plan, tasks, feed, cost_usd, now: Math.max(s.now, e.t), preview_url, durable_db, changes, change: changes.at(-1) ?? null,
           budget_reached, quicks, deferred, ready_to_ship, retros };
}

/* --------------------------------------------------------------- board columns */
export type Column = "queued" | "tests" | "building" | "checking" | "done" | "attention"
  | "saved"; // saved for the next version by the PM: shown apart from COLUMNS, never "needs you"

export const COLUMNS: { id: Column; label: string; hint: string }[] = [
  { id: "queued", label: "Up next", hint: "Waiting for its turn" },
  { id: "tests", label: "Writing tests", hint: "QA agent, before any code" },
  { id: "building", label: "Building", hint: "Dev agent at work" },
  { id: "checking", label: "Checking", hint: "Engine runs the hidden tests" },
  { id: "done", label: "Done", hint: "Verified and merged" },
  { id: "attention", label: "Needs you", hint: "Failed, blocked, errored or stopped at the limit" },
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
  priority: TaskPriority;  // must (also when the plan has none), should or could
  reviewing: boolean;      // the tech lead is reviewing its failed tries
  question?: string;       // the tech lead's open question for you (a failed dev task)
  retry_model?: string;    // the tech lead moved its extra tries to this model ("sonnet")
};

const BAD = new Set(["failed", "blocked", "error", "merge_conflict", "stopped"]);
/** A task agent at work, or about to merge: a saved feature in one of these is being built after all. */
const ACTIVE = new Set(["working", "checking", "merging", "disputing", "reviewing"]);

/** One card per planned feature, combining its QA task and its dev task, then the cards of approved changes
 *  (C1T1, C1T2, ...), then the integration card, then quick changes the engine has queued (Q1, Q2, ...). */
export function features(s: ProjectState): Feature[] {
  if (!s.plan) return [];
  const integ = s.tasks[INTEGRATION];
  const planned: PlanTask[] = [...s.plan.tasks, ...boardChangeTasks(s)];
  const cards = integ
    ? [...planned, { id: INTEGRATION, title: "Put it together: pages, sign-in and data", module: "src/app",
                          spec: "Wires every merged feature into a working website. Checked with a production build " +
                                "and by opening every page.", depends_on: integ.depends_on }]
    : planned;
  const quickCards = s.quicks.filter((q) => s.tasks[quickId(q.n)]).map((q) => ({
    id: quickId(q.n), title: `Quick change ${q.n}`, module: "src/app, src/components",
    spec: `${q.text}\n\nOne agent edits only the pages and components; the whole app is checked (types, tests, a ` +
          "production build, every page) before it merges. No plan or approval.", depends_on: [] as string[] }));
  const deferred = new Set(s.deferred ?? []);
  return [...cards, ...quickCards].map((p) => {
    const qa = s.tasks[`${p.id}-qa`];
    const dev = s.tasks[p.id];
    let column: Column = "queued";
    let active: Role | null = null;
    if (deferred.has(p.id) && dev?.status !== "merged" && !(dev && ACTIVE.has(dev.status)) && !(qa && ACTIVE.has(qa.status))) {
      column = "saved"; // not built in this run: not a failure, never "needs you"
    } else if ((qa && BAD.has(qa.status)) || (dev && BAD.has(dev.status))) column = "attention";
    else if (dev?.status === "merged") column = "done";
    else if (dev && ["checking", "merging", "disputing", "reviewing"].includes(dev.status)) { column = "checking"; active = "dev"; }
    else if (dev?.status === "working") { column = "building"; active = "dev"; }
    else if (qa && ["working", "checking"].includes(qa.status)) { column = "tests"; active = "qa"; }
    // saved features aren't waited for (the integrator goes ahead without them)
    const waitingOn = p.depends_on.filter((d) => s.tasks[d]?.status !== "merged" && !deferred.has(d));
    return {
      id: p.id, title: p.title, module: p.module, spec: p.spec, depends_on: p.depends_on, column, qa, dev,
      cost_usd: round((qa?.cost_usd ?? 0) + (dev?.cost_usd ?? 0)), waitingOn, active,
      tries: Math.max(dev?.attempts.length ?? 0, dev?.attempt ?? 0),
      priority: priorityOf(p),
      reviewing: dev?.status === "reviewing",
      ...(dev?.status === "failed" && dev.question ? { question: dev.question } : {}),
      ...(dev?.retry_model ? { retry_model: dev.retry_model } : {}),
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
