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
python3 run_benchmark.py --agent reference             # free sanity check, expect 8/8 merged
python3 run_benchmark.py --agent claude-sdk --tasks B6 --model haiku --budget 0.25      # ~1 cent, local
python3 run_benchmark.py --agent claude-cli --sandbox daytona \
  --repo-url https://github.com/brianna-rose05/paws-bench --model haiku --budget 0.50  # all 8 tasks, cloud
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
- **Never trust the agent's claim:** the engine verifies work itself. When changing the engine,
  keep that property and add a test for any bug you fix (see tests/test_engine.py for examples).
- **Daytona:** if a run is interrupted, remind the user to check the Daytona dashboard for
  leftover sandboxes.
- Keep `pytest` green before and after any code change.
