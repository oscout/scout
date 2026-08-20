#!/usr/bin/env python3
"""Read-only size inventory for derived directories across OpenScout copies."""

from __future__ import annotations

import argparse
import json
import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Dict, List, Set, Tuple

from retention_common import DEFAULT_CANONICAL, DEFAULT_SEARCH_ROOTS, discover_repo_copies, display_path, du_kib, format_size, json_safe


CATEGORIES = {
    "node_modules": "node_modules",
    ".next": "next",
    ".build": "swift-build",
    ".deriveddata": "xcode-derived",
    ".derived-iphone": "xcode-derived",
    "DerivedData": "xcode-derived",
}


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--repo", type=Path, default=DEFAULT_CANONICAL)
    result.add_argument("--search-root", action="append", type=Path)
    result.add_argument("--json", action="store_true")
    result.add_argument("--jobs", type=int, default=3)
    result.add_argument("--top", type=int, default=30)
    return result


def find_derived(copy: Path, all_copies: Set[Path]) -> List[Dict[str, object]]:
    found: List[Dict[str, object]] = []
    for current, directories, _ in os.walk(copy):
        here = Path(current)
        kept = []
        for name in directories:
            # Preserve lexical paths so workspace symlinks do not all resolve
            # to (and double-count) the same root node_modules directory.
            candidate = Path(os.path.abspath(str(here / name)))
            if candidate != copy and candidate in all_copies:
                continue
            if name == ".git":
                continue
            category = CATEGORIES.get(name)
            if category:
                if candidate.is_symlink():
                    continue
                found.append({"copy": copy, "path": candidate, "category": category})
                continue
            kept.append(name)
        directories[:] = kept
    return found


def main() -> int:
    args = parser().parse_args()
    bases, fingerprint = discover_repo_copies(args.repo, args.search_root or DEFAULT_SEARCH_ROOTS)
    copies = {base["path"] for base in bases if base.get("exists")}
    entries: List[Dict[str, object]] = []
    for copy in sorted(copies):
        entries.extend(find_derived(copy, copies))
    with ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
        futures = {pool.submit(du_kib, entry["path"]): entry for entry in entries}
        for future in as_completed(futures):
            futures[future]["sizeKiB"] = future.result()
    entries.sort(key=lambda entry: int(entry.get("sizeKiB") or 0), reverse=True)
    totals: Dict[str, Dict[str, int]] = {}
    for entry in entries:
        category = str(entry["category"])
        total = totals.setdefault(category, {"count": 0, "sizeKiB": 0})
        total["count"] += 1
        total["sizeKiB"] += int(entry.get("sizeKiB") or 0)
    if args.json:
        print(json.dumps(json_safe({"origin": fingerprint, "totals": totals, "entries": entries}), indent=2, sort_keys=True))
    else:
        print("Derived-state inventory (du-ranked; APFS clone sharing can make node_modules reclaim much smaller):")
        for category, total in sorted(totals.items(), key=lambda item: item[1]["sizeKiB"], reverse=True):
            print(f"  {format_size(total['sizeKiB']):>10}  {total['count']:>3} dirs  {category}")
        print("\nLargest directories:")
        for entry in entries[: args.top]:
            print(f"  {format_size(entry.get('sizeKiB')):>10}  {str(entry['category']):<13}  {display_path(entry['path'])}")
        print("\nOnly df /System/Volumes/Data before/after an approved removal measures physical reclaim.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
