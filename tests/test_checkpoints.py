"""Checkpoints and rollback (engine/checkpoints.py) with real git: a local clone and a bare repo as its remote."""
import subprocess
from pathlib import Path

import pytest

from engine.checkpoints import (CheckpointError, create_checkpoint, list_checkpoints, rollback, run_rollback,
                                save_checkpoint)
from engine.events import Emitter, ListSink


def sh(args, cwd):
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=True).stdout.strip()


def commit(repo: Path, files: dict, msg: str) -> str:
    for path, body in files.items():
        f = repo / path
        if body is None:
            f.unlink()
            sh(["rm", "-q", "--cached", path], repo)
            continue
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(body)
        sh(["add", path], repo)
    sh(["commit", "-qm", msg], repo)
    return sh(["rev-parse", "HEAD"], repo)


@pytest.fixture
def repos(tmp_path):
    """(clone, bare remote) with one commit on main, pushed."""
    bare, work = tmp_path / "remote.git", tmp_path / "work"
    sh(["init", "-q", "--bare", "-b", "main", str(bare)], tmp_path)
    sh(["init", "-q", "-b", "main", str(work)], tmp_path)
    for k, v in (("user.name", "t"), ("user.email", "t@t"), ("commit.gpgsign", "false"), ("tag.gpgsign", "false")):
        sh(["config", k, v], work)
    commit(work, {"plan.json": '{"tasks": ["T1"]}', "src/a.ts": "a1"}, "init")
    sh(["remote", "add", "origin", str(bare)], work)
    sh(["push", "-q", "-u", "origin", "main"], work)
    return work, bare


def tree(repo, ref="main"):
    return sh(["rev-parse", f"{ref}^{{tree}}"], repo)


def test_checkpoints_are_numbered_annotated_tags_pushed_to_the_remote(repos):
    work, bare = repos
    c1 = create_checkpoint(work, "Build finished")
    assert c1 == {"n": 1, "tag": "checkpoint-1", "sha": sh(["rev-parse", "main"], work), "label": "Build finished"}
    commit(work, {"src/a.ts": "a2"}, "change 1")
    c2 = create_checkpoint(work, "Change 1: keep\nthe   groomer")
    assert (c2["n"], c2["label"]) == (2, "Change 1: keep the groomer")         # one line, as it reads back
    assert sh(["cat-file", "-t", "checkpoint-2"], work) == "tag"                 # annotated, not lightweight
    listed = list_checkpoints(work)
    assert [(c["n"], c["sha"], c["label"]) for c in listed] == [(1, c1["sha"], "Build finished"),
                                                                 (2, c2["sha"], "Change 1: keep the groomer")]
    assert all(c["at"] > 0 for c in listed)
    assert [c["n"] for c in list_checkpoints(bare)] == [1, 2]                     # the remote has both tags


def test_numbering_continues_from_tags_a_fresh_clone_fetched(repos, tmp_path):
    work, bare = repos
    create_checkpoint(work, "Build finished")
    clone = tmp_path / "clone"
    sh(["clone", "-q", str(bare), str(clone)], tmp_path)
    sh(["config", "user.name", "t"], clone)
    sh(["config", "user.email", "t@t"], clone)
    assert create_checkpoint(clone, "Change 1: x")["n"] == 2


def test_a_tag_that_cannot_be_pushed_is_not_kept(repos, tmp_path):
    work, bare = repos
    sh(["remote", "set-url", "origin", str(tmp_path / "gone.git")], work)
    with pytest.raises(CheckpointError):
        create_checkpoint(work, "Build finished")
    assert list_checkpoints(work) == []


def test_rollback_restores_the_tree_with_one_new_commit_and_keeps_history(repos):
    work, bare = repos
    first = create_checkpoint(work, "Build finished")
    c1_tree = tree(work)
    commit(work, {"src/a.ts": "a2", "changes/1.json": "{}", "plan.json": '{"tasks": ["T1", "C1T1"]}'}, "change 1")
    commit(work, {"src/b.ts": "b"}, "change 1 more")
    create_checkpoint(work, "Change 1: more")
    commit(work, {"src/a.ts": None}, "a failed change deletes a file")
    sh(["push", "-q", "origin", "main"], work)
    before = sh(["rev-list", "main"], work).splitlines()

    r = rollback(work, 1)
    after = sh(["rev-list", "main"], work).splitlines()
    assert after[1:] == before and after[0] == r["sha"]                          # one commit on top, nothing rewritten
    assert sh(["rev-list", "--count", "--parents", "-1", "main"], work) == "1"
    assert tree(work) == c1_tree                                                 # tree equals the checkpoint's
    assert (work / "src/a.ts").read_text() == "a1"                              # files on disk follow
    assert not (work / "src/b.ts").exists() and not (work / "changes/1.json").exists()
    assert (work / "plan.json").read_text() == '{"tasks": ["T1"]}'               # plan rolls back with the tree
    assert sh(["log", "-1", "--format=%s", "main"], work) == "Roll back to checkpoint 1: Build finished"
    assert sh(["rev-parse", "main"], bare) == r["sha"]                           # pushed
    assert r["to"] == 1 and r["checkpoint"]["n"] == 3 and r["checkpoint"]["sha"] == r["sha"]
    assert [c["n"] for c in list_checkpoints(bare)] == [1, 2, 3]
    assert sh(["rev-parse", "checkpoint-1^{commit}"], work) == first["sha"]       # old tags untouched


def test_rolling_forward_again_is_just_another_rollback(repos):
    work, _ = repos
    create_checkpoint(work, "Build finished")
    commit(work, {"src/a.ts": "a2"}, "change 1")
    create_checkpoint(work, "Change 1")
    c2_tree = tree(work)
    rollback(work, 1)
    rollback(work, 2, "Change 1 again")
    assert tree(work) == c2_tree
    assert sh(["log", "-1", "--format=%s", "main"], work) == "Roll back to checkpoint 2: Change 1 again"


def test_rollback_to_a_missing_checkpoint_changes_nothing(repos):
    work, _ = repos
    head = sh(["rev-parse", "main"], work)
    with pytest.raises(CheckpointError, match="no checkpoint 4"):
        rollback(work, 4)
    assert sh(["rev-parse", "main"], work) == head


def test_rollback_that_cannot_be_pushed_leaves_the_clone_as_it_was(repos):
    work, bare = repos
    create_checkpoint(work, "Build finished")
    commit(work, {"src/a.ts": "a2"}, "change 1")
    sh(["push", "-q", "origin", "main"], work)
    # someone else moved main on the remote: a plain push is refused, and we never force
    other = commit(work, {"src/c.ts": "c"}, "elsewhere")
    sh(["push", "-q", "origin", "main"], work)
    sh(["reset", "-q", "--hard", "HEAD~1"], work)
    head = sh(["rev-parse", "main"], work)
    with pytest.raises(CheckpointError, match="push"):
        rollback(work, 1)
    assert sh(["rev-parse", "main"], work) == head and (work / "src/a.ts").read_text() == "a2"
    assert sh(["rev-parse", "main"], bare) == other


def test_worker_helpers_emit_the_events_the_app_reads(repos):
    work, _ = repos
    sink = ListSink()
    events = Emitter(sink)
    c = save_checkpoint(work, "Build finished", events, merged={"T1", "INT", "T1"})
    assert [(e.kind, e.data) for e in sink.events] == [("checkpoint_created", {**c, "merged": ["INT", "T1"]})]
    commit(work, {"src/a.ts": "a2"}, "change 1")
    sink.events.clear()
    assert run_rollback(work, 1, events, merged=["INT", "T1"]) == "done"
    kinds = [e.kind for e in sink.events]
    assert kinds == ["rollback_started", "rollback_done", "checkpoint_created"]
    done, made = sink.events[1].data, sink.events[2].data
    assert done == {"to": 1, "n": 2, "sha": made["sha"]} and made["merged"] == ["INT", "T1"]
    sink.events.clear()
    assert run_rollback(work, 9, events) == "failed"
    assert [e.kind for e in sink.events] == ["rollback_started", "rollback_failed"]


def test_save_checkpoint_never_raises(tmp_path):
    sink = ListSink()
    assert save_checkpoint(tmp_path, "Build finished", Emitter(sink)) is None and sink.events == []


def test_worker_checkpoint_labels():
    from worker import checkpoint_label
    assert checkpoint_label(None, False) == "Build finished"
    assert checkpoint_label(None, True) == "Retry finished"
    long = "Keep the groomer when the date changes, store times in the salon's time zone, please"
    assert checkpoint_label({"n": 2, "text": long}, False) == f"Change 2: {long[:60]}…"
    assert checkpoint_label({"n": 1, "text": "Short\nfix"}, False) == "Change 1: Short fix"


def test_worker_rollback_mode_end_to_end_without_network(repos, tmp_path, monkeypatch):
    """worker.main in mode rollback: clones the repo (a local bare one here), rolls back, saves a checkpoint,
    finishes and redeploys. Convex and Vercel are fakes; no agent or sandbox is created."""
    import sys

    import engine.deploy
    import worker
    from engine.deploy import DeployResult
    work, bare = repos
    create_checkpoint(work, "Build finished")
    c1_tree = tree(work)
    commit(work, {"src/a.ts": "a2"}, "change 1")
    sh(["push", "-q", "origin", "main"], work)
    sent = []

    class FakeBackend:
        def __init__(self, project_id):
            pass

        def project(self):
            return {"status": "starting", "mode": "rollback", "rollback": {"n": 1}, "resume": False,
                    "change": None, "repo": str(bare), "merged": ["INT", "T1"], "name": "x", "model": "haiku"}

        def write(self, e):
            sent.append((e.kind, e.data))

    deployed = []
    monkeypatch.setattr(worker, "ConvexBackend", FakeBackend)
    monkeypatch.setattr(worker, "ROOT", tmp_path / "worker")
    monkeypatch.setattr(engine.deploy, "deploy_preview",
                        lambda repo, project_name, log: deployed.append(project_name) or DeployResult("ready", "https://x.vercel.app", ""))
    # GITHUB_TOKEN too: the worker sets it, and monkeypatch restores only what it has seen
    for k in ("ANTHROPIC_API_KEY", "DAYTONA_API_KEY", "PROJECTS_GITHUB_TOKEN", "CONVEX_DEPLOY_KEY", "GITHUB_TOKEN"):
        monkeypatch.setenv(k, "test")
    monkeypatch.setattr(sys, "argv", ["worker.py", "--project-id", "p1"])
    worker.main()
    kinds = [k for k, _ in sent]
    assert kinds == ["rollback_started", "rollback_done", "checkpoint_created", "project_finished", "preview_ready"]
    assert sent[3][1] == {"status": "done", "repo": str(bare)}
    assert sent[2][1]["n"] == 2 and sent[2][1]["merged"] == ["INT", "T1"]
    assert tree(bare) == c1_tree and deployed == ["remote.git"]
