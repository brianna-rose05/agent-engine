# The tech lead: what happens when a feature fails every try

Before, a feature's dev task got 3 tries. If all 3 failed its hidden tests, the task was marked failed and the board
said it needed the owner, with nothing to go on but the last test output. Pawfect build 7 ended 24 of 25 that way.

Now a tech lead looks at it first. It is a stronger model (Sonnet) than a Haiku dev, and it never reviews its own
work. It either gives the dev better guidance and two more tries, or asks the owner one plain question.

## When it runs
- Only for a feature's dev task (the tasks from `feature_tasks` in engine/project.py), in a new build or a change
  request, and on retries of those. Never for QA tasks, the integrator, quick changes, or the referee and
  confirm reviews.
- Only when all the tries failed. A task that was stopped by the spending limit, blocked, or errored is left as
  it is.
- Once per task per run. If the extra tries fail too, there is no second review.
- Never when the spending limit doesn't allow it. Then the task ends "stopped", as with any try the limit
  keeps from starting.

## What it sees and decides
It runs as its own task (`<taskId>-techlead`) in a sandbox of main, with the hidden tests written in so it can read
them. Nothing it does is merged. Its instructions (`TECH_LEAD_SPEC`) hold the feature's spec, module and
contracts, every try's reason for rejection and the dev's final message, the end of the last test output, and the
last failed try's changes (a `git diff`, new files included, at most 8000 characters, captured before that
sandbox closed).

It writes `review/<taskId>-techlead.json`:

```json
{"decision": "retry" or "escalate",
 "note": "guidance for the dev, plain English",
 "question": "escalate only: one question for the owner, with the options",
 "stronger_model": true or false}
```

- **retry**: two more tries (attempt 4 and 5). The first one's feedback starts with "Your tech lead reviewed the
  failed attempts: <note>", followed by the last failure. If it asked for a stronger model and the dev isn't
  already on Sonnet, those tries use a Sonnet dev. The referee still settles disputed tests during them.
- **escalate**: the task ends failed with the error "Needs you: <question>".
- A retry that still fails ends the same way, with a general question.
- A tech lead that crashes, or writes no usable verdict, counts as an escalation with a general question
  ("The tech lead couldn't review this feature...") and `tech_lead_error: true`.

## Events (task-scoped, task id = the dev task)
- `task_status {status: "reviewing", attempt}` while it reviews
- `tech_lead_review {decision, note, stronger_model, question?, model?, tech_lead_error?}`. `model` is there
  only when the extra tries switch to the stronger dev agent.
- then the usual attempt events, numbered 4 and 5, for a retry
- `escalated {question}` when the task ends failed after a review
- the final `task_status {status: "failed", error: "Needs you: <question>"}`

## The owner's answer
The app stores answers on the project row as `answers: {<taskId>: "<answer>"}` and starts a retry. The worker
passes them to `resume_project`. In that run the dev task's first try gets the feedback "The project owner answered
the tech lead's question: <answer>". QA tasks and other features don't see it.

## Where it lives
- engine/engine.py: the review hook in the attempt loop (`_review`, `_escalate`, `normalize_review`).
- engine/interfaces.py: `Task.review_failure`, `Task.stronger_agent`, `Task.first_feedback`.
- engine/project.py: `TECH_LEAD_SPEC`, `make_tech_lead`, `parse_tech_lead_verdict`, `owner_feedback`.
- engine/agents/prompt.py: the tech lead's rules (`TECH_LEAD_RULES`).
- worker.py: `tech_lead_agents` (both Sonnet) and `owner_answers`, passed to all three flows.
