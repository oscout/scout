#!/usr/bin/env python3
"""Register ownership and an expected lifetime for an agent-created Git copy."""

from __future__ import annotations

import argparse
import os
from datetime import timedelta
from pathlib import Path
from typing import Dict

from retention_common import (
    isoformat,
    load_registry,
    repo_origin,
    repo_top,
    resolved,
    utc_now,
    write_registration,
)


def inferred_owner() -> str:
    for key in ("SCOUT_AGENT_ID", "CODEX_THREAD_ID", "CLAUDE_SESSION_ID", "USER"):
        value = os.environ.get(key)
        if value:
            return f"{key.lower()}:{value}"
    return "unknown"


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    subparsers = result.add_subparsers(dest="command", required=True)
    for name in ("register", "renew", "retire"):
        command = subparsers.add_parser(name)
        command.add_argument("--path", type=Path, default=Path.cwd())
        command.add_argument("--owner", default=inferred_owner())
        command.add_argument("--task-id", required=name == "register")
        command.add_argument("--lifetime-hours", type=float, default=72.0)
    return result


def main() -> int:
    args = parser().parse_args()
    now = utc_now()
    top = repo_top(args.path)
    if not top:
        raise SystemExit(f"not a Git working tree: {args.path}")
    path = resolved(top)
    existing = load_registry().get(path, {})
    registration: Dict[str, object] = dict(existing)
    registration.update(
        {
            "schemaVersion": 1,
            "path": str(path),
            "origin": repo_origin(path),
            "owner": args.owner,
            "taskId": args.task_id or existing.get("taskId") or "unknown",
            "updatedAt": isoformat(now),
            "expectedLifetimeHours": args.lifetime_hours,
            "expiresAt": isoformat(now + timedelta(hours=args.lifetime_hours)),
            "state": "active",
        }
    )
    registration.setdefault("createdAt", isoformat(now))
    if args.command == "retire":
        registration["state"] = "retire-requested"
        registration["retireRequestedAt"] = isoformat(now)
        registration["expiresAt"] = isoformat(now)
    destination = write_registration(path, registration)
    print(f"{args.command}: {path}")
    print(f"registry: {destination}")
    print(f"owner={registration['owner']} task={registration['taskId']} state={registration['state']} expires={registration['expiresAt']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
