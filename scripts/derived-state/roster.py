#!/usr/bin/env python3
"""Inventory every OpenScout clone/worktree without changing it."""

from __future__ import annotations

import argparse
import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

from retention_common import (
    DEFAULT_CANONICAL,
    DEFAULT_SEARCH_ROOTS,
    active_processes,
    discover_repo_copies,
    display_path,
    du_kib,
    format_size,
    inspect_copy,
    isoformat,
    json_safe,
    load_registry,
)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--repo", type=Path, default=DEFAULT_CANONICAL, help="canonical OpenScout checkout")
    result.add_argument("--search-root", action="append", type=Path, help="root to scan for independent clones (repeatable)")
    result.add_argument("--format", choices=("table", "tsv", "json"), default="table")
    result.add_argument("--no-size", action="store_true", help="skip the comparatively expensive du pass")
    result.add_argument("--jobs", type=int, default=3, help="parallel du jobs (default: 3)")
    result.add_argument("--summary", action="store_true", help="print only decision counts and aggregate du size")
    return result


def touched(value: Optional[float]) -> str:
    if value is None:
        return "?"
    return datetime.fromtimestamp(value).astimezone().replace(microsecond=0).isoformat()


def bool_text(value: object) -> str:
    if value is True:
        return "yes"
    if value is False:
        return "no"
    return "?"


def registration_text(record: Dict[str, object]) -> str:
    registration = record.get("registration")
    if not isinstance(registration, dict):
        return "-"
    owner = str(registration.get("owner") or "?")
    task = str(registration.get("taskId") or "?")
    expires = str(registration.get("expiresAt") or "?")
    return f"{owner}/{task}@{expires}"


def add_sizes(records: List[Dict[str, object]], jobs: int) -> None:
    with ThreadPoolExecutor(max_workers=max(1, jobs)) as pool:
        futures = {pool.submit(du_kib, record["path"]): record for record in records if record.get("exists")}
        for future in as_completed(futures):
            futures[future]["sizeKiB"] = future.result()
    for record in records:
        record.setdefault("sizeKiB", None)


def print_summary(records: List[Dict[str, object]]) -> None:
    counts: Dict[str, int] = {}
    total = 0
    for record in records:
        decision = str(record.get("decision") or "unknown")
        counts[decision] = counts.get(decision, 0) + 1
        total += int(record.get("sizeKiB") or 0)
    measured = any(record.get("sizeKiB") is not None for record in records)
    size_text = f"du-ranked size: {format_size(total)} (APFS clone sharing makes this an overestimate)" if measured else "size pass: skipped"
    print(f"OpenScout copies: {len(records)}; {size_text}")
    for decision, count in sorted(counts.items()):
        print(f"  {count:>3}  {decision}")


def print_table(records: List[Dict[str, object]]) -> None:
    headers = ["KIND", "DIRTY", "MERGED", "UNPUSH", "ORPHAN", "SIZE~", "LAST-TOUCHED", "BRANCH", "OWNER/TASK@EXPIRY", "DECISION", "PATH"]
    rows = []
    for record in records:
        rows.append(
            [
                str(record.get("kind") or "?"),
                bool_text(record.get("dirty")),
                bool_text(record.get("mergedIntoMain")),
                str(record.get("unpushedCommits") if record.get("unpushedCommits") is not None else "?"),
                str(record.get("orphanRisk") or "?"),
                format_size(record.get("sizeKiB")),
                touched(record.get("lastTouched")),
                str(record.get("branch") or "(detached)"),
                registration_text(record),
                str(record.get("decision") or "?"),
                display_path(record["path"]),
            ]
        )
    widths = [len(header) for header in headers]
    for row in rows:
        for index, cell in enumerate(row):
            widths[index] = max(widths[index], len(cell))
    print("  ".join(header.ljust(widths[index]) for index, header in enumerate(headers)))
    print("  ".join("-" * width for width in widths))
    for row in rows:
        print("  ".join(cell.ljust(widths[index]) for index, cell in enumerate(row)))
    print("\nSIZE~ is du allocation, not physical reclaim. Confirm any applied reclaim with df /System/Volumes/Data.")
    print("MERGED compares HEAD to the locally observed origin default branch; run the janitor with --fetch before acting.")


def print_tsv(records: List[Dict[str, object]]) -> None:
    fields = ["path", "kind", "branch", "dirty", "mergedIntoMain", "mainRef", "unpushedCommits", "orphanRisk", "sizeKiB", "lastTouched", "decision"]
    print("\t".join(fields))
    for record in records:
        values = []
        for field in fields:
            value = record.get(field)
            if field == "lastTouched" and isinstance(value, (float, int)):
                value = touched(float(value))
            values.append(str(value) if value is not None else "")
        print("\t".join(values))


def main() -> int:
    args = parser().parse_args()
    search_roots = args.search_root or DEFAULT_SEARCH_ROOTS
    bases, fingerprint = discover_repo_copies(args.repo, search_roots)
    paths = [base["path"] for base in bases]
    active = active_processes(paths)
    registrations = load_registry()
    records = [inspect_copy(base, registrations, active) for base in bases]
    if not args.no_size:
        add_sizes(records, args.jobs)
    else:
        for record in records:
            record["sizeKiB"] = None

    if args.summary:
        print_summary(records)
    elif args.format == "json":
        print(json.dumps({"origin": fingerprint, "copies": json_safe(records)}, indent=2, sort_keys=True))
    elif args.format == "tsv":
        print_tsv(records)
    else:
        print_table(records)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
