"""The app's Convex backend wiring, with a fake transport (no network)."""
from engine.convex_sink import ConvexBackend, deployment_url, engine_secret
from engine.events import Event


def backend():
    calls = []

    def call(kind, path, args):
        calls.append((kind, path, args))
        return {"status": "approved", "planNote": "ok"} if kind == "query" else None

    return ConvexBackend("p123", deploy_key="prod:posh-peccary-112|abc", call=call), calls


def test_deploy_key_gives_url_and_a_stable_secret():
    assert deployment_url("prod:posh-peccary-112|eyJ") == "https://posh-peccary-112.convex.cloud"
    s = engine_secret("prod:x|y")
    assert s == engine_secret("prod:x|y") and s != engine_secret("prod:x|z") and "prod" not in s


def test_events_become_record_mutations_with_the_secret():
    b, calls = backend()
    b.write(Event("attempt_finished", "T1", {"n": 1, "cost_usd": 0.01, "files_changed": ["a.ts"]}, ts=123.5))
    kind, path, args = calls[0]
    assert (kind, path) == ("mutation", "engine:record")
    assert args["projectId"] == "p123" and args["taskId"] == "T1" and args["ts"] == 123.5
    assert args["secret"] == engine_secret("prod:posh-peccary-112|abc")


def test_worker_reads_its_project_and_waits_for_the_owner():
    from worker import repo_name, wait_for_decision
    b, calls = backend()
    assert b.project()["status"] == "approved" and calls[0][1] == "engine:projectForWorker"
    rows = iter([{"status": "awaiting_approval"}, {"status": "approved", "planNote": "go"}])
    naps = []
    assert wait_for_decision(lambda: next(rows), sleep=naps.append)({}) == (True, "go") and naps == [5]
    gave_up = wait_for_decision(lambda: {"status": "awaiting_approval"}, poll_s=60, timeout_s=120, sleep=lambda s: None)
    assert gave_up({})[0] is False
    assert repo_name("Dog Grooming Site!", "jd7abc123xyz") == "studio-dog-grooming-site-123xyz"
