# The architect: a check on the contracts before you approve a plan

Product rule: "Human decides architecture, AI implements. Any change to stack, schema, or contracts goes through an
approval gate." The owner's approval of a plan is that gate, but until now nothing helped the owner see a broken
contract. The plan checks are mechanical (format, files, stubs that type-check); they can't tell that a change plan
removes a function two pages still import.

Regression (Tool library change 1, Nov 5): the change plan removed `requireAdmin` from `src/server/profiles.ts` while
two pages still imported it. Nothing caught it until five dev attempts and a tech lead review had failed. CHANGE_GUIDE
now tells the planner not to do this; the architect is the check that it didn't.

Now an architect reviews every plan before the owner sees it. It runs on Sonnet, a different model from a Haiku
planner; when the planner is Sonnet too, it is still a separate run that never saw the planner's session. It never
edits code: it writes a verdict, and the owner decides.

## When it runs
- For the planner of a new build (`PLAN`) and of every change request (`C{n}PLAN`). Never for a retry (which doesn't
  plan), quick changes, or any other task.
- Only after the plan has passed every mechanical check (`plan_check`, `change_check`). A plan that fails them goes back
  to the planner as before, without a review.
- Before the plan merges, so before `plan_ready` / `change_plan_ready` and the owner's approval.
- Not when the spending limit doesn't allow it. Then the plan goes on without a review (`skipped: true`).

## What it sees and checks
It runs as its own task (`PLAN-architect`, then `PLAN-architect2` for the second review; `C1PLAN-architect`, ...) in a
sandbox of main with the planner's files written in, exactly as the plan leaves them, so `git status` and `git diff`
show what the planner wrote. Nothing it does is merged. Its instructions (`ARCHITECT_SPEC`) list:

1. **Contracts**: every task's dependencies are provided by a contract or a task module; no task relies on a type,
   table, column or function nothing provides.
2. **Migrations**: never editing an already-merged migration; on an existing project (a change), no destructive
   migration (drop table or column, narrowing a type, NOT NULL without a default on a table that has rows, deleting
   rows) unless the owner asked for exactly that.
3. **Security**: RLS turned off, policies widened to every user, ownership or role checks dropped ("Security: ...").
4. **Removed or changed exports** (changes): every exported name the change removes, renames or changes the signature
   of, in the code, a contract, or only in a spec's words. For each, the spec tells it to find the users with
   `git grep -n -w "<name>" -- . ':!changes/{n}.json' ':!plan.json'`. A user the change can't edit (a page, another
   module) means the old name must stay as a thin wrapper.

On top of that the engine compares the code itself: names a changed file exported on main and no longer exports are
listed in the spec with their users on main (`removed_exports`), so the easy case never depends on the model noticing.

It writes `review/<PLAN or C{n}PLAN>-architect.json`:

```json
{"verdict": "approve" or "changes",
 "comments": ["short, specific, plain English", ...]}
```

"changes" only for the problems above; never for style, naming or how the work is split. When unsure, it approves.

## What happens next
- **approve**: the plan merges and goes to the owner, as before.
- **changes (first review)**: that plan attempt counts as failed with the reason "the architect requested changes". The
  planner gets one more try (an extra attempt; its other tries stay for the mechanical checks) with feedback that lists
  the comments. It starts from main again, so it writes the whole plan again. If that plan fails the mechanical checks,
  its next try still carries the comments.
- **changes again (second review)**: the plan merges anyway and goes to the owner, with the comments attached as
  warnings (`warnings: true`). The owner decides: human decides architecture.
- **A broken review never blocks planning.** If the architect crashes, writes no file, or writes one that isn't valid,
  the plan goes on with `architect_error: true`.

## Events (task-scoped, task id = the planner's: PLAN or C{n}PLAN)
- `task_status {status: "architect_reviewing", attempt}` while it reviews
- `architect_review {verdict, comments, round: 1 | 2, warnings?: true, architect_error?: true, skipped?: true}`
- then the plan attempt's `attempt_finished` (passed, or failed with "the architect requested changes"), and either
  the next planner try or `merging`/`merged`, then `plan_ready` / `change_plan_ready` as before

## In the app
- The feed has an Architect with its own avatar and colour: "Architect approved the plan.", "Architect asked the planner
  to fix the plan: <first comment>", "Architect still has concerns: ... You decide.", "Architect review skipped
  (spending limit)", or a line saying the review couldn't run.
- The plan approval screen and the change approval card show the architect's verdict; with warnings, a warning box
  listing the comments sits above the Approve button.
- The architect's own runs are never cards; their cost counts toward the project's total.

## Where it lives
- engine/engine.py: the review step in the attempt loop (`_architect`, `_plan_files`, `normalize_architect_review`,
  `ARCHITECT_CHANGES`).
- engine/interfaces.py: `Task.review_plan`.
- engine/project.py: `ARCHITECT_SPEC`, `make_architect`, `removed_exports`, `exported_names`; the `architect` argument of
  `run_project` and `change_project`.
- engine/agents/prompt.py: the architect's rules (`ARCHITECT_RULES`).
- worker.py: `architect_agent` (Sonnet), passed to new builds and change runs.
- web/src/lib/reduce.ts (`architect_review`), web/src/lib/architect.ts, web/src/components/Architect.tsx, the plan
  page; tests in web/tests/architect.test.ts.
