# Agent engine (milestone 1): instructions for Claude Code

This repo is the core engine of an AI agent orchestration product, plus a benchmark that measures
how well coding agents complete tasks. See README.md for the full picture.

## Setup (only if `.venv` is missing)
```bash
python3 -m venv .venv && source .venv/bin/activate && pip install -q claude-agent-sdk daytona pytest
```
Always run commands with the venv active: `source .venv/bin/activate && ...`

## Common commands
```bash
python3 -m pytest -q                                   # unit tests, free, must stay green
python3 run_benchmark.py --agent reference             # free sanity check, expect 14/14 merged
python3 run_benchmark.py --agent claude-sdk --tasks B6 --model haiku --budget 0.25      # ~1 cent, local
python3 run_benchmark.py --agent claude-cli --sandbox daytona \
  --repo-url https://github.com/brianna-rose05/paws-bench --model haiku --budget 0.50  # all 14 tasks, cloud
```
Each run writes `results/<time>/report.md` and `results.json`. Summarize the report for the user
in plain language, including total cost.

## Rules
- **Secrets:** API keys live in `.env` (git-ignored). Never print, cat, echo, log, or commit `.env`
  or any key. `run_benchmark.py` loads it itself, so you never need to read it. If a key is
  missing, tell the user which one and ask them to add it to `.env`.
- **Spending:** runs that call real models cost money. Haiku runs with `--budget 0.50` or less are
  fine to run when asked. Ask the user before any run with `--model sonnet` or `opus`, a budget
  above $1, or more than one paid run in a row.
  Exception (set by Brianna, Nov 2 2026): when fixing the engine through GitHub Actions, up to
  5 Haiku runs at `--budget 0.50` or less per working session are pre-approved so the
  fix-and-rerun loop can work without her. Anything beyond that, ask first.
  Broadened (Brianna, Nov 2 2026, "run anything you need so we can start building"): benchmark
  runs on Haiku or Sonnet within the workflow's $1.00-per-attempt cap are approved for getting
  to the build phase. Opus, or raising the cap, still needs her OK.

## Running in GitHub Actions
The `Benchmark` workflow runs unit tests on every push. A paid benchmark runs only when triggered:
`gh workflow run benchmark.yml -f model=haiku -f budget=0.50`. Keys come from repo secrets
(`ANTHROPIC_API_KEY`, `DAYTONA_API_KEY`, `BENCH_GITHUB_TOKEN`). The report appears in the run
summary and as the `benchmark-results` artifact. The workflow refuses budgets above $1.00.
- **Never trust the agent's claim:** the engine verifies work itself. When changing the engine,
  keep that property and add a test for any bug you fix (see tests/test_engine.py for examples).
- **Daytona:** if a run is interrupted, remind the user to check the Daytona dashboard for
  leftover sandboxes.
- Keep `pytest` green before and after any code change.
