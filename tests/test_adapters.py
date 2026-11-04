"""Verifies the real adapters' wiring with fakes, so they're checked before any keys exist."""
import asyncio
import json
from types import SimpleNamespace

import pytest

from engine.agents.claude_cli import ClaudeCLIAgent, activity_notes, parse_cli_json, stream_notes
from engine.agents.claude_sdk import TOOLS, ClaudeSDKAgent
from engine.agents.prompt import parse_claim
from engine.interfaces import ExecResult, SandboxUnavailable, Task
from engine.sandboxes.daytona_sandbox import DaytonaSandbox

TASK = Task("B6", "Deposit", "Implement deposit_cents.", ["payments.py", "tests/agent_test_payments*.py"],
            "pytest -q tests/test_payments.py")


# ---------------------------------------------------------------- claims
@pytest.mark.parametrize("text,err,claim", [
    ("All tests pass.\nDONE", False, "done"),
    ("Can't install deps.\nBLOCKED: no network", False, "blocked: no network"),
    ("I think it works", False, "done (unclear)"),
    ("DONE", True, "error: agent run did not finish"),
    (None, False, "error: agent run did not finish"),
])
def test_parse_claim(text, err, claim):
    assert parse_claim(text, err) == claim


# ---------------------------------------------------------------- SDK agent
def test_sdk_agent_options_are_locked_down():
    opts = ClaudeSDKAgent(model="haiku", budget_usd=0.5).options(TASK, SimpleNamespace(workdir="/w"))
    assert opts.cwd == "/w" and opts.model == "haiku" and opts.max_budget_usd == 0.5
    assert opts.tools == TOOLS and opts.allowed_tools == TOOLS
    assert opts.permission_mode == "dontAsk"              # never bypassPermissions
    assert "payments.py" in opts.system_prompt["append"]


def test_sdk_agent_reports_cost_and_claim(monkeypatch):
    import claude_agent_sdk

    def fake_result(**kw):
        base = dict(subtype="success", duration_ms=1, duration_api_ms=1, is_error=False, num_turns=7,
                    session_id="s", total_cost_usd=0.42, result="Implemented.\nDONE")
        base.update(kw)
        msg = object.__new__(claude_agent_sdk.ResultMessage)
        msg.__dict__.update(base)
        return msg

    async def fake_query(prompt, options):
        assert "B6" in prompt
        yield fake_result()

    monkeypatch.setattr(claude_agent_sdk, "query", fake_query)
    rep = ClaudeSDKAgent().run(TASK, SimpleNamespace(workdir="/w"), attempt=1, feedback=None)
    assert (rep.claim, rep.cost_usd, rep.turns) == ("done", 0.42, 7)

    async def over_budget(prompt, options):
        yield fake_result(subtype="error_max_budget_usd", result=None, is_error=True)

    monkeypatch.setattr(claude_agent_sdk, "query", over_budget)
    assert ClaudeSDKAgent().run(TASK, SimpleNamespace(workdir="/w"), 1, None).claim == "error: hit the per-task budget cap"


# ---------------------------------------------------------------- CLI agent
class FakeBox:
    def __init__(self, output, code=0):
        self.output, self.code, self.calls = output, code, []

    def exec(self, cmd, timeout=600, env=None):
        self.calls.append((cmd, env))
        return ExecResult(self.code, self.output)


def test_cli_agent_command_and_secret_handling():
    box = FakeBox("some log line\n" + json.dumps(
        {"type": "result", "subtype": "success", "is_error": False, "result": "Done it.\nDONE",
         "total_cost_usd": 0.31, "num_turns": 5}))
    rep = ClaudeCLIAgent(api_key="sk-test-123", budget_usd=0.75).run(TASK, box, 1, feedback="tests failed")
    cmd, env = box.calls[0]
    assert (rep.claim, rep.cost_usd, rep.turns) == ("done", 0.31, 5)
    assert "sk-test-123" not in cmd and env == {"ANTHROPIC_API_KEY": "sk-test-123", "CI": "1"}
    for flag in ("--bare", "--output-format stream-json --verbose", "--permission-mode dontAsk",
                 "--max-budget-usd 0.75"):
        assert flag in cmd
    assert "bypassPermissions" not in cmd and "tests failed" in cmd


def test_cli_agent_auth_failure_from_real_cli_output():
    """Captured from the real `claude` binary run without a key: note subtype says
    'success' while is_error is true. Must be treated as a failure, not 'done'."""
    real = ('{"total_cost_usd":0,"is_error":true,"num_turns":1,"subtype":"success",'
            '"result":"Authentication error · This may be a temporary network issue, please try again",'
            '"type":"result","terminal_reason":"api_error"}')
    rep = ClaudeCLIAgent(api_key="bad").run(TASK, FakeBox(real, code=1), 1, None)
    # a failure, with the CLI's reason kept so it can be diagnosed from the board
    assert rep.claim == ("error: agent run did not finish (Authentication error · This may be a temporary "
                         "network issue, please try again)")


def test_cli_agent_hang_is_stopped_in_the_sandbox_and_reported():
    """Regression (Pawfect rebuild): the planner hung, Daytona's connection timed out after 30 min and the
    whole project errored. The CLI now runs under `timeout`, so a hang is an ordinary, retryable failure."""
    agent = ClaudeCLIAgent(api_key="k", timeout_s=30 * 60)
    box = FakeBox("partial log, no json", code=124)
    rep = agent.run(TASK, box, 1, None)
    assert box.calls[0][0].startswith("timeout -k 20 1740 claude ")
    assert rep.claim == "error: agent ran out of time (29 min) and was stopped"


def test_cli_agent_without_key_or_with_garbage_output():
    assert ClaudeCLIAgent(api_key="").run(TASK, FakeBox("{}"), 1, None).claim.startswith("error: ANTHROPIC")
    assert ClaudeCLIAgent(api_key="k").run(TASK, FakeBox("crash", code=1), 1, None).claim.startswith("error: could not read")
    assert parse_cli_json('{"a": 1}') == {"a": 1}


# ---------------------------------------------------------------- Daytona sandbox
class FakeDaytonaSandbox:
    def __init__(self, fail_on=None):
        self.log, self.deleted, self.fail_on = [], False, fail_on
        self.git = SimpleNamespace(clone=lambda *a, **k: self.log.append(("clone", a, k)),
                                   push=lambda *a, **k: self.log.append(("push", a, k)))
        self.fs = SimpleNamespace(upload_file=lambda data, dst: self.log.append(("upload", dst, data)))
        self.process = SimpleNamespace(exec=self._exec)

    def _exec(self, cmd, cwd=None, env=None, timeout=None):
        self.log.append(("exec", cmd, cwd, timeout))
        code = 1 if self.fail_on and self.fail_on in cmd else 0
        return SimpleNamespace(exit_code=code, result="")

    def set_autostop_interval(self, n):
        self.log.append(("autostop", n))

    def delete(self):
        self.deleted = True


class FakeClient:
    def __init__(self, sb):
        self.sb = sb

    def create(self, params=None, timeout=60):
        self.params = params
        return self.sb


def test_daytona_lifecycle():
    fake = FakeDaytonaSandbox()
    client = FakeClient(fake)
    with DaytonaSandbox("https://github.com/b/repo", "B6", 2, github_token="ghp_x", client=client) as box:
        assert box.branch == "task/B6-a2"
        box.write_file("payments.py", "x = 1\n")
        assert box.exec("pytest").code == 0
        box.publish("B6: Deposit")
    kinds = [e[0] for e in fake.log]
    # Regression (cancelled web run): sandboxes outlived the engine with auto-stop off. Now every one is
    # labeled for cleanup, stops after 60 idle minutes and deletes itself when it stops.
    assert client.params.labels == {"app": "agent-engine"}
    assert client.params.auto_stop_interval == 60 and client.params.ephemeral
    assert kinds.index("clone") < kinds.index("push")
    clone = next(e for e in fake.log if e[0] == "clone")
    assert clone[2]["password"] == "ghp_x"
    assert any(e[0] == "exec" and "checkout -q -b task/B6-a2" in e[1] for e in fake.log)
    assert all(e[3] for e in fake.log if e[0] == "exec")                # never the 10s default timeout
    push = next(e for e in fake.log if e[0] == "push")
    assert push[2]["branch"] == "task/B6-a2"
    assert fake.deleted                                                 # nothing left billing


def test_daytona_long_commands_run_in_background_and_survive_dropped_polls():
    """Regression (Pawfect build 4): Daytona dropped the 18-minute planner request and the project errored."""
    fake = FakeDaytonaSandbox()
    polls = {"n": 0}

    def exec_(cmd, cwd=None, env=None, timeout=None):
        fake.log.append(("exec", cmd, cwd, timeout, env))
        if cmd.startswith("cat /tmp/run-") and cmd.endswith(".code 2>/dev/null"):
            polls["n"] += 1
            if polls["n"] == 1:
                raise ConnectionError("Remote end closed connection without response")
            return SimpleNamespace(exit_code=0, result="" if polls["n"] < 3 else "0\n")
        if cmd.startswith("tail -n 100 /tmp/run-"):      # only the end: a streamed log can be megabytes
            return SimpleNamespace(exit_code=0, result='{"result": "DONE"}')
        return SimpleNamespace(exit_code=0, result="")

    fake.process = SimpleNamespace(exec=exec_)
    box = DaytonaSandbox("u", "T1", 1, github_token="t", client=FakeClient(fake))
    box.__enter__()
    r = box.exec_long("claude -p hi", timeout=600, env={"ANTHROPIC_API_KEY": "k"}, poll_s=0, sleep=lambda s: None)
    assert (r.code, r.output) == (0, '{"result": "DONE"}') and polls["n"] == 3
    start = next(e for e in fake.log if "nohup" in e[1])
    assert start[4] == {"ANTHROPIC_API_KEY": "k"} and "k" not in start[1].replace("hi", "")   # key only in env
    assert all(e[3] for e in fake.log if e[0] == "exec")


def test_cli_agent_uses_exec_long_when_the_sandbox_has_it():
    box = FakeBox(json.dumps({"subtype": "success", "result": "DONE", "num_turns": 2}))
    used = []
    box.exec_long = lambda cmd, timeout, env=None: (used.append(cmd), box.exec(cmd, timeout, env))[1]
    assert ClaudeCLIAgent(api_key="k").run(TASK, box, 1, None).claim == "done" and used


def test_daytona_branch_names_are_unique_per_run():
    """Regression (second Daytona run): branches from run 1 already existed on GitHub, so
    run 2's pushes to the same names were rejected as non-fast-forward."""
    fake = FakeDaytonaSandbox()
    a = DaytonaSandbox("u", "B1", 1, github_token="t", client=FakeClient(fake), run_id="20261102-154400")
    b = DaytonaSandbox("u", "B1", 1, github_token="t", client=FakeClient(fake), run_id="20261102-160000")
    assert a.branch == "task/20261102-154400/B1-a1" and a.branch != b.branch


def test_daytona_deletes_sandbox_when_setup_fails():
    fake = FakeDaytonaSandbox(fail_on="npm install")
    with pytest.raises(RuntimeError, match="setup failed"):
        with DaytonaSandbox("https://github.com/b/repo", "B6", 1, github_token="t", client=FakeClient(fake)):
            pass
    assert fake.deleted


def test_daytona_deletes_sandbox_when_task_crashes():
    fake = FakeDaytonaSandbox()
    with pytest.raises(ZeroDivisionError):
        with DaytonaSandbox("u", "B1", 1, github_token="t", client=FakeClient(fake)):
            1 / 0
    assert fake.deleted


def test_daytona_web_sandbox_uses_bigger_node_image_and_installs_packages():
    from engine.stacks import NextSupabaseStack
    opts = NextSupabaseStack(link_node_modules=False).daytona_options()
    created = []
    fake = FakeDaytonaSandbox()

    class Client:
        def create(self, params=None, timeout=60):
            created.append((params, timeout))
            return fake

    with DaytonaSandbox("u", "T1", 1, github_token="t", client=Client(), **opts):
        pass
    params, timeout = created[0]
    assert params.image == "node:22-bookworm" and timeout >= 600
    assert params.resources.memory * NextSupabaseStack.parallel <= 10   # fits the 10 GB account limit
    assert any(e[0] == "exec" and "npm ci" in e[1] for e in fake.log) and fake.deleted


def test_daytona_failed_start_is_found_by_name_and_deleted():
    """Regression (fourth web run): when Daytona failed to start a sandbox (502), create() raised before
    returning it, and the half-started sandbox kept its memory until the account's limit was full."""
    deleted = []

    class Ghost:
        def __init__(self, name):
            self.name = name

    class Client:
        def create(self, params=None, timeout=60):
            self.name = params.name
            raise RuntimeError("Failed to create sandbox: 502 Bad Gateway")

        def list(self, query=None):
            return [Ghost(self.name), Ghost("someone-else")]

        def delete(self, box, timeout=60):
            deleted.append(box.name)

    c = Client()
    with pytest.raises(SandboxUnavailable, match="502"):
        with DaytonaSandbox("u", "T1", 1, github_token="t", client=c):
            pass
    assert deleted == [c.name] and c.name.startswith("engine-")


# ---------------------------------------------------------------- live activity (stream-json)
def _tool(name, **args):
    return json.dumps({"type": "assistant", "message": {"content": [
        {"type": "text", "text": "Let me look."}, {"type": "tool_use", "id": "t1", "name": name, "input": args}]}})


RESULT = json.dumps({"type": "result", "subtype": "success", "is_error": False, "result": "Built it.\nDONE",
                     "total_cost_usd": 0.42, "num_turns": 7})
STREAM = "\n".join([
    json.dumps({"type": "system", "subtype": "init", "tools": ["Read"]}),
    _tool("Read", file_path="/home/daytona/repo/src/lib/db.ts"),
    _tool("Write", file_path="/home/daytona/repo/src/server/bookings.ts", content="export const x = 1;\n" * 50),
    json.dumps({"type": "user", "message": {"content": [{"type": "tool_result", "content": "ok"}]}}),
    _tool("Bash", command="npx vitest run   tests/unit/x.test.ts"),
    RESULT,
])


def test_stream_json_lines_become_short_notes():
    notes = [n for line in STREAM.splitlines() for n in activity_notes(line, "repo")]
    assert notes == ["Reading src/lib/db.ts", "Wrote src/server/bookings.ts", "Ran npx vitest run tests/unit/x.test.ts"]
    assert activity_notes(_tool("Edit", file_path="/w/sb/T1-a1/a.py"), "/w/sb/T1-a1") == ["Edited a.py"]
    assert activity_notes(_tool("Bash", command="x" * 500), "")[0].endswith("…")
    assert len(activity_notes(_tool("Bash", command="x" * 500), "")[0]) == 90
    assert activity_notes("not json", "") == [] and activity_notes(RESULT, "") == []


def test_final_result_is_still_parsed_from_the_stream():
    """The last line of stream-json is the same result object --output-format json printed."""
    rep = ClaudeCLIAgent(api_key="k").run(TASK, FakeBox(STREAM), 1, None)
    assert (rep.claim, rep.cost_usd, rep.turns) == ("done", 0.42, 7)
    failed = STREAM.replace(RESULT, json.dumps({"type": "result", "subtype": "error_max_turns", "is_error": True,
                                                "result": None, "total_cost_usd": 0.9, "num_turns": 40}))
    rep = ClaudeCLIAgent(api_key="k").run(TASK, FakeBox(failed, code=1), 1, None)
    assert rep.claim == "error: agent run did not finish (error_max_turns)" and rep.cost_usd == 0.9


def test_stream_stopped_by_timeout_is_still_reported_as_out_of_time():
    """With stream-json a killed run ends on an ordinary message line, which must not be taken for the result."""
    partial = "\n".join(STREAM.splitlines()[:-1])
    assert parse_cli_json(partial) is None
    rep = ClaudeCLIAgent(api_key="k", timeout_s=30 * 60).run(TASK, FakeBox(partial, code=124), 1, None)
    assert rep.claim == "error: agent ran out of time (29 min) and was stopped"


def test_stream_notes_buffers_partial_lines_and_masks_the_key():
    got = []
    feed = stream_notes(got.append, "repo", secret="sk-secret")
    line = _tool("Bash", command="echo sk-secret")
    feed(line[:20])
    assert got == []                                    # half a line: nothing yet
    feed(line[20:] + "\n" + _tool("Read", file_path="/x/repo/a.ts") + "\n")
    assert got == [["Ran echo ***", "Reading a.ts"]]    # one call per chunk, key never shown
    boom = stream_notes(lambda n: 1 / 0, "repo")
    boom(_tool("Read", file_path="a") + "\n")          # a failing callback never breaks the run


def test_cli_agent_streams_progress_through_exec_long_only_when_asked():
    box = FakeBox(STREAM)
    seen = {}

    def exec_long(cmd, timeout, env=None, on_output=None):
        seen["on_output"] = on_output
        if on_output:
            on_output(STREAM + "\n")
        return box.exec(cmd, timeout, env)

    box.exec_long, box.workdir = exec_long, "repo"
    got = []
    rep = ClaudeCLIAgent(api_key="k").run(TASK, box, 1, None, progress=got.append)
    assert rep.claim == "done" and got == [["Reading src/lib/db.ts", "Wrote src/server/bookings.ts",
                                            "Ran npx vitest run tests/unit/x.test.ts"]]
    ClaudeCLIAgent(api_key="k").run(TASK, box, 1, None)
    assert seen["on_output"] is None                    # no progress wanted: plain exec_long call
    assert ClaudeCLIAgent(api_key="k").run(TASK, FakeBox(STREAM), 1, None, progress=got.append).claim == "done"


def test_daytona_exec_long_streams_new_complete_lines():
    fake = FakeDaytonaSandbox()
    lines = [f'{{"n": {i}}}' for i in range(5)]
    state = {"polls": 0, "reads": []}

    def exec_(cmd, cwd=None, env=None, timeout=None):
        fake.log.append(("exec", cmd, cwd, timeout, env))
        if cmd.startswith("cat /tmp/run-"):
            state["polls"] += 1
            return SimpleNamespace(exit_code=0, result="0\n" if state["polls"] == 4 else "")
        if cmd.startswith("tail -n +"):
            start = int(cmd.split("+")[1].split()[0]) - 1
            state["reads"].append(start)
            # what the file holds at this poll: 2 lines, then 3 and half of the 4th, then all 5
            written = {1: "\n".join(lines[:2]) + "\n", 2: "\n".join(lines[:3]) + '\n{"n": ',
                       3: "\n".join(lines) + "\n"}[state["polls"]]
            return SimpleNamespace(exit_code=0, result="".join(written.splitlines(True)[start:]))
        if cmd.startswith("tail -n 100"):
            return SimpleNamespace(exit_code=0, result=RESULT)
        return SimpleNamespace(exit_code=0, result="")

    fake.process = SimpleNamespace(exec=exec_)
    box = DaytonaSandbox("u", "T1", 1, github_token="t", client=FakeClient(fake))
    box.__enter__()
    chunks = []
    r = box.exec_long("claude -p hi", timeout=600, poll_s=0, sleep=lambda s: None, on_output=chunks.append)
    assert (r.code, r.output) == (0, RESULT)
    assert state["reads"] == [0, 2, 3]
    assert "".join(chunks).splitlines() == lines and all(c.endswith("\n") for c in chunks)

    def broken(cmd, cwd=None, env=None, timeout=None):     # a failed read or callback never stops the run
        if cmd.startswith("tail -n +"):
            raise ConnectionError("dropped")
        return exec_(cmd, cwd, env, timeout)

    state["polls"] = 0
    fake.process = SimpleNamespace(exec=broken)
    assert box.exec_long("x", timeout=600, poll_s=0, sleep=lambda s: None, on_output=lambda t: 1 / 0).code == 0


def test_role_rules_fit_web_projects_too():
    """Regression (Pawfect retry): the QA agent was told "use pytest and the standard library only" on a
    Next.js project and blocked; the rules now point at the project's own framework."""
    from engine.agents.prompt import RULES
    from engine.stacks import NextSupabaseStack
    assert "pytest and the standard library only" not in RULES["qa"] and "Vitest" in RULES["qa"]
    assert "raise NotImplementedError" not in RULES["planner"]
    assert NextSupabaseStack(link_node_modules=False).run_tests("t.ts").startswith("DEBUG_PRINT_LIMIT=1500 ")
