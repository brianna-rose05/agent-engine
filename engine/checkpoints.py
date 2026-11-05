"""Checkpoints: every finished build or change is a named save point the owner can roll back to
(docs/checkpoints.md).

A checkpoint is an annotated git tag `checkpoint-<n>` on main whose message is its label, so it lives in the
project's own repo (pushed with it) and survives the worker's throwaway clone. A rollback never rewrites
history: it adds ONE commit on top of main whose tree equals the checkpoint's tree, so everything rolled
away is still in the log and can be rolled forward again the same way.
"""
from __future__ import annotations

import re
from pathlib import Path

from engine.engine import git
from engine.gitlock import repo_lock

TAG_PREFIX = "checkpoint-"
LABEL_MAX = 200


class CheckpointError(RuntimeError):
    pass


def _label(text: str, n: int) -> str:
    """One line (the tag message's subject is what list_checkpoints reads back), never empty."""
    one = re.sub(r"\s+", " ", text or "").strip()[:LABEL_MAX]
    return one or f"Checkpoint {n}"


def _has_remote(repo: Path) -> bool:
    return bool(git(["remote"], repo).stdout.strip())


def list_checkpoints(repo: Path) -> list[dict]:
    """Oldest first: {n, tag, sha (the commit), label, at (unix seconds)}."""
    out = git(["for-each-ref", f"refs/tags/{TAG_PREFIX}*",
               "--format=%(refname:short)%09%(*objectname)%09%(objectname)%09%(creatordate:unix)%09%(contents:subject)"],
              Path(repo)).stdout
    found = []
    for line in out.splitlines():
        tag, peeled, obj, at, label = (line.split("\t", 4) + [""] * 5)[:5]
        m = re.fullmatch(rf"{TAG_PREFIX}(\d+)", tag)
        if not m:
            continue
        found.append({"n": int(m.group(1)), "tag": tag, "sha": peeled or obj, "label": label,
                      "at": int(at) if at.isdigit() else 0})
    return sorted(found, key=lambda c: c["n"])


def create_checkpoint(repo: Path, label: str) -> dict:
    """Tag main as the next checkpoint and push the tag. If the push fails the local tag is removed again, so
    a checkpoint the app hears about always exists in the project's repo."""
    repo = Path(repo)
    with repo_lock(repo):
        n = max((c["n"] for c in list_checkpoints(repo)), default=0) + 1
        tag, text = f"{TAG_PREFIX}{n}", _label(label, n)
        sha = git(["rev-parse", "--verify", "main^{commit}"], repo).stdout.strip()
        if not sha:
            raise CheckpointError("the repo has no main branch to save")
        r = git(["tag", "-a", tag, "-m", text, sha], repo)
        if r.returncode:
            raise CheckpointError(f"couldn't tag {tag}: {r.stderr.strip()[:200]}")
        if _has_remote(repo):
            r = git(["push", "-q", "origin", f"refs/tags/{tag}"], repo)
            if r.returncode:
                git(["tag", "-d", tag], repo)
                raise CheckpointError(f"couldn't push {tag}: {r.stderr.strip()[:200]}")
        return {"n": n, "tag": tag, "sha": sha, "label": text}


def rollback(repo: Path, n: int, label: str | None = None) -> dict:
    """Make main's tree equal to checkpoint n's with one new commit, push it (never forced), and save the
    result as a new checkpoint. `label` names the target in the commit message (default: its own label).
    Returns {to, sha, label, checkpoint}; checkpoint is None if only the tagging failed (the rollback stands)."""
    repo = Path(repo)
    with repo_lock(repo):
        target = next((c for c in list_checkpoints(repo) if c["n"] == n), None)
        if target is None:
            raise CheckpointError(f"there is no checkpoint {n}")
        old = git(["rev-parse", "--verify", "main^{commit}"], repo).stdout.strip()
        tree = git(["rev-parse", f"{target['tag']}^{{tree}}"], repo).stdout.strip()
        message = f"Roll back to checkpoint {n}: {_label(label if label is not None else target['label'], n)}"
        new = git(["commit-tree", tree, "-p", old, "-m", message], repo)
        if new.returncode or not old or not tree:
            raise CheckpointError(f"couldn't make the rollback commit: {new.stderr.strip()[:200]}")
        sha = new.stdout.strip()
        on_main = git(["symbolic-ref", "-q", "--short", "HEAD"], repo).stdout.strip() == "main"
        # a fast-forward to a child of main: the checked-out files follow, nothing is rewritten
        moved = (git(["merge", "--ff-only", "-q", sha], repo) if on_main
                 else git(["update-ref", "refs/heads/main", sha, old], repo))
        if moved.returncode:
            raise CheckpointError(f"couldn't move main: {moved.stderr.strip()[:200]}")
        if _has_remote(repo):
            pushed = git(["push", "-q", "origin", "main"], repo)
            if pushed.returncode:
                # only this clone moved: put it back, so the clone and the remote agree on what main is
                git(["reset", "-q", "--keep", old] if on_main else ["update-ref", "refs/heads/main", old, sha], repo)
                raise CheckpointError(f"couldn't push the rollback: {pushed.stderr.strip()[:200]}")
        try:
            saved = create_checkpoint(repo, message)
        except CheckpointError:
            saved = None
        return {"to": n, "sha": sha, "label": message, "checkpoint": saved}


def save_checkpoint(repo: Path, label: str, events, merged=()) -> dict | None:
    """Worker helper: checkpoint main and emit checkpoint_created {n, tag, sha, label, merged}. Never raises:
    a missing save point must not turn a finished build into a failed one."""
    try:
        c = create_checkpoint(repo, label)
    except Exception as e:
        print(f"checkpoint: not saved ({type(e).__name__}: {e})"[:300])
        return None
    events.emit("checkpoint_created", **c, merged=sorted(set(merged)))
    return c


def run_rollback(repo: Path, n: int, events, merged=()) -> str:
    """The worker's rollback mode. `merged` is what was merged at checkpoint n (from Convex), carried onto the
    new checkpoint so later retries keep the right tasks. Returns the run's status: done or failed."""
    events.emit("rollback_started", n=n)
    try:
        r = rollback(repo, n)
    except Exception as e:
        events.emit("rollback_failed", n=n, reason=f"{e}"[:300])
        return "failed"
    c = r["checkpoint"]
    events.emit("rollback_done", to=n, n=c["n"] if c else None, sha=r["sha"])
    if c:
        events.emit("checkpoint_created", **c, merged=sorted(set(merged)))
    return "done"
