"""Shared test setup."""
import pytest


@pytest.fixture(autouse=True)
def git_identity(monkeypatch):
    """Every test can commit and tag in any clone it makes. Regression (CI on GitHub Actions): the runner has no
    global git identity, so the worker end-to-end tests failed in their fresh clones (rollback, ship), while they
    passed on a machine with ~/.gitconfig. The Worker workflow sets one with `git config --global`."""
    for k, v in (("GIT_AUTHOR_NAME", "test"), ("GIT_AUTHOR_EMAIL", "test@example.com"),
                 ("GIT_COMMITTER_NAME", "test"), ("GIT_COMMITTER_EMAIL", "test@example.com")):
        monkeypatch.setenv(k, v)
