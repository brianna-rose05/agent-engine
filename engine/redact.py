"""Secrets that must never reach an event, a log line or an error message, whatever module produced the text.

The worker registers values it only learns at run time (a project's own Anthropic API key, docs/settings.md), and
every scrubber reads them from here: events (engine/events.py Emitter), ship reports (engine/ship.py scrub), deploy
errors (engine/deploy.py Vercel.scrub), the worker's own `hide`, and its stdout/stderr (`redact_output`).
Settings that live in the environment are scrubbed by name where they are used (engine/ship.py SECRET_ENV)."""
from __future__ import annotations

import sys

MASK = "***"
MIN_LENGTH = 8                       # shorter values would mangle ordinary words
_secrets: list[str] = []


def register(value: str | None) -> None:
    """Scrub `value` from everything from now on (this process only; nothing is written anywhere)."""
    if isinstance(value, str) and len(value) >= MIN_LENGTH and value not in _secrets:
        _secrets.append(value)
        _secrets.sort(key=len, reverse=True)     # a longer secret that contains a shorter one goes first


def registered() -> tuple[str, ...]:
    return tuple(_secrets)


def clear() -> None:
    """Tests only."""
    _secrets.clear()


def redact(text: str) -> str:
    for s in _secrets:
        if s in text:
            text = text.replace(s, MASK)
    return text


def redact_data(value):
    """`value` with every registered secret masked in every string inside it (dicts, lists, tuples, keys too)."""
    if not _secrets:
        return value
    if isinstance(value, str):
        return redact(value)
    if isinstance(value, dict):
        return {redact_data(k): redact_data(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return type(value)(redact_data(v) for v in value)
    return value


class RedactingStream:
    """A text stream that masks registered secrets in everything written through it (print, tracebacks)."""

    def __init__(self, inner):
        self._inner = inner

    def write(self, text):
        return self._inner.write(redact(text) if isinstance(text, str) else text)

    def writelines(self, lines):
        for line in lines:
            self.write(line)

    def __getattr__(self, name):
        return getattr(self._inner, name)


def redact_output() -> None:
    """Masks registered secrets in sys.stdout and sys.stderr from now on (idempotent). Output a subprocess writes
    straight to the file descriptors bypasses this: the worker captures or never prints those."""
    for name in ("stdout", "stderr"):
        stream = getattr(sys, name)
        if stream is not None and not isinstance(stream, RedactingStream):
            setattr(sys, name, RedactingStream(stream))
