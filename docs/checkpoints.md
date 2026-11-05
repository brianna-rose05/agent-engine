# Checkpoints and rollback: the contract between engine, worker, Convex and the app

Every finished build or change is a named save point. The owner can roll the project back to one from the
History view (`/p/[id]/history`). Nothing is ever deleted: a rollback is one new commit on top of main.

## In the repo (engine/checkpoints.py)
- A checkpoint is an annotated tag `checkpoint-<n>` on main; its message is the label. `n` is one more
  than the highest existing `checkpoint-*` tag (a fresh clone fetches them all). The tag is pushed when
  the repo has a remote; if the push fails the local tag is deleted and `CheckpointError` is raised, so a
  checkpoint the app hears about always exists in the project's repo.
- `rollback(repo, n, label=None)` makes main's tree equal to `checkpoint-n`'s tree with ONE new commit
  (`git commit-tree <tree> -p main`), message `Roll back to checkpoint N: <label>` (default: the
  checkpoint's own label). Main moves by fast-forward only and is pushed without force; if the push is
  refused the clone's main is put back and `CheckpointError` is raised. It then saves the result as a new
  checkpoint (so rolling forward is just another rollback).
- plan.json and changes/ roll back with the tree. That is intended: the restored plan.json is the plan of
  the restored app, and the next change plans on top of it. Change numbers in Convex keep counting up, so
  a later change never reuses a rolled-away `changes/{n}.json` name or `C{n}T{k}` task id.
- All of it runs under `engine.gitlock.repo_lock`, like every other change to the shared repo's refs.

## Flow
1. A worker run (fresh build, `resume` retry, or `change`) that finishes with status `done` calls
   `save_checkpoint` before `project_finished`. Labels: `Build finished`, `Retry finished`,
   `Change N: <first 60 chars of the request>…`. A failed save is printed and skipped; it never fails the run.
2. App: History lists checkpoints newest first (label, when, short sha linking to the GitHub commit,
   `current` marker) with "Roll back to this" behind a confirm step. It calls
   `checkpoints.rollbackTo({key, id, n})` (Convex, web/convex/checkpoints.ts): owner check; allowed only
   when the status is `done` or `failed` (nothing running), the project has a repo and checkpoint n is on
   the row. Sets `status: "queued"`, `mode: "rollback"`, `rollback: {n, from: <status before>}`, and starts
   the worker.
3. `engine:projectForWorker` returns `mode: "rollback"`, `rollback: {n}`, `repo`, and `merged` = the
   merged list saved with checkpoint n.
4. Worker, mode rollback (no agents, no sandboxes): clones the repo like a retry, then `run_rollback`:
   emits `rollback_started`, rolls back, emits `rollback_done` and `checkpoint_created` for the new
   checkpoint (carrying the target's merged list), then `project_finished {status: "done", repo}` and
   redeploys the preview through `publish_preview` (a checkpoint is always a finished app). On failure:
   `rollback_failed`, then `project_finished {status: "failed"}`; main is unchanged.
5. Convex `record`: `checkpoint_created` appends `{n, tag, sha, label, at (ms), merged}` to the project's
   `checkpoints`; `rollback_started` sets status `building`; a `project_finished` with status `failed` in
   mode rollback restores `rollback.from` (the project is as it was, like a sent-back change).

## Merged bookkeeping after a rollback (the rule)
Retries and changes use `merged`: the task ids whose latest `task_status` is `merged`, computed from
events (`mergedTasks` in web/convex/checkpoints.ts). Every `checkpoint_created` carries `merged`, the
task ids merged at that point (the worker's `merged` from Convex plus what merged in the run). When
`mergedTasks` meets a `rollback_done {to}`, it replaces everything before it with checkpoint `to`'s list;
task events after the rollback apply as usual. So rolled-away tasks are never claimed as merged, and a
later retry rebuilds anything that is missing from the restored plan.json. The app reducer
(web/src/lib/history.ts) applies the same rule to the board: rolled-away tasks get status `rolled_back`
and a change whose work was all rolled away leaves the board; rolling forward brings them back.

## Events (all through engine Emitter -> Convex `record` -> app reducer, feed channel `build`)
| kind | task_id | data |
|---|---|---|
| checkpoint_created | null | {n, tag, sha, label, merged} |
| rollback_started | null | {n} |
| rollback_done | null | {to, n, sha} (n: the new checkpoint, null if only its tag failed) |
| rollback_failed | null | {n, reason} |
| project_finished | null | {status, repo} (existing) |

The app marks a checkpoint `current` from the newest `checkpoint_created` until a later run stops with
status `failed` (it may have merged work, so main is past the checkpoint).
