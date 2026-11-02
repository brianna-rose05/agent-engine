from types import SimpleNamespace

from run_benchmark import load_env, missing_modules, preflight


def test_load_env_reads_file_without_overriding_shell(tmp_path, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("DAYTONA_API_KEY", raising=False)
    monkeypatch.setenv("GITHUB_TOKEN", "from-shell")
    f = tmp_path / ".env"
    f.write_text('# keys\nANTHROPIC_API_KEY=sk-ant-test\nexport DAYTONA_API_KEY="dtn-test"\n'
                 "GITHUB_TOKEN=from-file\nEMPTY=\n")
    load_env(f)
    import os
    assert os.environ["ANTHROPIC_API_KEY"] == "sk-ant-test"
    assert os.environ["DAYTONA_API_KEY"] == "dtn-test"
    assert os.environ["GITHUB_TOKEN"] == "from-shell"
    assert "EMPTY" not in os.environ


def test_load_env_missing_file_is_fine(tmp_path):
    load_env(tmp_path / "nope.env")


def test_preflight_reports_missing_package(monkeypatch):
    import importlib.util
    real = importlib.util.find_spec
    monkeypatch.setattr(importlib.util, "find_spec", lambda m: None if m == "daytona" else real(m))
    a = SimpleNamespace(agent="reference", sandbox="daytona", repo_url="https://github.com/x/y")
    assert missing_modules(a) == ["daytona"]
    assert any("pip install daytona" in p for p in preflight(a))
