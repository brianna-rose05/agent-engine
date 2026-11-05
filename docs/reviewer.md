# The code reviewer: a second pair of eyes before a feature merges

Hidden acceptance tests catch a lot, but not everything. A feature can pass every test and still leave out
something the spec asks for, let one user read another user's data, or hard-code a secret. Until now nothing looked
for that: if the tests passed, the work merged.

Now a code reviewer reads every feature's passing attempt before it merges. It runs on Sonnet, a different model
from a Haiku dev. When the project's dev is Sonnet too, the reviewer is still a separate run that never saw the dev's
session. Together with QA (who writes the tests before any code exists) this keeps the rule: no agent grades its own
work.

## When it runs
- Only for a feature's dev task (the tasks from `feature_tasks` in engine/project.py), in a new build, a retry or a
  change request (both "change" and "new" change tasks). Never for QA tasks, the integrator, quick changes, or the
  referee, confirm, tech lead or reviewer tasks themselves.
- Only after an attempt has passed verification: the files are in scope and every check, hidden tests included, is
  green. An attempt that fails its checks is never reviewed.
- Not when the spending limit doesn't allow it. Then the attempt merges without a review and the app is told
  (`skipped: true`). A passing feature is never held back by the limit.

## What it sees and decides
It runs as its own task (`<taskId>-codereview`, then `-codereview2`, ... for later reviews of the same task) in a
sandbox of main, with the hidden tests written in so it can see what is already tested. Nothing it does is merged.
Its instructions (`REVIEWER_SPEC`) hold the feature's spec, module and contracts, the hidden tests' path, and the
attempt's changes (a `git diff`, new files included, at most 8000 characters).

The dev's sandbox is closed before the review starts: the passing work is committed to its branch first, so a task
never holds two sandboxes at once, and the branch merges if the reviewer approves.

It writes `review/<taskId>-review.json`:

```json
{"verdict": "approve" or "changes",
 "comments": ["short, specific, plain English", ...]}
```

It may ask for changes **only** for real problems the tests didn't catch:
- behavior the spec requires that is missing or wrong,
- a security problem: a missing sign-in, role or ownership check, one user's data reachable by another, a secret in
  the code, SQL built from input (these comments start with "Security:"),
- data loss,
- code that is a stub or a placeholder.

Never for style, naming or preferences. When unsure, it approves. An approval may carry comments as notes; they don't
block anything.

## What happens next
- **approve**: the attempt counts as passed and merges, as before.
- **changes**: the attempt counts as failed with the reason "the reviewer requested changes". The dev tries again
  (within its normal tries) with feedback that starts "Your previous attempt passed the acceptance tests, but the code
  reviewer (a different model) requested changes" and lists the comments. If every try ends up failing, the tech
  lead reviews the task as usual (docs/tech-lead.md).
- **Only one "changes" per task per run.** Every later review of the task is told it may block only for a security
  problem. If it says "changes" again without a comment starting "Security:", the engine approves anyway and notes
  it ("Only a security problem can hold a feature back a second time..."). A security problem keeps blocking.
- **A broken review never loses a feature.** If the reviewer crashes, writes no file, or writes one that isn't
  valid, the attempt merges on its passing tests and the event says `review_error: true`.

## The hidden tests stay hidden
The reviewer is told never to quote or name the hidden tests. On top of that, the engine drops every line of a comment
that contains a hidden test file's path or file name, before the comments reach the dev or the app. If nothing is
left of a "changes" verdict, it approves with a note.

## Events (task-scoped, task id = the dev task)
- `task_status {status: "reviewing_code", attempt}` while it reviews (the app: "In code review", board column
  Checking)
- `code_review {verdict, comments, attempt, note?, review_error?, skipped?}`
- then that attempt's `attempt_finished` (passed, or failed with "the reviewer requested changes" and the comments as
  its output), and `merging`/`merged` or the next try

## In the app
- The feed has a Reviewer with its own avatar and colour: "Reviewer approved Bookings.", "Reviewer asked for changes
  on Bookings: <first comment>", "Review skipped (spending limit): ...", or a line saying the review couldn't run.
- The board drawer shows the reviewer's comments as messages between the tries they are about, in order, with a
  "Security" tag on security comments.
- The reviewer's own runs are never cards; their cost counts toward the project's total.

## Where it lives
- engine/engine.py: the review step in the attempt loop (`_code_review`, `normalize_code_review`, `REVIEW_CHANGES`).
- engine/interfaces.py: `Task.review_code`.
- engine/project.py: `REVIEWER_SPEC`, `REVIEWER_SECOND`, `make_reviewer`, `parse_code_review`; the `reviewer` argument
  of `run_project`, `resume_project` and `change_project`.
- engine/agents/prompt.py: the reviewer's rules (`REVIEWER_RULES`).
- worker.py: `reviewer_agent` (Sonnet), passed to all three flows.
- web/src/lib/reduce.ts (`code_review`), web/src/components/Reviewer.tsx, the board drawer; tests in
  web/tests/reviewer.test.ts.
