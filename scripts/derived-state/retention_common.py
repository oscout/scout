#!/usr/bin/env python3
"""Shared, read-mostly helpers for OpenScout derived-state retention tools.

The destructive callers are deliberately separate and must opt in explicitly.
This module does not remove files or mutate Git refs.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Set, Tuple


DATA_VOLUME = Path("/System/Volumes/Data")
DEFAULT_CANONICAL = Path.home() / "dev" / "openscout"
DEFAULT_SEARCH_ROOTS = [Path.home() / "dev", Path.home() / ".codex" / "worktrees"]
STATE_ROOT = Path(
    os.environ.get(
        "OPENSCOUT_DERIVED_STATE_ROOT",
        str(Path.home() / ".local" / "state" / "openscout" / "derived-state"),
    )
).expanduser()
REGISTRY_ROOT = STATE_ROOT / "worktrees"

DERIVED_COMPONENTS = {
    ".build",
    ".derived-iphone",
    ".deriveddata",
    ".next",
    ".swiftpm",
    ".turbo",
    "DerivedData",
    "coverage",
    "node_modules",
}


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def isoformat(value: datetime) -> str:
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_time(value: object) -> Optional[datetime]:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def resolved(path: Path) -> Path:
    return path.expanduser().resolve(strict=False)


def display_path(path: Path) -> str:
    value = str(path)
    home = str(Path.home())
    return "~" + value[len(home) :] if value == home or value.startswith(home + os.sep) else value


def run(
    command: Sequence[str],
    *,
    cwd: Optional[Path] = None,
    timeout: int = 60,
    text: bool = True,
) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(
            list(command),
            cwd=str(cwd) if cwd else None,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=text,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        stderr = str(error) if text else str(error).encode()
        stdout = "" if text else b""
        return subprocess.CompletedProcess(list(command), 124, stdout, stderr)


def git(path: Path, args: Sequence[str], *, timeout: int = 60, text: bool = True) -> subprocess.CompletedProcess:
    # Roster/status probes must not refresh index stat data merely by being
    # observed. Required locks for fetch/remove still work with this global
    # option; it suppresses only optional background-style refresh writes.
    return run(["git", "--no-optional-locks", "-C", str(path), *args], timeout=timeout, text=text)


def git_text(path: Path, args: Sequence[str], *, timeout: int = 60) -> Optional[str]:
    result = git(path, args, timeout=timeout)
    if result.returncode != 0:
        return None
    return result.stdout.strip()


def normalize_remote(remote: Optional[str]) -> Optional[str]:
    if not remote:
        return None
    value = remote.strip()
    if value.startswith("git+"):
        value = value[4:]
    scp_match = re.match(r"^[^@]+@([^:]+):(.+)$", value)
    if scp_match:
        host, path = scp_match.groups()
        value = f"{host}/{path}"
    else:
        value = re.sub(r"^[a-z][a-z0-9+.-]*://", "", value, flags=re.I)
        value = re.sub(r"^[^@/]+@", "", value)
    value = value.rstrip("/")
    if value.endswith(".git"):
        value = value[:-4]
    if "/" not in value:
        return value.lower()
    host, path = value.split("/", 1)
    return f"{host.lower()}/{path}"


def repo_origin(path: Path) -> Optional[str]:
    return git_text(path, ["remote", "get-url", "origin"])


def repo_top(path: Path) -> Optional[Path]:
    top = git_text(path, ["rev-parse", "--show-toplevel"])
    return resolved(Path(top)) if top else None


def common_dir(path: Path) -> Optional[Path]:
    raw = git_text(path, ["rev-parse", "--git-common-dir"])
    if not raw:
        return None
    candidate = Path(raw)
    if not candidate.is_absolute():
        candidate = path / candidate
    return resolved(candidate)


def parse_worktree_porcelain(output: str) -> List[Dict[str, str]]:
    records: List[Dict[str, str]] = []
    current: Dict[str, str] = {}
    for line in output.splitlines() + [""]:
        if not line:
            if current:
                records.append(current)
                current = {}
            continue
        key, _, value = line.partition(" ")
        current[key] = value if value else "true"
    return records


def _walk_git_roots(search_root: Path, max_depth: int = 5) -> Iterable[Path]:
    root = resolved(search_root)
    if not root.is_dir():
        return
    base_depth = len(root.parts)
    for current, directories, files in os.walk(root):
        here = Path(current)
        depth = len(here.parts) - base_depth
        directories[:] = [
            name
            for name in directories
            if name not in DERIVED_COMPONENTS and name not in {"vendor", ".cache"}
        ]
        if ".git" in directories:
            yield here
            directories[:] = []
            continue
        if ".git" in files:
            yield here
            directories[:] = []
            continue
        if depth >= max_depth:
            directories[:] = []


def discover_repo_copies(
    canonical: Path = DEFAULT_CANONICAL,
    search_roots: Optional[Sequence[Path]] = None,
) -> Tuple[List[Dict[str, object]], Optional[str]]:
    """Discover matching independent clones, then ask each for linked worktrees."""

    canonical = resolved(canonical)
    fingerprint = normalize_remote(repo_origin(canonical))
    if not fingerprint:
        raise RuntimeError(f"cannot determine origin remote for {canonical}")

    candidate_roots: Set[Path] = {canonical}
    for search_root in search_roots or DEFAULT_SEARCH_ROOTS:
        candidate_roots.update(_walk_git_roots(search_root))

    independent: Set[Path] = set()
    for candidate in candidate_roots:
        top = repo_top(candidate)
        if not top or normalize_remote(repo_origin(top)) != fingerprint:
            continue
        dotgit = top / ".git"
        if dotgit.is_dir():
            independent.add(top)

    paths: Dict[Path, Dict[str, object]] = {}
    for clone_root in sorted(independent):
        listed = git_text(clone_root, ["worktree", "list", "--porcelain"])
        if listed is None:
            listed = f"worktree {clone_root}\n"
        for raw in parse_worktree_porcelain(listed):
            raw_path = raw.get("worktree")
            if not raw_path:
                continue
            path = resolved(Path(raw_path))
            paths[path] = {
                "path": path,
                "listedBy": clone_root,
                "listedHead": raw.get("HEAD"),
                "listedBranch": raw.get("branch"),
                "prunable": raw.get("prunable"),
            }

    # A matching independent clone with a broken worktree listing still belongs
    # in the roster.
    for clone_root in independent:
        paths.setdefault(clone_root, {"path": clone_root, "listedBy": clone_root})

    records: List[Dict[str, object]] = []
    for path in sorted(paths):
        base = paths[path]
        dotgit = path / ".git"
        if path == canonical:
            kind = "canonical"
        elif dotgit.is_file():
            kind = "worktree"
        elif dotgit.is_dir():
            kind = "clone"
        else:
            kind = "missing"
        base.update(
            {
                "kind": kind,
                "exists": path.is_dir(),
                "origin": repo_origin(path) if path.is_dir() else None,
                "originFingerprint": fingerprint,
                "commonDir": common_dir(path) if path.is_dir() else None,
            }
        )
        records.append(base)
    return records, fingerprint


def integration_ref(path: Path) -> Optional[str]:
    origin_head = git_text(path, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])
    candidates = [origin_head, "refs/remotes/origin/main", "refs/heads/main", "refs/remotes/origin/master", "refs/heads/master"]
    for candidate in candidates:
        if not candidate:
            continue
        exists = git(path, ["show-ref", "--verify", "--quiet", candidate])
        if exists.returncode == 0:
            return candidate
    return None


def refs_containing(path: Path, head: str) -> List[str]:
    output = git_text(
        path,
        [
            "for-each-ref",
            "--format=%(refname)",
            "--contains",
            head,
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ],
    )
    return sorted(line for line in (output or "").splitlines() if line and not line.endswith("/HEAD"))


def status_entries(path: Path, *, include_ignored: bool = False) -> Optional[List[Tuple[str, str]]]:
    args = ["status", "--porcelain=v1", "-z", "--untracked-files=all"]
    if include_ignored:
        args.append("--ignored=matching")
    result = git(path, args, text=False, timeout=120)
    if result.returncode != 0:
        return None
    chunks = result.stdout.split(b"\0")
    entries: List[Tuple[str, str]] = []
    index = 0
    while index < len(chunks):
        chunk = chunks[index]
        index += 1
        if not chunk:
            continue
        decoded = chunk.decode("utf-8", "surrogateescape")
        if len(decoded) < 4:
            continue
        code, name = decoded[:2], decoded[3:]
        entries.append((code, name))
        if "R" in code or "C" in code:
            index += 1
    return entries


def disk_free_bytes() -> Optional[int]:
    try:
        return os.statvfs(str(DATA_VOLUME)).f_bavail * os.statvfs(str(DATA_VOLUME)).f_frsize
    except OSError:
        return None


def du_kib(path: Path, *, timeout: int = 300) -> Optional[int]:
    result = run(["/usr/bin/du", "-sk", str(path)], timeout=timeout)
    if result.returncode not in (0, 1) or not result.stdout.strip():
        return None
    try:
        return int(result.stdout.split()[0])
    except (ValueError, IndexError):
        return None


def format_size(kib: Optional[int]) -> str:
    if kib is None:
        return "?"
    value = float(kib)
    for suffix in ("KiB", "MiB", "GiB", "TiB"):
        if value < 1024 or suffix == "TiB":
            return f"{value:.1f}{suffix}" if value < 10 else f"{value:.0f}{suffix}"
        value /= 1024
    return f"{value:.1f}TiB"


def _stat_mtime(path: Path) -> Optional[float]:
    try:
        return path.stat().st_mtime
    except OSError:
        return None


def approximate_last_touched(path: Path, status: Sequence[Tuple[str, str]]) -> Optional[float]:
    """Use Git activity, changed files, and derived-root mtimes without a huge tree walk."""

    candidates: List[float] = []
    common = common_dir(path)
    git_paths = [path, path / ".git"]
    for name in ("index", "logs/HEAD"):
        raw = git_text(path, ["rev-parse", "--git-path", name])
        if raw:
            candidate = Path(raw)
            if not candidate.is_absolute():
                candidate = path / candidate
            git_paths.append(candidate)
    # Do not use common-dir FETCH_HEAD: one clone-wide fetch would make every
    # sibling worktree look recently used. The per-worktree index/reflog and
    # changed/derived files are the useful activity signals here.
    for candidate in git_paths:
        mtime = _stat_mtime(candidate)
        if mtime is not None:
            candidates.append(mtime)
    for _, name in status:
        mtime = _stat_mtime(path / name)
        if mtime is not None:
            candidates.append(mtime)
    for derived in (
        path / "node_modules",
        path / "design" / "studio" / ".next",
        path / "design" / "studio" / ".next" / "dev" / "cache" / "turbopack",
        path / "apps" / "macos" / ".build",
        path / "packages" / "web" / "dist",
    ):
        mtime = _stat_mtime(derived)
        if mtime is not None:
            candidates.append(mtime)
    return max(candidates) if candidates else None


def process_ancestors(pid: Optional[int] = None) -> Set[int]:
    ancestors: Set[int] = set()
    current = pid or os.getpid()
    while current > 1 and current not in ancestors:
        ancestors.add(current)
        result = run(["ps", "-o", "ppid=", "-p", str(current)], timeout=5)
        try:
            current = int(result.stdout.strip())
        except (ValueError, AttributeError):
            break
    return ancestors


def active_processes(paths: Sequence[Path]) -> Dict[Path, List[Dict[str, object]]]:
    """Report processes whose cwd is inside a copy or whose command names it."""

    normalized = [resolved(path) for path in paths if path.exists()]
    result: Dict[Path, List[Dict[str, object]]] = {path: [] for path in normalized}
    excluded = process_ancestors()
    processes: Dict[int, Dict[str, object]] = {}

    lsof = run(["/usr/sbin/lsof", "-nP", "-a", "-d", "cwd", "-Fpn"], timeout=20)
    current_pid: Optional[int] = None
    for line in lsof.stdout.splitlines() if isinstance(lsof.stdout, str) else []:
        if line.startswith("p") and line[1:].isdigit():
            current_pid = int(line[1:])
        elif line.startswith("n") and current_pid is not None and current_pid not in excluded:
            processes.setdefault(current_pid, {})["cwd"] = line[1:]

    ps = run(["ps", "-axo", "pid=,command="], timeout=20)
    for line in ps.stdout.splitlines() if isinstance(ps.stdout, str) else []:
        match = re.match(r"\s*(\d+)\s+(.*)", line)
        if not match:
            continue
        pid = int(match.group(1))
        if pid in excluded:
            continue
        processes.setdefault(pid, {})["command"] = match.group(2)

    for pid, process in processes.items():
        cwd = process.get("cwd")
        command = str(process.get("command", ""))
        for path in normalized:
            inside = False
            if isinstance(cwd, str):
                inside = cwd == str(path) or cwd.startswith(str(path) + os.sep)
            named = str(path) in command
            if inside or named:
                item = {"pid": pid, "command": command or "?"}
                if item not in result[path]:
                    result[path].append(item)
    probe_errors = []
    if lsof.returncode != 0:
        probe_errors.append(f"lsof cwd probe exited {lsof.returncode}")
    if ps.returncode != 0:
        probe_errors.append(f"ps command probe exited {ps.returncode}")
    if probe_errors:
        # A failed liveness probe is uncertainty, never proof that a copy is
        # idle. Represent it as a blocker so every destructive caller fails
        # closed without needing a second interpretation layer.
        blocker = {"pid": None, "command": "; ".join(probe_errors), "probeError": True}
        for path in normalized:
            result[path].append(blocker)
    return result


def registry_key(path: Path) -> str:
    return hashlib.sha256(str(resolved(path)).encode()).hexdigest()[:20]


def registry_path(path: Path) -> Path:
    return REGISTRY_ROOT / f"{registry_key(path)}.json"


def load_registry() -> Dict[Path, Dict[str, object]]:
    registrations: Dict[Path, Dict[str, object]] = {}
    if not REGISTRY_ROOT.is_dir():
        return registrations
    for file in REGISTRY_ROOT.glob("*.json"):
        try:
            data = json.loads(file.read_text())
            raw_path = data.get("path")
            if isinstance(raw_path, str):
                data["registryFile"] = str(file)
                registrations[resolved(Path(raw_path))] = data
        except (OSError, json.JSONDecodeError):
            continue
    return registrations


def write_registration(path: Path, registration: Dict[str, object]) -> Path:
    REGISTRY_ROOT.mkdir(parents=True, exist_ok=True)
    destination = registry_path(path)
    temporary = destination.with_suffix(f".{os.getpid()}.tmp")
    temporary.write_text(json.dumps(registration, indent=2, sort_keys=True) + "\n")
    os.chmod(temporary, 0o600)
    os.replace(temporary, destination)
    return destination


def ignored_path_is_derived(name: str, root: Optional[Path] = None) -> bool:
    parts = Path(name.rstrip("/")).parts
    components = set(parts)
    if components & DERIVED_COMPONENTS:
        return True

    # Cargo build directories. ``target`` is far too ambiguous to allowlist by
    # name -- a hand-authored source directory may legitimately be called that
    # -- but Cargo stamps every build directory it owns with CACHEDIR.TAG, so
    # the tag is the evidence and the name alone never is. That check needs the
    # copy on disk, hence the optional root; without it we stay conservative
    # and treat the path as non-derived.
    if root is not None and "target" in components:
        candidate = root.joinpath(*parts[: parts.index("target") + 1])
        if (candidate / "CACHEDIR.TAG").is_file():
            return True

    # Keep repository-specific generated outputs narrow instead of globally
    # allowlisting ambiguous component names such as ``dist`` and ``out``.
    return (
        (len(parts) >= 3 and parts[0] in {"apps", "packages"} and parts[2] == "dist")
        or parts[:3] == ("landing", "openscout.app", "out")
        or parts == ("landing", "openscout.app", "next-env.d.ts")
        or parts == ("design", "studio", "next-env.d.ts")
        or parts == ("packages", "cli", "bin", "scoutd")
        or (parts and parts[-1].endswith(".tsbuildinfo"))
    )


def explain_safety(record: Dict[str, object], now: Optional[datetime] = None) -> Tuple[str, List[str]]:
    """Return a policy decision and all reasons, with safety winning over age."""

    now = now or utc_now()
    reasons: List[str] = []
    if record.get("kind") == "canonical":
        return "keep:canonical", ["canonical checkout is never reaped"]
    if not record.get("exists") or not record.get("head"):
        return "keep:invalid", ["worktree is missing or Git metadata is unreadable"]
    if record.get("dirty") is None:
        return "keep:unknown", ["could not prove the working tree is clean"]
    if record.get("dirty") is not False:
        return "keep:dirty", ["tracked or untracked work exists"]
    if record.get("orphanRisk") in {"high", "clone-local"}:
        return "keep:orphan", ["HEAD would not survive deletion outside this copy"]
    if record.get("mergedIntoMain") is not True:
        return "keep:unmerged", ["HEAD is not an ancestor of the observed origin main ref"]
    if not record.get("remoteRefsContaining"):
        return "keep:unreachable", ["no remote ref contains HEAD"]
    if record.get("unpushedCommits") is None:
        return "keep:unknown", ["could not prove the unpushed commit count"]
    if int(record.get("unpushedCommits") or 0) > 0:
        return "keep:unpushed", ["HEAD reaches commits absent from every remote ref"]
    if record.get("activeProcesses"):
        return "keep:active", ["a live process is using or naming this copy"]

    registration = record.get("registration")
    if not isinstance(registration, dict):
        return "review:unregistered", ["safe Git state, but no owner/lifetime registration"]
    state = registration.get("state")
    expires = parse_time(registration.get("expiresAt"))
    if state == "retire-requested":
        reasons.append("owner requested retirement after merge")
        return "reap:eligible", reasons
    if expires is None:
        return "review:no-expiry", ["registration has no parseable expiry"]
    if expires > now:
        return "keep:leased", [f"registered lifetime ends {isoformat(expires)}"]
    return "reap:eligible", [f"registered lifetime ended {isoformat(expires)}"]


def inspect_copy(base: Dict[str, object], registrations: Dict[Path, Dict[str, object]], active: Dict[Path, List[Dict[str, object]]]) -> Dict[str, object]:
    record = dict(base)
    path = record["path"]
    assert isinstance(path, Path)
    record["path"] = path
    record["registration"] = registrations.get(path)
    record["activeProcesses"] = active.get(path, [])
    if not record.get("exists"):
        record.update(
            {
                "head": record.get("listedHead"),
                "branch": record.get("listedBranch"),
                "dirty": None,
                "mergedIntoMain": None,
                "mainRef": None,
                "unpushedCommits": None,
                "refsContaining": [],
                "remoteRefsContaining": [],
                "orphanRisk": "unknown",
                "lastTouched": None,
            }
        )
        record["decision"], record["decisionReasons"] = explain_safety(record)
        return record

    index_raw = git_text(path, ["rev-parse", "--git-path", "index"])
    index_mtime = None
    if index_raw:
        index_path = Path(index_raw)
        if not index_path.is_absolute():
            index_path = path / index_path
        index_mtime = _stat_mtime(index_path)

    head = git_text(path, ["rev-parse", "HEAD"])
    branch = git_text(path, ["symbolic-ref", "--quiet", "--short", "HEAD"])
    status = status_entries(path)
    refs = refs_containing(path, head) if head else []
    remote_refs = [ref for ref in refs if ref.startswith("refs/remotes/")]
    main_ref = integration_ref(path)
    merged: Optional[bool] = None
    if head and main_ref:
        merged = git(path, ["merge-base", "--is-ancestor", head, main_ref]).returncode == 0
    unpushed: Optional[int] = None
    if head:
        output = git_text(path, ["rev-list", "--count", head, "--not", "--remotes"])
        try:
            unpushed = int(output) if output is not None else None
        except ValueError:
            unpushed = None

    if not head:
        orphan = "unknown"
    elif not branch and not refs:
        orphan = "high"
    elif record.get("kind") == "clone" and not remote_refs:
        orphan = "clone-local"
    else:
        orphan = "none"

    last_touched = approximate_last_touched(path, status or [])
    if index_mtime is not None:
        last_touched = max(last_touched or 0, index_mtime)
    record.update(
        {
            "head": head,
            "branch": branch,
            "detached": branch is None,
            "dirty": bool(status) if status is not None else None,
            "statusCount": len(status) if status is not None else None,
            "mergedIntoMain": merged,
            "mainRef": main_ref,
            "unpushedCommits": unpushed,
            "refsContaining": refs,
            "remoteRefsContaining": remote_refs,
            "orphanRisk": orphan,
            "lastTouched": last_touched,
        }
    )
    record["decision"], record["decisionReasons"] = explain_safety(record)
    return record


def json_safe(value: object) -> object:
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, datetime):
        return isoformat(value)
    if isinstance(value, dict):
        return {str(key): json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    return value
