#!/usr/bin/env python3
"""Inspect or remove the legacy OpenScout Studio Turbopack disk cache."""

from __future__ import annotations

import argparse
import shutil
from datetime import datetime
from pathlib import Path
from typing import List, Optional, Tuple

from retention_common import active_processes, disk_free_bytes, display_path, du_kib, format_size


DEFAULT_STUDIO = Path.home() / "dev" / "openscout" / "design" / "studio"


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--studio", type=Path, default=DEFAULT_STUDIO)
    result.add_argument("--apply", action="store_true", help="remove the cache; omitted means inspect only")
    return result


def file_age_range(path: Path) -> Tuple[Optional[float], Optional[float], int]:
    oldest: Optional[float] = None
    newest: Optional[float] = None
    count = 0
    for item in path.rglob("*") if path.is_dir() else []:
        try:
            if not item.is_file():
                continue
            mtime = item.stat().st_mtime
        except OSError:
            continue
        count += 1
        oldest = mtime if oldest is None else min(oldest, mtime)
        newest = mtime if newest is None else max(newest, mtime)
    return oldest, newest, count


def stamp(value: Optional[float]) -> str:
    return datetime.fromtimestamp(value).astimezone().replace(microsecond=0).isoformat() if value is not None else "?"


def main() -> int:
    args = parser().parse_args()
    studio = args.studio.expanduser().resolve(strict=False)
    cache = studio / ".next" / "dev" / "cache" / "turbopack"
    if cache.is_symlink() or cache.resolve(strict=False) != cache:
        raise SystemExit(f"refusing unexpected/symlink cache path: {cache}")
    if not cache.exists():
        print(f"Studio Turbopack cache absent: {display_path(cache)}")
        return 0

    size = du_kib(cache)
    oldest, newest, files = file_age_range(cache)
    active = active_processes([studio]).get(studio, [])
    print(f"Studio Turbopack cache: {format_size(size)} across {files} files")
    print(f"  path: {display_path(cache)}")
    print(f"  oldest: {stamp(oldest)}")
    print(f"  newest: {stamp(newest)}")
    print(f"  active processes: {len(active)}")
    if not args.apply:
        print("DRY-RUN: no files were removed. The repo disables future Turbopack filesystem caching; use --apply only after the studio dev server stops.")
        return 0
    if active:
        for process in active[:8]:
            print(f"  BLOCKED pid {process.get('pid')}: {process['command']}")
        print("Refusing to remove a cache while the studio is active.")
        return 2

    before = disk_free_bytes()
    shutil.rmtree(cache)
    after = disk_free_bytes()
    if before is not None and after is not None:
        print(f"REMOVED; df reclaim {(after - before) / 2**30:.2f}GiB")
    else:
        print("REMOVED; run df -h /System/Volumes/Data to measure physical reclaim")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
