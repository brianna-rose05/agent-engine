# Change requests: the contract between engine, worker, Convex and the app

A user asks for a change to a project that already has a repo (status `done`, or `failed` after planning),
for example "Keep the groomer when the date changes, store times in the salon's time zone, and show the
My bookings heading once". The team plans only that change, the user approves it, and the team builds it
in the same repo. Merged work stays; the engine still verifies everything.

## Flow
1. App: `projects.requestChange({key, id, text})` (Convex). Allowed when the project has a repo and is
   `done` or `failed` with a plan, and no change is running. Sets `status: "queued"`, `mode: "change"`,
   appends `{n, text, at}` to `changes` (n = 1, 2, ...), and starts the worker.
2. Convex `engine:projectForWorker` returns, for a change run: `mode: "change"`, `change: {n, text}`,
   `repo`, and `merged` (as for retries).
3. Worker (`worker.py`, mode change): clones the repo, then `change_project(...)` in engine/project.py:
   - Emits `change_started {n, text}`.
   - Runs a change-planner task with id `C{n}PLAN` (role "planner"). It reads plan.json, the code and the
     request, and writes `changes/{n}.json` (format below) plus any contract edits: new migrations only
     (never edit an existing migration), additive edits to src/contracts/*.ts, and updated doc comments in
     every module it changes (implementations stay; the doc comments become the new spec).
   - Once the change plan passes its checks, the architect (Sonnet) reviews its contracts and every export it
     removes before it merges (docs/architect.md): `architect_review` on `C{n}PLAN`, at most one replan, and any
     comments left after it reach the approval card as warnings.
   - Emits `change_plan_ready {n, change}` where `change` is the parsed changes/{n}.json, then waits for
     the user's decision exactly like plan approval (Convex status `awaiting_approval`, the app's
     approve / send back → `approved` / `rejected`), and emits `plan_decision {approved, note}`.
   - Builds the change's tasks (QA then dev, same engine rules, referee included) and, for web apps, the
     integration task again (id `INT`, waits for all change tasks; it may edit src/app/ to match).
   - Updates plan.json on main: change tasks with kind "change" replace the spec of the task that owns the
     module; "new" tasks are appended; `pages` is replaced by the change's `pages`.
   - Emits `project_finished {status, repo}` as usual.
4. Convex `record`: `change_started` → status `planning`; `change_plan_ready` → status
   `awaiting_approval` and stores the change on the project (`pendingChange`); `plan_decision` and
   `project_finished` as today.

## changes/{n}.json
```json
{"n": 1,
 "request": "<the user's words>",
 "summary": "<one or two plain sentences: what will change>",
 "contracts": ["supabase/migrations/0003_timezone.sql", "src/contracts/types.ts"],
 "tasks": [
   {"id": "C1T1", "kind": "change", "title": "Store times in the salon's time zone",
    "module": "src/server/bookings.ts", "spec": "<what changes, precise enough to test>", "depends_on": []},
   {"id": "C1T2", "kind": "new", "title": "...", "module": "src/server/reviews.ts", "spec": "...", "depends_on": ["C1T1"]}
 ],
 "pages": ["/", "/book", "..."]}
```
- Task ids: `C{n}T{k}`. depends_on may only name tasks in this change (earlier work is already merged).
- 1 to 10 tasks. A module is owned by at most one task in the change.
- `kind: "change"` tasks must name a module that exists; `kind: "new"` a module that doesn't.
- UI-only fixes in pages (src/app/) have no task of their own: describe them in `summary` and the
  integration task handles them.

## Tests for a change
- QA for a `change` task writes tests for the changed behavior. They must run cleanly, and at least one
  test must fail on the current code (the change isn't made yet). Tests of unchanged behavior may pass.
  The "not implemented" rule applies only to `new` tasks.
- The dev's hidden tests are those QA tests; the dev may only edit the task's module (and tests/unit/*).
- The integration check runs the whole test suite, so a change that breaks earlier work fails there.

## Events (all through engine Emitter → Convex `record` → app reducer)
| kind | task_id | data |
|---|---|---|
| change_started | null | {n, text} |
| change_plan_ready | null | {n, change} |
| plan_decision | null | {approved, note} (existing) |
| task_queued / task_status / attempt_finished / agent_activity / dispute_resolved | C{n}T{k}, C{n}T{k}-qa, C{n}PLAN, INT | existing shapes |
| project_finished | null | {status, repo} (existing) |
