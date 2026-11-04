"""Cloud sandbox on Daytona. Needs DAYTONA_API_KEY, plus a GitHub token that can push task branches.

Lifecycle per attempt: create -> clone repo -> new task branch -> (agent works) -> push branch -> delete.
The sandbox is always deleted, even if the attempt crashes, so nothing keeps billing.
"""
from __future__ import annotations

import os
import re
import shlex
import time
import uuid

from engine.interfaces import ExecResult, SandboxLost, SandboxUnavailable

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


# Every sandbox is labeled as the engine's and cleans itself up if the engine dies mid-task (a cancelled
# job can't run its `finally`): it stops after 60 idle minutes (an attempt is capped well below that)
# and is deleted as soon as it stops. scripts/daytona_cleanup.py deletes by the same label.
LABELS = {"app": "agent-engine"}
IDLE_STOP_MINUTES = 60


# Daytona error classes that mean "the sandbox or the connection to it is gone", not "your command failed".
# Exact class names: subclasses such as DaytonaFileNotFoundError or DaytonaProcessExecutionTimeoutError are
# about our request, and retrying would only repeat them.
LOST_ERRORS = {"DaytonaConnectionError", "DaytonaConnectionTimeoutError", "DaytonaTimeoutError",
               "DaytonaBadGatewayError", "DaytonaServiceUnavailableError", "DaytonaInternalServerError",
               "DaytonaRateLimitError", "DaytonaSpotEvictedError", "DaytonaGoneError", "DaytonaNotFoundError",
               "DaytonaGitTransportFailedError"}
# Transport errors from the HTTP stack underneath (requests, urllib3, httpx, aiohttp), matched by name so
# none of them has to be imported.
TRANSPORT_ERRORS = ("ConnectionError", "RemoteDisconnected", "ProtocolError", "ReadTimeout", "ConnectTimeout",
                    "TimeoutException", "NetworkError", "ServerDisconnectedError", "ClientOSError")
# A plain DaytonaError carries the transport failure only in its message. Regression: "DaytonaError: Remote
# end closed connection without response" mid-attempt ended a task as "error".
LOST_MESSAGE = re.compile(r"remote end closed connection|connection (aborted|reset|refused|closed)|"
                          r"max retries exceeded|read timed out|timed out|bad gateway|service unavailable|"
                          r"sandbox .*(not found|is not running|not started|stopped|destroyed)", re.I)


def is_lost(e: BaseException) -> bool:
    """True if `e` means the sandbox can't be reached any more (connection dropped, timed out, sandbox gone),
    so a fresh sandbox is worth trying. Errors in our own request (bad path, failed command) are False."""
    if isinstance(e, SandboxLost):
        return True
    names = [c.__name__ for c in type(e).__mro__]
    if type(e).__name__ in LOST_ERRORS:
        return True
    if type(e).__name__ == "DaytonaError":
        return bool(LOST_MESSAGE.search(str(e)))
    if any(n.startswith("Daytona") for n in names):
        return False                                    # a specific Daytona error about our request
    return isinstance(e, (ConnectionError, TimeoutError)) or any(n in TRANSPORT_ERRORS for n in names)


def lost_wrapped(fn):
    """Re-raise connection-level failures of a sandbox call as SandboxLost, so the engine can tell a dead
    sandbox (redo the attempt in a fresh one) from a real error (stop)."""
    def call(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except SandboxUnavailable:
            raise
        except Exception as e:
            if is_lost(e):
                raise SandboxLost(f"{type(e).__name__}: {e}") from e
            raise
    call.__name__, call.__doc__ = fn.__name__, fn.__doc__
    return call


# Seconds between delete tries while Daytona says the sandbox is changing state (starting, stopping).
DELETE_RETRIES = (2, 5, 10, 20)


def delete_with_retry(delete, sleep=time.sleep) -> None:
    """Call `delete()`, retrying while the sandbox is mid state change. Regression: worker logs showed
    "DaytonaConflictError: Failed to remove sandbox: Sandbox state change in progress", and the sandbox
    lived on until its idle timer. A sandbox that is already gone counts as deleted."""
    for wait_s in (*DELETE_RETRIES, None):
        try:
            delete()
            return
        except Exception as e:
            name = type(e).__name__
            if name in ("DaytonaNotFoundError", "DaytonaGoneError"):
                return                                   # ephemeral sandboxes delete themselves when they stop
            changing = name == "DaytonaConflictError" or "state change in progress" in str(e).lower()
            if wait_s is None or not changing:
                raise
            sleep(wait_s)


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
        self.sleep = time.sleep

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
                    delete_with_retry(lambda: self._client.delete(box, timeout=120), self.sleep)
        except Exception:
            pass                                 # best effort; the end-of-job cleanup catches the rest

    def __exit__(self, *exc):
        if self.sb is not None:
            try:
                delete_with_retry(self.sb.delete, self.sleep)
            finally:
                self.sb = None

    @lost_wrapped
    def exec(self, cmd: str, timeout: int = 600, env: dict[str, str] | None = None) -> ExecResult:
        t0 = time.monotonic()
        try:
            r = self.sb.process.exec(cmd, cwd=WORKDIR, env=env, timeout=timeout)   # Daytona's default is only 10s
        except Exception as e:
            # The command outran its own timeout: that's the command's result (as in the local sandbox),
            # not a lost sandbox, so it must not trigger a fresh sandbox and a redo.
            if is_lost(e) and time.monotonic() - t0 >= timeout:
                return ExecResult(124, f"timed out after {timeout}s")
            raise
        return ExecResult(r.exit_code, r.result or "")

    def exec_long(self, cmd: str, timeout: int, env: dict[str, str] | None = None, poll_s: float = 15,
                  sleep=time.sleep) -> ExecResult:
        """Run a long command (an agent) in the background and poll for it. Holding one HTTP request open
        for many minutes is fragile: the Pawfect planner lost its connection after 18 minutes and the
        whole project errored. A dropped poll is just retried."""
        tag = uuid.uuid4().hex[:10]
        out, code = f"/tmp/run-{tag}.out", f"/tmp/run-{tag}.code"
        script = f"{cmd} > {out} 2>&1; echo $? > {code}"
        self.exec(f"nohup bash -c {shlex.quote(script)} > /dev/null 2>&1 &", timeout=60, env=env)
        deadline, misses = time.monotonic() + timeout, 0
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
                return ExecResult(int(r.output.strip().splitlines()[-1]), self.exec(f"cat {out}", timeout=120).output)
        return ExecResult(124, f"timed out after {timeout}s")

    @lost_wrapped
    def write_file(self, path: str, content: str) -> None:
        self.sb.fs.upload_file(content.encode(), f"{WORKDIR}/{path}")

    @lost_wrapped
    def publish(self, message: str) -> None:
        r = self.exec(f"git add -A && git commit -qm {shlex.quote(message)}")
        if r.code != 0:
            raise RuntimeError(f"commit failed: {r.output[-300:]}")
        self.sb.git.push(WORKDIR, username="x-access-token", password=self.token,
                         branch=self.branch, remote="origin", set_upstream=True)
