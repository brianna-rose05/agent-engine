"""Verifies the real adapters' wiring with fakes, so they're checked before any keys exist."""
import asyncio
import json
from types import SimpleNamespace

import pytest

from engine.agents.claude_cli import ClaudeCLIAgent, parse_cli_json
from engine.agents.claude_sdk import TOOLS, ClaudeSDKAgent
from engine.agents.prompt import parse_claim
from engine.interfaces import ExecResult, Task
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
    assert "sk-test-123" not in cmd and env == {"ANTHROPIC_API_KEY": "sk-test-123"}
    for flag in ("--bare", "--output-format json", "--permission-mode dontAsk", "--max-budget-usd 0.75"):
        assert flag in cmd
    assert "bypassPermissions" not in cmd and "tests failed" in cmd


def test_cli_agent_auth_failure_from_real_cli_output():
    """Captured from the real `claude` binary run without a key: note subtype says
    'success' while is_error is true. Must be treated as a failure, not 'done'."""
    real = ('{"total_cost_usd":0,"is_error":true,"num_turns":1,"subtype":"success",'
            '"result":"Authentication error · This may be a temporary network issue, please try again",'
            '"type":"result","terminal_reason":"api_error"}')
    rep = ClaudeCLIAgent(api_key="bad").run(TASK, FakeBox(real, code=1), 1, None)
    assert rep.claim == "error: agent run did not finish"


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

    def create(self):
        return self.sb


def test_daytona_lifecycle():
    fake = FakeDaytonaSandbox()
    with DaytonaSandbox("https://github.com/b/repo", "B6", 2, github_token="ghp_x", client=FakeClient(fake)) as box:
        assert box.branch == "task/B6-a2"
        box.write_file("payments.py", "x = 1\n")
        assert box.exec("pytest").code == 0
        box.publish("B6: Deposit")
    kinds = [e[0] for e in fake.log]
    assert ("autostop", 0) in fake.log                                  # won't die mid-task
    assert kinds.index("clone") < kinds.index("push")
    clone = next(e for e in fake.log if e[0] == "clone")
    assert clone[2]["password"] == "ghp_x"
    assert any(e[0] == "exec" and "checkout -q -b task/B6-a2" in e[1] for e in fake.log)
    assert all(e[3] for e in fake.log if e[0] == "exec")                # never the 10s default timeout
    push = next(e for e in fake.log if e[0] == "push")
    assert push[2]["branch"] == "task/B6-a2"
    assert fake.deleted                                                 # nothing left billing


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
