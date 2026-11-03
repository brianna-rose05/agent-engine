"""List or delete the engine's Daytona sandboxes.

    python3 scripts/daytona_cleanup.py list                 # every sandbox in the account (read-only)
    python3 scripts/daytona_cleanup.py delete-engine        # sandboxes labeled app=agent-engine
    python3 scripts/daytona_cleanup.py delete-unlabeled-engine
        # one-time: sandboxes created before labels existed (no `app` label, created since 2026-11-02,
        # when this account started running the engine)

Needs DAYTONA_API_KEY. Never prints keys."""
import sys
from datetime import datetime, timezone

LABEL = {"app": "agent-engine"}
ENGINE_START = datetime(2026, 11, 2, tzinfo=timezone.utc)


def main():
    from daytona import Daytona, ListSandboxesQuery
    mode = sys.argv[1] if len(sys.argv) > 1 else "list"
    d = Daytona()
    boxes = list(d.list(ListSandboxesQuery(labels=LABEL) if mode == "delete-engine" else None))
    print(f"{len(boxes)} sandbox(es)")
    deleted = 0
    for b in boxes:
        created = datetime.fromisoformat(str(b.created_at).replace("Z", "+00:00")) if b.created_at else None
        labels = b.labels or {}
        print(f"- {b.id[:12]} state={b.state} cpu={b.cpu} mem={b.memory}GB created={created} labels={labels}")
        doomed = (mode == "delete-engine" and labels.get("app") == "agent-engine") or (
            mode == "delete-unlabeled-engine" and "app" not in labels and created and created >= ENGINE_START)
        if doomed:
            try:
                d.delete(b, timeout=120)
                deleted += 1
                print("  deleted")
            except Exception as e:  # keep going; report what's left
                print(f"  could not delete: {type(e).__name__}: {str(e)[:120]}")
    print(f"deleted {deleted}")


if __name__ == "__main__":
    main()
