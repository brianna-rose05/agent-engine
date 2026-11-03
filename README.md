# Agent engine: milestone 1

The core loop of the product, built and tested: **one task → isolated sandbox → agent works →
the engine runs the checks itself → merge only if they pass → otherwise retry with the failure
output, then escalate.** It never trusts the agent saying "done."

Status: 35 automated tests pass. Everything that can be verified without your accounts has been.
The only thing left is running it with a real Claude agent.

## Decisions made

| Question | Decision | Why |
| --- | --- | --- |
| Sandbox provider | **Daytona** | No session cap (E2B's free plan stops at 1 hour; our tasks run up to 90 min), same price as E2B (~$0.05/vCPU-hour), $200 free credit, built-in git, GitHub/npm/PyPI reachable on the free tier. About **$0.66** for 4 agents × 1 hour. |
| Agent runtime | **Claude Agent SDK** (local) and **`claude` CLI in headless mode** (inside cloud sandboxes) | Same prompt and rules for both. The agent has to run *inside* a cloud sandbox, which the CLI makes simple. |
| Agent permissions | Only Read, Edit, Write, Bash, Glob, Grep; `dontAsk` mode; hard **$ budget cap per attempt** | Unlisted actions are denied, not prompted. `bypassPermissions` is never used. |
| Verification | Engine-run hidden acceptance tests + file-scope check + "made changes" check | Hidden tests are copied in only after the agent finishes, so they can't be gamed. |

## What was tested, and what it found

- **Benchmark validity (16 checks):** every hidden test fails on the empty starter code and passes on a
  known-correct solution, so a pass or fail actually means something.
- **Engine end to end with real git:** correct work merges first try; "done but broken" work is caught
  and retried; edits outside scope (an agent rewriting the locked data model) are rejected; a task that
  never succeeds is escalated after 3 tries; main is never left broken or half-merged.
- **Adapters (Claude SDK, Claude CLI, Daytona)** checked with fakes, and every CLI flag checked against
  the real `claude` binary. The CLI's real JSON output was captured and is now a test.

**Bugs found and fixed before any real run:**
1. Test runs left cache files that got committed and broke merges. Fixed: build artifacts are ignored,
   failed merges are aborted cleanly.
2. **Race condition:** while a slow task ran, other tasks merged into `main`, and the engine wrongly
   blamed the slow task for their files, rejecting correct work. Fixed (diff against the task's
   starting commit) with a regression test.
3. The CLI can report `subtype: "success"` on an auth failure. The adapter treats `is_error` as the
   real signal; locked in with a test.

## What only you can do (about 15 minutes)

1. **Anthropic API key**: console.anthropic.com → API Keys. Add a small credit (e.g. $10) and set a
   monthly spend limit in the console as a second safety net.
2. **Daytona account**: daytona.io → create an API key (free $200 credit, no card needed).
3. **GitHub**: create an **empty private repo** (e.g. `paws-bench`) and a fine-grained token with
   *Contents: read and write* on that repo only.
4. Set them in your terminal (never paste keys into chat or commit them):
   ```bash
   export ANTHROPIC_API_KEY=...   DAYTONA_API_KEY=...   GITHUB_TOKEN=...
   ```

## Commands

```bash
pip install claude-agent-sdk daytona pytest
python3 -m pytest -q                                   # 35 tests, no keys needed

python3 run_benchmark.py --agent reference             # sanity check: 8/8 merged, $0
python3 run_benchmark.py --agent sloppy                # shows failures being caught, $0

# First real run: one small task, cheap model, low cap (~cents)
python3 run_benchmark.py --agent claude-sdk --tasks B6 --model haiku --budget 0.25

# Full real run in cloud sandboxes, 4 agents in parallel
python3 run_benchmark.py --agent claude-cli --sandbox daytona \
  --repo-url https://github.com/<you>/paws-bench --model sonnet --budget 1.00
```

Each run saves `results/<time>/report.md` with merged count, first-try pass rate, silent failures
caught, retries, time, and cost per task. These are the numbers for the Team plan estimates and pricing.

**Cost ceiling:** the budget cap applies per attempt, so the worst case for the full run is
8 tasks × 3 attempts × $1 = **$24**. Realistically expect a few dollars. Start with the one-task run.

**Safety note:** `--agent claude-sdk` runs the agent on *your* computer, limited to the task folder and
the six tools above. That's fine for the one-task smoke test; use `--sandbox daytona` for anything bigger.

## Layout

```
engine/            the product's engine
  engine.py          the loop: sandbox → agent → verify → merge / retry / escalate
  interfaces.py      Task, Sandbox, Agent: the two swappable pieces
  agents/            claude_sdk.py, claude_cli.py, prompt.py, scripted.py (test stand-ins)
  sandboxes/         local_worktree.py, daytona_sandbox.py
benchmark/         8 realistic tasks on the dog-grooming booking app
  tasks.json         plain-English specs the agents see
  hidden_tests/      acceptance tests, added only at verification
  solutions/         reference answers that prove each task is solvable
run_benchmark.py   one command to run it all and write the report
tests/             35 tests for the engine, adapters, and benchmark
```

## Milestone 2: dependency graph and contracts first

- Tasks can list `depends_on`. The engine starts a task only after everything it depends on has
  merged, so its sandbox already holds that code. Independent tasks still run in parallel.
- If a dependency fails, everything downstream is marked **blocked** and never started, so no
  money is spent on work that can't succeed. A broken plan (unknown dependency, cycle) is
  rejected before any agent runs.
- Contract first: an architect task (`kind: contract`) writes the shared types before the dev
  tasks that use them start. Downstream tasks can't edit it, and their hidden tests check that
  they reuse existing modules instead of copying logic.
- Benchmark project D1-D4 (checkout): D1 contract -> D2 validation and D3 pricing (in parallel;
  D3 also needs B6 and B11) -> D4 checkout. Downstream tests run against the code earlier
  *agents* wrote, not the reference solutions.
- `--tasks D4` automatically brings in everything D4 depends on.

## Milestone 3: from a description to built code, no human in the loop

`engine/project.py`, `run_project.py`, workflow **Build project**.

1. **Plan.** A planner agent writes `plan.json` (tasks, modules, dependencies), the shared contract,
   and a stub per task whose docstrings are the spec. The engine checks the plan itself: format,
   2-10 tasks, one owner per module, no cycles or unknown dependencies, files exist, everything
   imports, task modules are real stubs. Problems go back to the planner as feedback (3 tries).
2. **QA.** For each task, in parallel, a QA agent writes acceptance tests from the spec. The engine
   accepts them only if they run cleanly, there are at least 3, and every one fails against the
   stub *because* it's unimplemented (so tests that check nothing are rejected). These tests are
   never merged: dev agents can't see them.
3. **Build.** Dev agents implement the tasks in dependency order (milestone 2), each graded by its
   hidden QA tests. A task waits for its dependencies and its own QA.

Found and fixed along the way: hidden tests were being committed with the agent's work after
verification, so later agents could read them on main. They're now removed before commit
(regression test in `tests/test_engine.py`).

```bash
python3 run_project.py --agent scripted     # free, offline, tool-library fixture
gh api -X POST repos/brianna-rose05/agent-engine/actions/workflows/project.yml/dispatches \
  -f ref=main -f 'inputs[model]=haiku' -f 'inputs[budget]=0.50'
```

## Milestone 4: the app (in progress)

`web/` is the Next.js app: **New project**, **Plan** (dependency map, approve or send back),
**Board** (one card per feature moving through tests, build, checking, done), and Slack-style
channels (#all, #planning, #tests, #build). Without Supabase settings it runs in demo mode,
replaying a real Haiku build of the community garden (`scripts/make_demo.py`).

The engine now streams every step as events (`engine/events.py`) and pauses after planning
for approval. `engine/supabase_sink.py` writes events into the tables in
`supabase/migrations/0001_projects.sql`; `worker.py` (workflow **Worker**) runs one project,
waiting for the owner's click in the app before building. The app turns the same events into
the same screens in both modes (`web/src/lib/reduce.ts`).

```bash
cd web && npm install && npm run dev        # http://localhost:3000, demo mode
```

### Hooking up Supabase (Brianna, about 10 minutes)
1. supabase.com -> New project (free tier). Wait for it to start.
2. SQL Editor -> paste `supabase/migrations/0001_projects.sql` -> Run.
3. Project Settings -> API: copy the **Project URL**, the **anon public** key and the
   **service_role** key.
4. GitHub -> agent-engine -> Settings -> Secrets and variables -> Actions -> add
   `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (service_role never goes in the web app).
5. Optional, for a link you can open anywhere: vercel.com -> Add New Project -> import
   agent-engine, Root Directory `web`, add env vars `NEXT_PUBLIC_SUPABASE_URL` and
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`.

Still to build once Supabase exists: sign-in (magic link), creating a project from the form,
and the API route that starts the Worker.

## Next (milestone 4, remaining)

Sign-in, live project creation, and a revise loop when you send a plan back.
