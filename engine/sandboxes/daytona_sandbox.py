"""Cloud sandbox on Daytona. Needs DAYTONA_API_KEY, plus a GitHub token that can push task branches.

Lifecycle per attempt: create -> clone repo -> new task branch -> (agent works) -> push branch -> delete.
The sandbox is always deleted, even if the attempt crashes, so nothing keeps billing.
"""
from __future__ import annotations

import os
import shlex

from engine.interfaces import ExecResult

WORKDIR = "repo"
# Installs what the agent and the checks need inside the sandbox: the Claude Code CLI and pytest.
SETUP = ("(command -v claude >/dev/null || npm install -g @anthropic-ai/claude-code >/dev/null 2>&1) && "
         "(python3 -m pytest --version >/dev/null 2>&1 || python3 -m pip install -q pytest >/dev/null 2>&1 "
         "|| python3 -m pip install -q --break-system-packages pytest >/dev/null 2>&1) && "
         "python3 -m pytest --version >/dev/null 2>&1")


# Web projects: a Node image with room for npm packages, TypeScript and an in-test Postgres.
WEB_SETUP = ("(command -v claude >/dev/null || npm install -g @anthropic-ai/claude-code >/dev/null 2>&1) && "
             "npm ci --no-audit --no-fund --loglevel=error")


def web_params():
    from daytona import CreateSandboxFromImageParams, Resources
    return CreateSandboxFromImageParams(image="node:22-bookworm", resources=Resources(cpu=2, memory=4, disk=10),
                                        auto_stop_interval=0)


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
        if self.create_params is None:
            self.sb = self._client.create()
        else:                                   # a custom image is built once, then cached by Daytona
            self.sb = self._client.create(self.create_params, timeout=900)
        try:
            self.sb.set_autostop_interval(0)    # default stops after 15 idle minutes, mid-task
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

    def __exit__(self, *exc):
        if self.sb is not None:
            try:
                self.sb.delete()
            finally:
                self.sb = None

    def exec(self, cmd: str, timeout: int = 600, env: dict[str, str] | None = None) -> ExecResult:
        r = self.sb.process.exec(cmd, cwd=WORKDIR, env=env, timeout=timeout)   # Daytona's default timeout is only 10s
        return ExecResult(r.exit_code, r.result or "")

    def write_file(self, path: str, content: str) -> None:
        self.sb.fs.upload_file(content.encode(), f"{WORKDIR}/{path}")

    def publish(self, message: str) -> None:
        r = self.exec(f"git add -A && git commit -qm {shlex.quote(message)}")
        if r.code != 0:
            raise RuntimeError(f"commit failed: {r.output[-300:]}")
        self.sb.git.push(WORKDIR, username="x-access-token", password=self.token,
                         branch=self.branch, remote="origin", set_upstream=True)
