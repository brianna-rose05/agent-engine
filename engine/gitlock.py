"""One git operation at a time on a shared repo's metadata (branches, worktrees, main).

Git has no lock around its worktree bookkeeping: `git worktree remove` deletes `.git/worktrees/` when it
looks empty, while a parallel `git worktree add` is creating its entry there, and either command can trip
over another worktree that is half created or half removed ("could not create directory of
'.git/worktrees/T1-a1'", "failed to read .git/worktrees/T2-a1/gitdir"). None of those mention a `.lock`
file, so retrying on `.lock` never caught them. Regression: two project tests flaked in CI (2-core
runner) with a task ending in "error" this way; four parallel add/remove loops on one repo reproduce it.

The lock is a file lock on the repo's git dir, so it covers threads (each call opens its own file
description) and separate processes (an engine and a cleanup script) alike.
"""
from __future__ import annotations

import subprocess
import threading
from contextlib import contextmanager
from pathlib import Path

try:
    import fcntl
except ImportError:                       # Windows: threads in this process are still serialized
    fcntl = None

_thread_locks: dict[str, threading.RLock] = {}
_guard = threading.Lock()
_held = threading.local()


def _git_dir(repo: Path) -> Path:
    r = subprocess.run(["git", "rev-parse", "--git-common-dir"], cwd=repo, capture_output=True, text=True)
    d = Path(r.stdout.strip()) if r.returncode == 0 and r.stdout.strip() else Path(".git")
    return (Path(repo) / d).resolve()


@contextmanager
def repo_lock(repo: Path):
    """Hold this around any git command that changes the shared repo's refs or worktree list.
    Re-entrant within a thread, so a locked helper can call another."""
    key = str(Path(repo).resolve())
    with _guard:
        tlock = _thread_locks.setdefault(key, threading.RLock())
    with tlock:
        depth = getattr(_held, key, 0)
        setattr(_held, key, depth + 1)
        f = None
        try:
            if depth == 0 and fcntl is not None:
                f = open(_git_dir(Path(repo)) / "engine-ops.lock", "a")
                fcntl.flock(f, fcntl.LOCK_EX)
            yield
        finally:
            if f is not None:
                fcntl.flock(f, fcntl.LOCK_UN)
                f.close()
            setattr(_held, key, depth)
