"""A project's own Anthropic API key (docs/settings.md): worker key selection, and that the key never reaches an
event, a scrubbed error or the worker's printed output."""
import json
import sys

import pytest

import worker
from engine import redact
from engine.agents.claude_cli import ClaudeCLIAgent
from engine.events import Emitter, ListSink
from engine.interfaces import ExecResult, Task
from tests.test_checkpoints import commit, create_checkpoint, repos, sh  # noqa: F401  (repos is a fixture)

OWN = "sk-ant-api03-" + "Q" * 80 + "abcd"          # shaped like a key; not a real one
STUDIO = "sk-ant-api03-" + "S" * 80 + "wxyz"


def test_project_key_is_read_only_when_it_looks_like_a_key():
    assert worker.project_anthropic_key({"anthropicKey": f"  {OWN} "}) == OWN
    for row in ({}, None, {"anthropicKey": None}, {"anthropicKey": 12}, {"anthropicKey": "sk-ant-short"},
                {"anthropicKey": "x" * 100}):
        assert worker.project_anthropic_key(row) is None


def test_the_projects_own_key_replaces_studios_for_the_whole_run():
    env = {"ANTHROPIC_API_KEY": STUDIO}
    assert worker.use_anthropic_key({"anthropicKey": OWN}, env) == "project"
    assert env["ANTHROPIC_API_KEY"] == OWN
    assert set(redact.registered()) == {OWN, STUDIO}          # both are scrubbed from now on


def test_without_its_own_key_a_project_runs_on_studios_key():
    env = {"ANTHROPIC_API_KEY": STUDIO}
    assert worker.use_anthropic_key({"name": "x"}, env) == "studio"
    assert env["ANTHROPIC_API_KEY"] == STUDIO
    assert worker.use_anthropic_key({"anthropicKey": OWN}, {}) == "project"   # no Studio key needed then


def test_no_usable_key_stops_the_run_without_printing_one():
    with pytest.raises(SystemExit, match="ANTHROPIC_API_KEY"):
        worker.use_anthropic_key({}, {})
    # set but undecryptable in Convex (e.g. STUDIO_KEY_SECRET changed): never fall back to Studio's key silently
    with pytest.raises(SystemExit) as e:
        worker.use_anthropic_key({"anthropicKeyProblem": "STUDIO_KEY_SECRET changed"}, {"ANTHROPIC_API_KEY": STUDIO})
    assert "STUDIO_KEY_SECRET" in str(e.value) and STUDIO not in str(e.value)


def test_a_ship_or_rollback_runs_no_agent_so_needs_no_key():
    assert worker.use_anthropic_key({"anthropicKeyProblem": "STUDIO_KEY_SECRET changed"}, {}, agents=False) == "none"
    env = {"ANTHROPIC_API_KEY": STUDIO}
    assert worker.use_anthropic_key({}, env, agents=False) == "studio"
    assert worker.use_anthropic_key({"anthropicKey": OWN}, env, agents=False) == "project" and env["ANTHROPIC_API_KEY"] == OWN


def test_a_run_refused_for_its_key_ends_failed_with_the_reason(monkeypatch, tmp_path):
    """Without it the project would wait in "starting" for good."""
    sent = []

    class FakeBackend:
        def __init__(self, project_id):
            pass

        def project(self):
            return {"status": "starting", "mode": None, "name": "x", "model": "haiku",
                    "anthropicKeyProblem": "the stored key can't be decrypted"}

        def write(self, e):
            sent.append((e.kind, e.data))

    monkeypatch.setattr(sys, "stdout", sys.stdout)
    monkeypatch.setattr(sys, "stderr", sys.stderr)
    monkeypatch.setattr(worker, "ConvexBackend", FakeBackend)
    monkeypatch.setattr(worker, "ROOT", tmp_path / "worker")
    for k in ("DAYTONA_API_KEY", "PROJECTS_GITHUB_TOKEN", "CONVEX_DEPLOY_KEY", "GITHUB_TOKEN"):
        monkeypatch.setenv(k, "test")
    monkeypatch.setenv("ANTHROPIC_API_KEY", STUDIO)
    monkeypatch.setattr(sys, "argv", ["worker.py", "--project-id", "p1"])
    with pytest.raises(SystemExit, match="can't be decrypted"):
        worker.main()
    assert sent == [("project_finished", {"status": "failed", "repo": None,
                                          "reason": "this project's own Anthropic API key can't be used: "
                                                    "the stored key can't be decrypted"})]
    assert STUDIO not in json.dumps(sent)


class Box:
    """Records the environment each command gets, like a sandbox would receive it."""
    workdir = "/repo"

    def __init__(self):
        self.envs = []

    def exec(self, cmd, timeout=600, env=None):
        self.envs.append(dict(env or {}))
        assert OWN not in cmd and STUDIO not in cmd                 # never on the command line
        return ExecResult(0, json.dumps({"type": "result", "subtype": "success", "result": "CLAIM: done",
                                         "total_cost_usd": 0.01, "num_turns": 1}))


def test_every_agent_of_the_run_passes_the_projects_key_to_its_sandbox(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", STUDIO)
    worker.use_anthropic_key({"anthropicKey": OWN})
    agents = [ClaudeCLIAgent(model="haiku"), *worker.tech_lead_agents(0.5), worker.reviewer_agent(0.5),
              worker.architect_agent(0.5), worker.designer_agent(0.5)]
    box = Box()
    task = Task("T1", "Slots", "spec", ["src/**"], "true")
    for a in agents:
        a.run(task, box, 1, None)
    assert [e["ANTHROPIC_API_KEY"] for e in box.envs] == [OWN] * len(agents)


def test_events_and_scrubbers_mask_the_registered_key():
    from engine.deploy import Vercel
    from engine.ship import scrub
    redact.register(OWN)
    sink = ListSink()
    Emitter(sink).emit("attempt_finished", "T1", claim=f"error ({OWN})", nested={"list": [f"x{OWN}y"], OWN: 1})
    assert OWN not in json.dumps(sink.events[0].data)
    assert sink.events[0].data["claim"] == "error (***)"
    assert OWN not in scrub(f"build said {OWN}")
    assert OWN not in Vercel("tok").scrub(f"Vercel echoed {OWN}")
    assert worker.hide(f"reason {OWN}") == "reason ***"


def test_printed_output_masks_the_registered_key(capsys, monkeypatch):
    monkeypatch.setattr(sys, "stdout", sys.stdout)            # restored after the test
    monkeypatch.setattr(sys, "stderr", sys.stderr)
    redact.redact_output()
    redact.register(OWN)
    print(f"oops {OWN}")
    print(f"also {OWN}", file=sys.stderr)
    out, err = capsys.readouterr()
    assert OWN not in out + err and "oops ***" in out and "also ***" in err


def test_worker_run_with_its_own_key_never_emits_or_prints_it(repos, tmp_path, monkeypatch, capsys):
    """worker.main (mode rollback, no network) for a project with its own key: the deploy fails with an error that
    quotes the key and logs it; neither the events nor stdout/stderr carry it, and the run used the project's key."""
    import engine.deploy
    from engine.deploy import DeployResult
    work, bare = repos
    create_checkpoint(work, "Build finished")
    commit(work, {"src/a.ts": "a2"}, "change 1")
    sh(["push", "-q", "origin", "main"], work)
    sent = []

    class FakeBackend:
        def __init__(self, project_id):
            pass

        def project(self):
            return {"status": "starting", "mode": "rollback", "rollback": {"n": 1}, "resume": False, "change": None,
                    "repo": str(bare), "merged": ["INT"], "name": "x", "model": "haiku", "anthropicKey": OWN}

        def write(self, e):
            sent.append(json.dumps({"kind": e.kind, "data": e.data}))

    def leaky_deploy(repo, project_name, log):
        log(f"deploying with {OWN}")
        return DeployResult("failed", "", f"Vercel rejected {OWN}")

    monkeypatch.setattr(sys, "stdout", sys.stdout)
    monkeypatch.setattr(sys, "stderr", sys.stderr)
    monkeypatch.setattr(worker, "upgrade_template", lambda repo, stack: [])
    monkeypatch.setattr(worker, "ConvexBackend", FakeBackend)
    monkeypatch.setattr(worker, "ROOT", tmp_path / "worker")
    monkeypatch.setattr(engine.deploy, "deploy_preview", leaky_deploy)
    for k in ("DAYTONA_API_KEY", "PROJECTS_GITHUB_TOKEN", "CONVEX_DEPLOY_KEY", "GITHUB_TOKEN"):
        monkeypatch.setenv(k, "test")
    monkeypatch.setenv("ANTHROPIC_API_KEY", STUDIO)
    monkeypatch.setattr(sys, "argv", ["worker.py", "--project-id", "p1"])
    worker.main()
    out, err = capsys.readouterr()
    assert any('"preview_failed"' in e for e in sent)
    for text in (*sent, out, err, (tmp_path / "worker").joinpath("results").as_posix()):
        assert OWN not in text and STUDIO not in text
    jsonl = next((tmp_path / "worker" / "results").glob("*/events.jsonl")).read_text()
    assert OWN not in jsonl and "Vercel rejected ***" in jsonl
    assert "the project's own key" in out and "deploying with ***" in out
    import os
    assert os.environ["ANTHROPIC_API_KEY"] == OWN                  # what every agent of the run would get
