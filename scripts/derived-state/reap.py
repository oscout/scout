#!/usr/bin/env python3
"""Retire merged OpenScout clones/worktrees; dry-run unless --apply is explicit."""

from __future__ import annotations

import argparse
import json
import os
import shutil
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Set, Tuple

from retention_common import (
    DEFAULT_CANONICAL,
    DEFAULT_SEARCH_ROOTS,
    active_processes,
    common_dir,
    discover_repo_copies,
    disk_free_bytes,
    display_path,
    explain_safety,
    git,
    git_text,
    ignored_path_is_derived,
    inspect_copy,
    integration_ref,
    isoformat,
    json_safe,
    load_registry,
    normalize_remote,
    parse_worktree_porcelain,
    repo_origin,
    refs_containing,
    resolved,
    run,
    status_entries,
    utc_now,
    write_registration,
)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--repo", type=Path, default=DEFAULT_CANONICAL)
    result.add_argument("--search-root", action="append", type=Path)
    result.add_argument("--path", action="append", type=Path, help="limit to an exact registered path (repeatable)")
    result.add_argument("--fetch", action="store_true", help="fetch origin main in each independent Git store before deciding")
    result.add_argument("--apply", action="store_true", help="perform eligible removals; omitted means dry-run")
    result.add_argument("--json", action="store_true")
    return result


def fetch_integration_refs(
    bases: Sequence[Dict[str, object]],
) -> Tuple[List[str], Set[Path]]:
    messages: List[str] = []
    failures: Set[Path] = set()
    seen: set[Path] = set()
    for base in bases:
        if base.get("kind") not in {"canonical", "clone"} or not base.get("exists"):
            continue
        path = base["path"]
        assert isinstance(path, Path)
        common = common_dir(path)
        if not common or common in seen:
            continue
        seen.add(common)
        # Only origin/main participates in the arithmetic. Fetching every
        # branch every six hours would add avoidable pack/ref churn on the disk
        # this job exists to protect.
        result = git(
            path,
            ["fetch", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main"],
            timeout=180,
        )
        if result.returncode == 0:
            messages.append(f"fetched {display_path(path)}")
        else:
            failures.add(common)
            detail = result.stderr.strip().splitlines()[-1] if result.stderr.strip() else f"exit {result.returncode}"
            messages.append(f"fetch failed {display_path(path)}: {detail}")
    return messages, failures


def block_fetch_failures(
    records: Sequence[Dict[str, object]],
    failed_common_dirs: Set[Path],
) -> None:
    """Make a failed integration-ref refresh an explicit deletion blocker."""

    for record in records:
        common = record.get("commonDir")
        if isinstance(common, Path) and common in failed_common_dirs:
            record["decision"] = "keep:unknown"
            record["decisionReasons"] = [
                "origin main fetch failed for this Git store; refusing stale reachability evidence"
            ]


def linked_worktree_paths(clone: Path) -> Optional[List[Path]]:
    """Return worktrees whose Git metadata is owned by an independent clone."""

    output = git_text(clone, ["worktree", "list", "--porcelain"])
    if output is None:
        return None
    owner = resolved(clone)
    return [
        resolved(Path(record["worktree"]))
        for record in parse_worktree_porcelain(output)
        if record.get("worktree") and resolved(Path(record["worktree"])) != owner
    ]


def allowed_roots(search_roots: Sequence[Path]) -> List[Path]:
    roots = [root.expanduser().resolve(strict=False) for root in search_roots]
    roots.extend(
        [
            (Path.home() / ".codex" / "worktrees").resolve(strict=False),
            Path("/private/tmp").resolve(strict=False),
        ]
    )
    return roots


def contained_by(path: Path, roots: Sequence[Path]) -> bool:
    for root in roots:
        try:
            path.relative_to(root)
            return path != root
        except ValueError:
            continue
    return False


def apply_preflight(record: Dict[str, object], roots: Sequence[Path], fingerprint: str) -> List[str]:
    path = record["path"]
    assert isinstance(path, Path)
    errors: List[str] = []
    decision, reasons = explain_safety(record)
    if decision != "reap:eligible":
        errors.append(f"policy says {decision}: {', '.join(reasons)}")
    if path.is_symlink():
        errors.append("path is a symlink")
    if not contained_by(path.resolve(strict=False), roots):
        errors.append("path is outside the allowlisted roots")
    if normalize_remote(repo_origin(path)) != fingerprint:
        errors.append("origin no longer matches OpenScout")
    if record.get("kind") == "clone":
        linked = linked_worktree_paths(path)
        if linked is None:
            errors.append("could not prove the clone owns no linked worktrees")
        elif linked:
            preview = ", ".join(display_path(item) for item in linked[:4])
            errors.append(f"clone still owns linked worktrees: {preview}")
    fresh_active = active_processes([path]).get(path, [])
    if fresh_active:
        errors.append("fresh liveness check found an active process or probe failure")
    fresh_head_result = git(path, ["rev-parse", "HEAD"])
    fresh_head = fresh_head_result.stdout.strip() if fresh_head_result.returncode == 0 else None
    if not fresh_head or fresh_head != record.get("head"):
        errors.append("HEAD changed or became unreadable after the roster decision")
    fresh_main = integration_ref(path)
    if fresh_head and fresh_main and git(path, ["merge-base", "--is-ancestor", fresh_head, fresh_main]).returncode != 0:
        errors.append("fresh merge check no longer places HEAD on origin main")
    elif not fresh_main:
        errors.append("fresh merge check cannot resolve origin main")
    fresh_remote_refs = [ref for ref in refs_containing(path, fresh_head) if ref.startswith("refs/remotes/")] if fresh_head else []
    if not fresh_remote_refs:
        errors.append("fresh reachability check found no remote ref containing HEAD")
    if fresh_head:
        unpushed_result = git(path, ["rev-list", "--count", fresh_head, "--not", "--remotes"])
        if unpushed_result.returncode != 0 or unpushed_result.stdout.strip() != "0":
            errors.append("fresh unpushed check is nonzero or unreadable")
    dirty = status_entries(path)
    if dirty is None:
        errors.append("fresh git status check failed")
    elif dirty:
        errors.append("fresh status check found tracked or untracked work")
    ignored = status_entries(path, include_ignored=True)
    if ignored is None:
        errors.append("fresh ignored-file check failed")
        ignored = []
    unsafe_ignored = [name for code, name in ignored if code == "!!" and not ignored_path_is_derived(name, path)]
    if unsafe_ignored:
        preview = ", ".join(unsafe_ignored[:4])
        errors.append(f"ignored non-derived content would be lost: {preview}")
    return errors


def manager_for(record: Dict[str, object], records: Sequence[Dict[str, object]]) -> Optional[Path]:
    candidate_common = record.get("commonDir")
    for other in records:
        if other is record or not other.get("exists"):
            continue
        if other.get("commonDir") == candidate_common:
            path = other.get("path")
            if isinstance(path, Path):
                return path
    return None


def record_retired(registration: object, path: Path, before: Optional[int], after: Optional[int]) -> None:
    if not isinstance(registration, dict):
        return
    updated = dict(registration)
    updated["state"] = "retired"
    updated["retiredAt"] = isoformat(utc_now())
    if before is not None and after is not None:
        updated["observedDfReclaimBytes"] = max(0, after - before)
    write_registration(path, updated)


def apply_record(record: Dict[str, object], records: Sequence[Dict[str, object]], roots: Sequence[Path], fingerprint: str) -> Dict[str, object]:
    path = record["path"]
    assert isinstance(path, Path)
    outcome: Dict[str, object] = {"path": path, "removed": False}
    errors = apply_preflight(record, roots, fingerprint)
    if errors:
        outcome["errors"] = errors
        return outcome

    before = disk_free_bytes()
    if record.get("kind") == "worktree":
        manager = manager_for(record, records)
        if not manager:
            outcome["errors"] = ["no surviving worktree can manage this Git common dir"]
            return outcome
        result = git(manager, ["worktree", "remove", "--force", str(path)], timeout=300)
        if result.returncode != 0:
            outcome["errors"] = [result.stderr.strip() or f"git worktree remove exited {result.returncode}"]
            return outcome
        git(manager, ["worktree", "prune"], timeout=60)
    elif record.get("kind") == "clone":
        # All source/ref/liveness/ignored-file checks have just been repeated.
        shutil.rmtree(path)
    else:
        outcome["errors"] = [f"unsupported kind {record.get('kind')}"]
        return outcome
    after = disk_free_bytes()
    record_retired(record.get("registration"), path, before, after)
    outcome.update({"removed": True, "dfFreeBefore": before, "dfFreeAfter": after})
    return outcome


def main() -> int:
    args = parser().parse_args()
    search_roots = args.search_root or DEFAULT_SEARCH_ROOTS
    bases, fingerprint = discover_repo_copies(args.repo, search_roots)
    fetch_messages, fetch_failures = fetch_integration_refs(bases) if args.fetch else ([], set())
    registrations = load_registry()
    paths = [base["path"] for base in bases]
    active = active_processes(paths)
    records = [inspect_copy(base, registrations, active) for base in bases]
    block_fetch_failures(records, fetch_failures)
    all_records = records

    selected = {path.expanduser().resolve(strict=False) for path in (args.path or [])}
    if selected:
        known = {record["path"] for record in records}
        unknown = selected - known
        if unknown:
            raise SystemExit("not an OpenScout copy: " + ", ".join(map(str, sorted(unknown))))
        records = [record for record in records if record["path"] in selected]

    outcomes: List[Dict[str, object]] = []
    if args.apply:
        roots = allowed_roots(search_roots)
        for record in records:
            if record.get("decision") == "reap:eligible":
                outcomes.append(apply_record(record, all_records, roots, fingerprint or ""))
    mode = "APPLY" if args.apply else "DRY-RUN"
    if args.json:
        print(json.dumps(json_safe({"mode": mode, "fetch": fetch_messages, "copies": records, "outcomes": outcomes}), indent=2, sort_keys=True))
    else:
        print(f"OpenScout derived-state janitor: {mode}")
        for message in fetch_messages:
            print(f"  {message}")
        for record in records:
            reasons = "; ".join(record.get("decisionReasons") or [])
            print(f"  {record.get('decision', '?'):>22}  {display_path(record['path'])}  ({reasons})")
        for outcome in outcomes:
            if outcome.get("removed"):
                before, after = outcome.get("dfFreeBefore"), outcome.get("dfFreeAfter")
                reclaim = (after - before) if isinstance(before, int) and isinstance(after, int) else None
                suffix = f"; df reclaim {reclaim / 2**30:.2f}GiB" if reclaim is not None else ""
                print(f"  REMOVED {display_path(outcome['path'])}{suffix}")
            else:
                print(f"  REFUSED {display_path(outcome['path'])}: {'; '.join(outcome.get('errors') or [])}")
        if not args.apply:
            print("No files were removed. Use --apply explicitly; only registered, expired/retire-requested, clean, inactive, merged, remote-reachable copies qualify.")
    return 1 if any(not outcome.get("removed") for outcome in outcomes) else 0


if __name__ == "__main__":
    raise SystemExit(main())
