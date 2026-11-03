"""Local stand-in sandbox: a git worktree on its own branch. Same interface as the cloud one."""
from __future__ import annotations

import os
import subprocess
from pathlib import Path

from engine.interfaces import ExecResult


class LocalWorktreeSandbox:
    def __init__(self, repo: Path, task_id: str, attempt: int):
        self.repo = Path(repo)
        self.branch = f"task/{task_id}-a{attempt}"
        self.path = self.repo.parent / "sandboxes" / f"{task_id}-a{attempt}"
        self.workdir = str(self.path)

    def __enter__(self):
        self.path.parent.mkdir(exist_ok=True)
        r = subprocess.run(["git", "worktree", "add", "-q", "-b", self.branch, str(self.path), "main"],
                           cwd=self.repo, capture_output=True, text=True)
        if r.returncode:
            raise RuntimeError(r.stderr)
        modules = self.repo / "node_modules"
        if modules.exists():                     # web projects: share installed packages, never commit them
            (self.path / "node_modules").symlink_to(modules.resolve())
        return self

    def __exit__(self, *exc):
        subprocess.run(["git", "worktree", "remove", "--force", str(self.path)], cwd=self.repo, capture_output=True)

    def exec(self, cmd: str, timeout: int = 600, env: dict[str, str] | None = None) -> ExecResult:
        try:
            r = subprocess.run(["bash", "-c", cmd], cwd=self.path, capture_output=True, text=True, timeout=timeout,
                               env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1", **(env or {})})
            return ExecResult(r.returncode, r.stdout + r.stderr)
        except subprocess.TimeoutExpired:
            return ExecResult(124, f"timed out after {timeout}s")

    def write_file(self, path: str, content: str) -> None:
        p = self.path / path
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)

    def publish(self, message: str) -> None:
        self.exec(f"git add -A && git commit -qm {message!r}")
        # branch already lives in the shared repo; a cloud sandbox would `git push` here
