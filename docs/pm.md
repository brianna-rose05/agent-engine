# The PM: priorities, saved features, the ship gate and retro notes

The PM is the part of the team that keeps a build focused on what matters most and remembers what went wrong.
This first slice is all rules, no model: the PM never calls Claude, so it costs nothing and always does the same
thing. One build is still one run; iterations come later.

The engine side lives in `engine/pm.py`, `engine/project.py` and `worker.py`. The app side (the approval card, the
board, the Ship page) is described in the shared contract and lives in `web/`.

## 1. Every task has a priority

The wizard sends every Must, Should and Could story to the planner (Out stays out). The planner gives each task in
`plan.json` two new fields:

```json
{"id": "T3", "title": "Overdue report", "module": "reports.py", "spec": "...", "depends_on": ["T1"],
 "stories": ["S4"], "priority": "could"}
```

- `priority` is `"must"`, `"should"` or `"could"`: the highest priority among the stories the task serves. A screen
  (UI component or page) gets the priority of the stories it shows.
- Both fields are optional. A task without a priority is a Must, so older plans and the benchmark work as before.
- The plan check refuses a task that depends on a lower-priority task: a Must may not depend on a Should or a
  Could, and a Should may not depend on a Could. The planner gets a message it can act on, for example:
  `T3 ("must") depends on T2 ("should"): ... give T2 priority "must" or drop the dependency`. The reason: a
  lower-priority task can be saved for later, and nothing important may be stranded waiting for it.
- In a change request, every new task is a Must (the owner asked for it).

## 2. Features saved for later

When the estimate is over budget, the approval screen suggests saving some Could and Should features for the next
version. If the owner agrees, the project row gets `deferred: [task ids]`.

- The worker reads `deferred` **after** the owner approves (the owner chooses on the approval screen while the
  worker waits), the same way it re-reads the spending limit.
- Saved features are not built: neither their QA tests nor their dev task run. A task that depends on a saved
  task is saved too (it could only end blocked). A Must is never saved, whatever the row says.
- At the start of the build the engine emits `pm_deferred {tasks, titles}` (only when something is saved). A retry
  that still leaves features saved emits it again.
- The integrator is told which features are saved for later: it does not wait for them, never imports their
  modules (they are still stubs), and keeps any page that exists only for them as a simple "coming soon" page.
- A build counts as done when everything that was meant to be built merged. Saved features are not failures.
- **Retry what failed** skips saved features too.
- **Build saved features**: the app clears `deferred` and starts a retry. The retry builds every feature that
  hasn't merged, and because new features now need wiring in, the integrator runs again even though it merged
  before.

## 3. The ship gate

The release is complete when every Must feature passes its tests and the app is integrated. Shoulds and Coulds
never block shipping.

After a run that finished `done`, if every Must task is merged (in this run or before) and the integration merged
(web apps), the worker emits `ready_to_ship {saved, musts}` once, right after `project_finished` and before the
preview is published. `saved` lists the Should and Could tasks that aren't merged (saved for later or failed);
`musts` is how many Must tasks the plan has. A Must that failed in this run (including any task of a change
request) means no ship gate. Ship and rollback runs never emit it.

## 4. Retro notes

After every build, retry and change run (not quick changes, ships, rollbacks, or a change the owner rejected) the
PM appends a section to `docs/retro.md` in the project's repo, commits it as `Retro: <run label>` and pushes it.
The run label is the checkpoint's label ("Build finished", "Retry finished", "Change 2: ..."). The section holds:

- the date and the run label
- how many tasks merged
- every task that didn't finish: its title, the last reason it was rejected, and the tech lead's question if any
- every task that took more than one try, with the reasons
- the features saved for later
- what the run cost

The retro is written before the checkpoint, so each save point includes its own notes. Then the worker emits
`retro_written {summary}`, a plain-English summary of at most 600 characters for the feed. If the retro can't be
committed or pushed, the run carries on exactly as before: nothing is emitted and the clone is put back as it was.

`docs/retro.md` belongs to the project, not to the template, and is never a task's module.

**Who reads it:** the change planner and the tech lead on a retry or a change get the last ~2000 characters of
`docs/retro.md` under "Notes from earlier runs (retro)", so they can learn from what failed before.

## Events

| Event | Data | When |
| --- | --- | --- |
| `pm_deferred` | `{tasks, titles}` | start of a build or retry that leaves features saved for later |
| `ready_to_ship` | `{saved, musts}` | after `project_finished` of a done run where every Must merged |
| `retro_written` | `{summary}` | after the retro section was pushed (before the checkpoint) |
