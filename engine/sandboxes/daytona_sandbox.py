"""Cloud sandbox on Daytona. Needs DAYTONA_API_KEY, plus a GitHub token that can push task branches.

Lifecycle per attempt: create -> clone repo -> new task branch -> (agent works) -> push branch -> delete.
The sandbox is always deleted, even if the attempt crashes, so nothing keeps billing.
"""
from __future__ import annotations

import os
import shlex
import time
import uuid
from typing import Callable

from engine.interfaces import ExecResult, SandboxUnavailable

WORKDIR = "repo"
# Installs what the agent and the checks need inside the sandbox: the Claude Code CLI and pytest.
SETUP = ("(command -v claude >/dev/null || npm install -g @anthropic-ai/claude-code >/dev/null 2>&1) && "
         "(python3 -m pytest --version >/dev/null 2>&1 || python3 -m pip install -q pytest >/dev/null 2>&1 "
         "|| python3 -m pip install -q --break-system-packages pytest >/dev/null 2>&1) && "
         "python3 -m pytest --version >/dev/null 2>&1")


# Web projects: a Node image with room for npm packages, TypeScript and an in-test Postgres.
# 3 GB each, 3 in parallel (WEB_PARALLEL), to stay under Daytona's default 10 GB account limit.
WEB_SETUP = ("(command -v claude >/dev/null || npm install -g @anthropic-ai/claude-code >/dev/null 2>&1) && "
             "npm ci --no-audit --no-fund --loglevel=error")


# exec_long: how much output to read back. The agent's result is the last line of its stream-json log.
FINAL_LINES = 100
STREAM_CAP = 2_000_000                  # bytes of new output read per poll

# Every sandbox is labeled as the engine's and cleans itself up if the engine dies mid-task (a cancelled
# job can't run its `finally`): it stops after 60 idle minutes (an attempt is capped well below that)
# and is deleted as soon as it stops. scripts/daytona_cleanup.py deletes by the same label.
LABELS = {"app": "agent-engine"}
IDLE_STOP_MINUTES = 60


def web_params():
    from daytona import CreateSandboxFromImageParams, Resources
    return CreateSandboxFromImageParams(image="node:22-bookworm", resources=Resources(cpu=2, memory=3, disk=8),
                                        labels=LABELS, auto_stop_interval=IDLE_STOP_MINUTES, ephemeral=True)


def default_params():
    from daytona import CreateSandboxFromSnapshotParams
    return CreateSandboxFromSnapshotParams(labels=LABELS, auto_stop_interval=IDLE_STOP_MINUTES, ephemeral=True)


class DaytonaSandbox:
    def __init__(self, repo_url: str, task_id: str, attempt: int, *, github_token: str | None = None,
                 client=None, setup_cmd: str = SETUP, run_id: str = "", create_params=None):
        self.repo_url = repo_url
        # Include the run id: branches from earlier runs live on in the shared GitHub repo,
        # and reusing a name makes the push fail (non-fast-forward).
        self.branch = f"task/{run_id}/{task_id}-a{attempt}" if run_id else f"task/{task_id}-a{attempt}"
        self.workdir = WORKDIR
        self.token = github_token or os.environ.get("GITHUB_TOKEN", "")
        self.setup_cmd = setup_cmd
        self.create_params = create_params
        self._client = client
        self.sb = None

    def __enter__(self):
        if self._client is None:
            from daytona import Daytona          # imported lazily so local runs don't need it
            self._client = Daytona()
        params = self.create_params if self.create_params is not None else default_params()
        # A unique name lets us find and delete a sandbox whose start failed: create() raises before we get
        # it back, and the half-started sandbox still holds its memory. Regression: three failed starts
        # (Daytona 502s) filled the account's 10 GB limit and stalled the fourth web run.
        name = f"engine-{uuid.uuid4().hex[:16]}"
        try:
            params.name = name
        except Exception:
            pass
        try:
            self.sb = self._client.create(params, timeout=900)   # a custom image is built once, then cached
        except Exception as e:
            self._delete_by_name(name)
            raise SandboxUnavailable(f"{type(e).__name__}: {e}") from e
        try:
            self.sb.git.clone(self.repo_url, WORKDIR, username="x-access-token", password=self.token)
            for cmd in ("git config user.email engine@agents.local", "git config user.name engine",
                        f"git checkout -q -b {shlex.quote(self.branch)}", self.setup_cmd):
                r = self.exec(cmd, timeout=900)
                if r.code != 0:
                    raise RuntimeError(f"sandbox setup failed on `{cmd}`: {r.output[-300:]}")
        except Exception:
            self.__exit__()
            raise
        return self

    def _delete_by_name(self, name: str) -> None:
        try:
            from daytona import ListSandboxesQuery
            query = ListSandboxesQuery(name=name)
        except Exception:
            query = None
        try:
            for box in self._client.list(query):
                if getattr(box, "name", None) == name:
                    self._client.delete(box, timeout=120)
        except Exception:
            pass                                 # best effort; the end-of-job cleanup catches the rest

    def __exit__(self, *exc):
        if self.sb is not None:
            try:
                self.sb.delete()
            finally:
                self.sb = None

    def exec(self, cmd: str, timeout: int = 600, env: dict[str, str] | None = None) -> ExecResult:
        r = self.sb.process.exec(cmd, cwd=WORKDIR, env=env, timeout=timeout)   # Daytona's default timeout is only 10s
        return ExecResult(r.exit_code, r.result or "")

    def exec_long(self, cmd: str, timeout: int, env: dict[str, str] | None = None, poll_s: float = 15,
                  sleep=time.sleep, on_output: Callable[[str], None] | None = None) -> ExecResult:
        """Run a long command (an agent) in the background and poll for it. Holding one HTTP request open
        for many minutes is fragile: the Pawfect planner lost its connection after 18 minutes and the
        whole project errored. A dropped poll is just retried.
        `on_output(text)` gets the new complete lines of output at each poll (live activity in the app).
        The returned output is only the last FINAL_LINES lines: a streamed agent log holds every file it
        read, which can run to megabytes, and the result the caller parses is the last line."""
        tag = uuid.uuid4().hex[:10]
        out, code = f"/tmp/run-{tag}.out", f"/tmp/run-{tag}.code"
        script = f"{cmd} > {out} 2>&1; echo $? > {code}"
        self.exec(f"nohup bash -c {shlex.quote(script)} > /dev/null 2>&1 &", timeout=60, env=env)
        deadline, misses, seen = time.monotonic() + timeout, 0, 0
        while time.monotonic() < deadline:
            sleep(poll_s)
            try:
                r = self.exec(f"cat {code} 2>/dev/null", timeout=60)
                misses = 0
            except Exception:
                misses += 1
                if misses >= 8:                  # about 2 minutes of failed polls: the sandbox is gone
                    raise
                continue
            if r.output.strip():
                return ExecResult(int(r.output.strip().splitlines()[-1]),
                                  self.exec(f"tail -n {FINAL_LINES} {out}", timeout=120).output)
            if on_output is not None:
                seen = self._stream(out, seen, on_output)
        return ExecResult(124, f"timed out after {timeout}s")

    def _stream(self, out: str, seen: int, on_output: Callable[[str], None]) -> int:
        """Pass the complete lines after the first `seen` to on_output; return the new count. A line still
        being written waits for the next poll; one longer than STREAM_CAP (a huge tool result) is skipped.
        Never raises: a missed read only delays the activity notes."""
        try:
            text = self.exec(f"tail -n +{seen + 1} {out} 2>/dev/null | head -c {STREAM_CAP}", timeout=60).output
        except Exception:
            return seen
        if "\n" not in text:
            return seen + 1 if len(text.encode()) >= STREAM_CAP - 8 else seen
        complete = text[: text.rindex("\n") + 1]
        try:
            on_output(complete)
        except Exception:
            pass
        return seen + complete.count("\n")

    def write_file(self, path: str, content: str) -> None:
        self.sb.fs.upload_file(content.encode(), f"{WORKDIR}/{path}")

    def publish(self, message: str) -> None:
        r = self.exec(f"git add -A && git commit -qm {shlex.quote(message)}")
        if r.code != 0:
            raise RuntimeError(f"commit failed: {r.output[-300:]}")
        self.sb.git.push(WORKDIR, username="x-access-token", password=self.token,
                         branch=self.branch, remote="origin", set_upstream=True)
