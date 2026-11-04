"""Local stand-in sandbox: a git worktree on its own branch. Same interface as the cloud one."""
from __future__ import annotations

import os
import shutil
import subprocess
import time
from pathlib import Path

from engine.gitlock import repo_lock
from engine.interfaces import ExecResult


class LocalWorktreeSandbox:
    def __init__(self, repo: Path, task_id: str, attempt: int):
        self.repo = Path(repo)
        self.branch = f"task/{task_id}-a{attempt}"
        self.path = self.repo.parent / "sandboxes" / f"{task_id}-a{attempt}"
        self.workdir = str(self.path)

    def __enter__(self):
        self.path.parent.mkdir(exist_ok=True)
        # Every change to the shared repo's worktree list and branches goes through repo_lock: parallel
        # `worktree add`/`remove` race on .git/worktrees/ itself (see engine/gitlock.py).
        with repo_lock(self.repo):
            # A branch left by an earlier build of this repo (a retry reuses task ids): its work is already on
            # main or was rejected, so start clean.
            self._remove()
            subprocess.run(["git", "branch", "-D", self.branch], cwd=self.repo, capture_output=True)
            for i in range(6):      # another process (an editor, a cleanup script) may hold a git .lock briefly
                r = subprocess.run(["git", "worktree", "add", "-q", "-b", self.branch, str(self.path), "main"],
                                   cwd=self.repo, capture_output=True, text=True)
                if r.returncode == 0 or ".lock" not in r.stderr:
                    break
                self._remove()
                subprocess.run(["git", "branch", "-D", self.branch], cwd=self.repo, capture_output=True)
                time.sleep(0.3 * (i + 1))
            if r.returncode:
                raise RuntimeError(r.stderr)
        modules = self.repo / "node_modules"
        if modules.exists():                     # web projects: share installed packages, never commit them
            (self.path / "node_modules").symlink_to(modules.resolve())
        return self

    def _remove(self) -> None:
        """Remove this sandbox's worktree, even if git has lost track of it (a half-made worktree)."""
        subprocess.run(["git", "worktree", "remove", "--force", str(self.path)], cwd=self.repo, capture_output=True)
        if self.path.exists():
            shutil.rmtree(self.path, ignore_errors=True)
            subprocess.run(["git", "worktree", "prune"], cwd=self.repo, capture_output=True)

    def __exit__(self, *exc):
        with repo_lock(self.repo):
            self._remove()

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
        # The commit moves a branch of the shared repo, so it takes the same lock as worktree changes.
        # A failed commit must not pass silently: merging the unchanged branch would report "merged"
        # with none of the work on main.
        with repo_lock(self.repo):
            # (an agent that committed its own work leaves nothing to commit, which is fine)
            r = self.exec(f"git add -A && (git diff --cached --quiet || git commit -qm {message!r})")
        if r.code != 0:
            raise RuntimeError(f"commit failed: {r.output[-300:]}")
        # branch already lives in the shared repo; a cloud sandbox would `git push` here
