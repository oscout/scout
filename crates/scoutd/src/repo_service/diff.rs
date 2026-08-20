//! `openscout-repo-service diff` — bounded raw Git diff facts for a single
//! worktree. See `docs/archive/eng/sco-065-repo-diff-viewer.md`.
//!
//! Rust is authoritative for path, layer, mode, rename, binary, and status
//! facts. It emits Git-compatible patch text (`git diff -p` with stable
//! options) plus normalized file/hunk summaries. The renderer (web Pierre
//! Diffs / native) may re-parse the patch for display, but trusts these facts
//! for navigation, filtering, and caching.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::time::{Duration, Instant};

use super::{git_capture, normalize_path, now_ms, DiagnosticLevel};

const DEFAULT_MAX_PATCH_BYTES: usize = 2_000_000;
const DEFAULT_MAX_FILES: usize = 500;
const DEFAULT_MAX_HUNKS_PER_FILE: usize = 300;
const DEFAULT_MAX_LINES_PER_HUNK: usize = 5_000;
const DEFAULT_TIMEOUT_MS: u64 = 15_000;
const CONTEXT_FLAG: &str = "-U3";

// ── Request ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoDiffRequest {
    #[allow(dead_code)]
    #[serde(default)]
    pub schema: Option<String>,
    pub worktree_path: String,
    #[serde(default)]
    pub layers: Option<Vec<RepoDiffLayerKind>>,
    #[serde(default)]
    pub base_ref: Option<String>,
    #[serde(default)]
    pub compare_ref: Option<String>,
    #[serde(default)]
    pub paths: Vec<String>,
    #[serde(default)]
    pub limits: DiffLimits,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RepoDiffLayerKind {
    Unstaged,
    Staged,
    Branch,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLimits {
    #[serde(default = "default_max_patch_bytes")]
    pub max_patch_bytes: usize,
    #[serde(default = "default_max_files")]
    pub max_files: usize,
    #[serde(default = "default_max_hunks_per_file")]
    pub max_hunks_per_file: usize,
    #[serde(default = "default_max_lines_per_hunk")]
    pub max_lines_per_hunk: usize,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
    #[serde(default = "default_true")]
    pub include_raw_patch: bool,
    #[serde(default = "default_true")]
    pub include_parsed_hunks: bool,
    #[serde(default = "default_true")]
    pub include_binary_patch: bool,
}

impl Default for DiffLimits {
    fn default() -> Self {
        Self {
            max_patch_bytes: DEFAULT_MAX_PATCH_BYTES,
            max_files: DEFAULT_MAX_FILES,
            max_hunks_per_file: DEFAULT_MAX_HUNKS_PER_FILE,
            max_lines_per_hunk: DEFAULT_MAX_LINES_PER_HUNK,
            timeout_ms: DEFAULT_TIMEOUT_MS,
            include_raw_patch: true,
            include_parsed_hunks: true,
            include_binary_patch: true,
        }
    }
}

fn default_max_patch_bytes() -> usize {
    DEFAULT_MAX_PATCH_BYTES
}
fn default_max_files() -> usize {
    DEFAULT_MAX_FILES
}
fn default_max_hunks_per_file() -> usize {
    DEFAULT_MAX_HUNKS_PER_FILE
}
fn default_max_lines_per_hunk() -> usize {
    DEFAULT_MAX_LINES_PER_HUNK
}
fn default_timeout_ms() -> u64 {
    DEFAULT_TIMEOUT_MS
}
fn default_true() -> bool {
    true
}

// ── Response ─────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoDiffResponse {
    pub schema: &'static str,
    pub generated_at: u64,
    pub worktree_path: String,
    pub layers: Vec<RepoDiffLayer>,
    pub coverage: RepoDiffCoverage,
    pub diagnostics: Vec<RepoDiffDiagnostic>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoDiffLayer {
    pub kind: RepoDiffLayerKind,
    pub base_label: Option<String>,
    pub compare_label: Option<String>,
    pub command: Vec<String>,
    pub patch_oid: String,
    pub raw_patch: Option<String>,
    pub raw_patch_bytes: usize,
    pub truncated: bool,
    pub files: Vec<RepoDiffFile>,
    pub shortstat: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoDiffFile {
    pub old_path: Option<String>,
    pub new_path: Option<String>,
    pub status: RepoDiffFileStatus,
    pub old_oid: Option<String>,
    pub new_oid: Option<String>,
    pub old_mode: Option<String>,
    pub new_mode: Option<String>,
    pub similarity: Option<u32>,
    pub binary: bool,
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
    pub hunks: Vec<RepoDiffHunk>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RepoDiffFileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    Typechange,
    Conflict,
    Unknown,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoDiffHunk {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub section: Option<String>,
    pub additions: u32,
    pub deletions: u32,
    pub truncated: bool,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoDiffCoverage {
    pub requested_layers: usize,
    pub emitted_layers: usize,
    pub files: usize,
    pub patch_bytes: usize,
    pub truncated_layers: usize,
    pub scan_budget_reached: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoDiffDiagnostic {
    pub level: DiagnosticLevel,
    pub kind: String,
    pub message: String,
    pub path: Option<String>,
}

// ── Entry point ──────────────────────────────────────────────────────────

pub fn diff(request: RepoDiffRequest) -> RepoDiffResponse {
    let generated_at = now_ms();
    let worktree = normalize_path(&request.worktree_path);
    let worktree_path = worktree.display().to_string();
    let timeout = Duration::from_millis(request.limits.timeout_ms.max(1));
    let mut diagnostics: Vec<RepoDiffDiagnostic> = Vec::new();

    let layer_kinds = request
        .layers
        .clone()
        .filter(|layers| !layers.is_empty())
        .unwrap_or_else(|| vec![RepoDiffLayerKind::Unstaged, RepoDiffLayerKind::Staged]);

    let mut coverage = RepoDiffCoverage {
        requested_layers: layer_kinds.len(),
        ..RepoDiffCoverage::default()
    };

    if !is_inside_work_tree(&worktree, timeout) {
        diagnostics.push(RepoDiffDiagnostic {
            level: DiagnosticLevel::Warning,
            kind: "not_a_git_worktree".to_string(),
            message: "Path does not resolve to a Git worktree.".to_string(),
            path: Some(worktree_path.clone()),
        });
        return RepoDiffResponse {
            schema: "openscout.repo.diff/v1",
            generated_at,
            worktree_path,
            layers: Vec::new(),
            coverage,
            diagnostics,
        };
    }

    let started = Instant::now();
    // Soft overall budget: one command timeout per requested layer, plus a
    // little slack for the worktree probe. Bounds total wall time when many
    // layers are requested or Git is slow.
    let overall_budget = timeout.saturating_mul(layer_kinds.len().max(1) as u32 + 1);

    let mut layers = Vec::new();
    for kind in &layer_kinds {
        if started.elapsed() >= overall_budget {
            coverage.scan_budget_reached = true;
            diagnostics.push(RepoDiffDiagnostic {
                level: DiagnosticLevel::Warning,
                kind: "diff_budget".to_string(),
                message: "Diff stopped after reaching the time budget.".to_string(),
                path: None,
            });
            break;
        }
        if let Some(layer) = build_layer(&worktree, *kind, &request, timeout, &mut diagnostics) {
            coverage.emitted_layers += 1;
            coverage.files += layer.files.len();
            coverage.patch_bytes += layer.raw_patch_bytes;
            if layer.truncated {
                coverage.truncated_layers += 1;
            }
            layers.push(layer);
        }
    }

    RepoDiffResponse {
        schema: "openscout.repo.diff/v1",
        generated_at,
        worktree_path,
        layers,
        coverage,
        diagnostics,
    }
}

fn is_inside_work_tree(worktree: &Path, timeout: Duration) -> bool {
    git_capture(worktree, &["rev-parse", "--is-inside-work-tree"], timeout)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .map(|value| value.trim() == "true")
        .unwrap_or(false)
}

fn build_layer(
    worktree: &Path,
    kind: RepoDiffLayerKind,
    request: &RepoDiffRequest,
    timeout: Duration,
    diagnostics: &mut Vec<RepoDiffDiagnostic>,
) -> Option<RepoDiffLayer> {
    // The "selector" is the layer-defining prefix of every git invocation for
    // this layer: `diff` (unstaged), `diff --cached` (staged), or
    // `diff <base> [compare]` (branch). Rust never infers branch refs.
    let mut selector: Vec<String> = vec!["diff".to_string()];
    let (base_label, compare_label) = match kind {
        RepoDiffLayerKind::Unstaged => {
            (Some("index".to_string()), Some("working tree".to_string()))
        }
        RepoDiffLayerKind::Staged => {
            selector.push("--cached".to_string());
            (Some("HEAD".to_string()), Some("index".to_string()))
        }
        RepoDiffLayerKind::Branch => {
            let base = request
                .base_ref
                .as_deref()
                .filter(|value| !value.is_empty());
            let Some(base) = base else {
                diagnostics.push(RepoDiffDiagnostic {
                    level: DiagnosticLevel::Warning,
                    kind: "branch_refs_missing".to_string(),
                    message: "Branch layer requires baseRef (and usually compareRef); TypeScript must supply them.".to_string(),
                    path: None,
                });
                return None;
            };
            selector.push(base.to_string());
            let compare = request
                .compare_ref
                .as_deref()
                .filter(|value| !value.is_empty());
            if let Some(compare) = compare {
                selector.push(compare.to_string());
            }
            (
                Some(base.to_string()),
                Some(compare.unwrap_or("working tree").to_string()),
            )
        }
    };

    let path_args: Vec<String> = if request.paths.is_empty() {
        Vec::new()
    } else {
        let mut args = vec!["--".to_string()];
        args.extend(request.paths.iter().cloned());
        args
    };

    let limits = &request.limits;

    // Authoritative file identity / status / modes / rename / binary facts.
    let raw_bytes = run_git(
        worktree,
        &build_args(&selector, &["--raw", "-z"], &path_args),
        timeout,
        diagnostics,
    )
    .unwrap_or_default();
    let numstat_bytes = run_git(
        worktree,
        &build_args(&selector, &["--numstat", "-z"], &path_args),
        timeout,
        diagnostics,
    )
    .unwrap_or_default();
    let shortstat = run_git(
        worktree,
        &build_args(&selector, &["--shortstat"], &path_args),
        timeout,
        diagnostics,
    )
    .and_then(|bytes| String::from_utf8(bytes).ok())
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty());

    let mut files = parse_files(&raw_bytes, &numstat_bytes);

    // Canonical patch command (used for the patch text, the response
    // `command` field, and the patchOid identity hash).
    let mut patch_flags: Vec<&str> = vec![
        "--no-color",
        "--no-ext-diff",
        "--default-prefix",
        "--full-index",
    ];
    if limits.include_binary_patch {
        patch_flags.push("--binary");
    }
    patch_flags.push(CONTEXT_FLAG);
    let patch_args = build_args(&selector, &patch_flags, &path_args);
    let command: Vec<String> = std::iter::once("git".to_string())
        .chain(patch_args.iter().cloned())
        .collect();

    let want_patch = limits.include_raw_patch || limits.include_parsed_hunks;
    let mut full_patch_bytes = 0usize;
    let mut patch_text: Option<String> = None;
    let mut raw_patch: Option<String> = None;
    let mut truncated = false;

    if want_patch {
        if let Some(bytes) = run_git(worktree, &patch_args, timeout, diagnostics) {
            full_patch_bytes = bytes.len();
            let text = String::from_utf8_lossy(&bytes).into_owned();
            if limits.include_parsed_hunks {
                attach_hunks(&mut files, &text, limits);
            }
            if limits.include_raw_patch {
                if full_patch_bytes > limits.max_patch_bytes {
                    truncated = true;
                    raw_patch = Some(truncate_patch(&text, limits.max_patch_bytes));
                    diagnostics.push(RepoDiffDiagnostic {
                        level: DiagnosticLevel::Warning,
                        kind: "patch_truncated".to_string(),
                        message: format!(
                            "Patch text truncated to {} of {} bytes.",
                            limits.max_patch_bytes, full_patch_bytes
                        ),
                        path: None,
                    });
                } else {
                    raw_patch = Some(text.clone());
                }
            }
            patch_text = Some(text);
        }
    }

    if files.len() > limits.max_files {
        truncated = true;
        diagnostics.push(RepoDiffDiagnostic {
            level: DiagnosticLevel::Warning,
            kind: "files_truncated".to_string(),
            message: format!(
                "Diff limited to {} of {} files.",
                limits.max_files,
                files.len()
            ),
            path: None,
        });
        files.truncate(limits.max_files);
    }

    let patch_oid = if let Some(text) = patch_text.as_deref() {
        fnv1a_128_hex(&command, text.as_bytes())
    } else {
        let mut identity = Vec::new();
        identity.extend_from_slice(&raw_bytes);
        identity.push(0);
        identity.extend_from_slice(&numstat_bytes);
        identity.push(0);
        if let Some(shortstat) = shortstat.as_deref() {
            identity.extend_from_slice(shortstat.as_bytes());
        }
        fnv1a_128_hex(&command, &identity)
    };

    Some(RepoDiffLayer {
        kind,
        base_label,
        compare_label,
        command,
        patch_oid,
        raw_patch,
        raw_patch_bytes: full_patch_bytes,
        truncated,
        files,
        shortstat,
    })
}

fn build_args(selector: &[String], flags: &[&str], paths: &[String]) -> Vec<String> {
    let mut args = selector.to_vec();
    args.extend(flags.iter().map(|flag| flag.to_string()));
    args.extend(paths.iter().cloned());
    args
}

fn run_git(
    worktree: &Path,
    args: &[String],
    timeout: Duration,
    diagnostics: &mut Vec<RepoDiffDiagnostic>,
) -> Option<Vec<u8>> {
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    match git_capture(worktree, &arg_refs, timeout) {
        Ok(bytes) => Some(bytes),
        Err(error) => {
            diagnostics.push(RepoDiffDiagnostic {
                level: DiagnosticLevel::Warning,
                kind: "git_failed".to_string(),
                message: format!("git {} failed: {error}", arg_refs.join(" ")),
                path: None,
            });
            None
        }
    }
}

// ── Parsers ──────────────────────────────────────────────────────────────

struct RawEntry {
    status: RepoDiffFileStatus,
    old_mode: Option<String>,
    new_mode: Option<String>,
    old_oid: Option<String>,
    new_oid: Option<String>,
    similarity: Option<u32>,
    old_path: Option<String>,
    new_path: Option<String>,
}

/// Parse `git diff --raw -z`. Each record is a metadata field
/// `:<srcmode> <dstmode> <srcsha> <dstsha> <status>` followed by NUL and one
/// path (two paths for rename/copy).
fn parse_raw_z(bytes: &[u8]) -> Vec<RawEntry> {
    let text = String::from_utf8_lossy(bytes);
    let tokens: Vec<&str> = text.split('\0').collect();
    let mut entries = Vec::new();
    let mut i = 0;
    while i < tokens.len() {
        let meta = tokens[i];
        if !meta.starts_with(':') {
            i += 1;
            continue;
        }
        let fields: Vec<&str> = meta[1..].split_whitespace().collect();
        if fields.len() < 5 {
            i += 1;
            continue;
        }
        let old_mode = fields[0];
        let new_mode = fields[1];
        let old_oid = fields[2];
        let new_oid = fields[3];
        let status_field = fields[4];
        let letter = status_field.chars().next().unwrap_or('X');
        let similarity = status_field
            .get(1..)
            .and_then(|rest| rest.parse::<u32>().ok());
        let (status, two_paths) = match letter {
            'A' => (RepoDiffFileStatus::Added, false),
            'D' => (RepoDiffFileStatus::Deleted, false),
            'M' => (RepoDiffFileStatus::Modified, false),
            'T' => (RepoDiffFileStatus::Typechange, false),
            'R' => (RepoDiffFileStatus::Renamed, true),
            'C' => (RepoDiffFileStatus::Copied, true),
            'U' => (RepoDiffFileStatus::Conflict, false),
            _ => (RepoDiffFileStatus::Unknown, false),
        };
        i += 1;
        let (old_path, new_path) = if two_paths {
            let old = tokens.get(i).copied().unwrap_or_default();
            let new = tokens.get(i + 1).copied().unwrap_or_default();
            i += 2;
            (Some(old.to_string()), Some(new.to_string()))
        } else {
            let path = tokens.get(i).copied().unwrap_or_default();
            i += 1;
            match letter {
                'A' => (None, Some(path.to_string())),
                'D' => (Some(path.to_string()), None),
                _ => (Some(path.to_string()), Some(path.to_string())),
            }
        };
        entries.push(RawEntry {
            status,
            old_mode: mode_opt(old_mode),
            new_mode: mode_opt(new_mode),
            old_oid: oid_opt(old_oid),
            new_oid: oid_opt(new_oid),
            similarity: if two_paths { similarity } else { None },
            old_path,
            new_path,
        });
    }
    entries
}

fn mode_opt(mode: &str) -> Option<String> {
    if mode.is_empty() || mode.chars().all(|c| c == '0') {
        None
    } else {
        Some(mode.to_string())
    }
}

fn oid_opt(oid: &str) -> Option<String> {
    if oid.is_empty() || oid.chars().all(|c| c == '0') {
        None
    } else {
        Some(oid.to_string())
    }
}

struct NumEntry {
    additions: Option<u64>,
    deletions: Option<u64>,
    binary: bool,
}

/// Parse `git diff --numstat -z`, keyed by post-image path. Records are
/// `<add>\t<del>\t<path>` and NUL-terminated; rename/copy records put an empty
/// path after the second tab and emit `<old>` and `<new>` as the next two
/// NUL fields. Binary files use `-` for both counts.
fn parse_numstat_z(bytes: &[u8]) -> HashMap<String, NumEntry> {
    let text = String::from_utf8_lossy(bytes);
    let tokens: Vec<&str> = text.split('\0').collect();
    let mut map = HashMap::new();
    let mut i = 0;
    while i < tokens.len() {
        let head = tokens[i];
        if head.is_empty() {
            i += 1;
            continue;
        }
        let parts: Vec<&str> = head.splitn(3, '\t').collect();
        if parts.len() < 3 {
            i += 1;
            continue;
        }
        let add = parts[0];
        let del = parts[1];
        let path_part = parts[2];
        let binary = add == "-" || del == "-";
        let additions = if binary {
            None
        } else {
            add.parse::<u64>().ok()
        };
        let deletions = if binary {
            None
        } else {
            del.parse::<u64>().ok()
        };
        let key = if path_part.is_empty() {
            // rename/copy: next two NUL fields are old, new.
            let new = tokens.get(i + 2).copied().unwrap_or_default();
            i += 3;
            new.to_string()
        } else {
            i += 1;
            path_part.to_string()
        };
        map.insert(
            key,
            NumEntry {
                additions,
                deletions,
                binary,
            },
        );
    }
    map
}

fn parse_files(raw: &[u8], numstat: &[u8]) -> Vec<RepoDiffFile> {
    let entries = parse_raw_z(raw);
    let numstat = parse_numstat_z(numstat);
    entries
        .into_iter()
        .map(|entry| {
            let key = entry
                .new_path
                .clone()
                .or_else(|| entry.old_path.clone())
                .unwrap_or_default();
            let stat = numstat.get(&key);
            let binary = stat.map(|s| s.binary).unwrap_or(false);
            RepoDiffFile {
                old_path: entry.old_path,
                new_path: entry.new_path,
                status: entry.status,
                old_oid: entry.old_oid,
                new_oid: entry.new_oid,
                old_mode: entry.old_mode,
                new_mode: entry.new_mode,
                similarity: entry.similarity,
                binary,
                additions: stat.and_then(|s| s.additions),
                deletions: stat.and_then(|s| s.deletions),
                hunks: Vec::new(),
                truncated: false,
            }
        })
        .collect()
}

/// Attach parsed hunk summaries to files by walking the unified patch. Files
/// are matched to the authoritative list by post-image (`+++ b/…`) or
/// pre-image (`--- a/…`) path. Patch text uses the stable `a/` `b/` prefixes
/// from `--default-prefix`.
fn attach_hunks(files: &mut [RepoDiffFile], patch: &str, limits: &DiffLimits) {
    let mut index: HashMap<String, usize> = HashMap::new();
    for (idx, file) in files.iter().enumerate() {
        if let Some(path) = &file.new_path {
            index.entry(path.clone()).or_insert(idx);
        }
        if let Some(path) = &file.old_path {
            index.entry(path.clone()).or_insert(idx);
        }
    }

    let mut current: Option<usize> = None;
    let mut pending_old: Option<String> = None;
    let mut hunk: Option<RepoDiffHunk> = None;
    let mut changed = 0usize;

    for line in patch.split('\n') {
        if line.starts_with("diff --git ") {
            flush_hunk(files, current, &mut hunk, limits.max_hunks_per_file);
            current = None;
            pending_old = None;
            continue;
        }
        if let Some(rest) = line.strip_prefix("--- ") {
            pending_old = header_path(rest, "a/");
            continue;
        }
        if let Some(rest) = line.strip_prefix("+++ ") {
            flush_hunk(files, current, &mut hunk, limits.max_hunks_per_file);
            let new_path = header_path(rest, "b/");
            current = new_path
                .as_ref()
                .and_then(|path| index.get(path).copied())
                .or_else(|| {
                    pending_old
                        .as_ref()
                        .and_then(|path| index.get(path).copied())
                });
            continue;
        }
        if line.starts_with("@@") {
            flush_hunk(files, current, &mut hunk, limits.max_hunks_per_file);
            hunk = parse_hunk_header(line);
            changed = 0;
            continue;
        }
        if let Some(active) = hunk.as_mut() {
            match line.as_bytes().first() {
                Some(b'\\') => {} // "\ No newline at end of file"
                Some(b'+') => {
                    active.additions += 1;
                    changed += 1;
                }
                Some(b'-') => {
                    active.deletions += 1;
                    changed += 1;
                }
                _ => {}
            }
            if changed > limits.max_lines_per_hunk {
                active.truncated = true;
            }
        }
    }
    flush_hunk(files, current, &mut hunk, limits.max_hunks_per_file);
}

fn flush_hunk(
    files: &mut [RepoDiffFile],
    current: Option<usize>,
    hunk: &mut Option<RepoDiffHunk>,
    max_hunks: usize,
) {
    if let (Some(idx), Some(parsed)) = (current, hunk.take()) {
        let file = &mut files[idx];
        if file.hunks.len() < max_hunks {
            file.hunks.push(parsed);
        } else {
            file.truncated = true;
        }
    }
}

/// Strip a diff-header path: drop the `a/`/`b/` prefix, treat `/dev/null` as
/// absent. Does not attempt to unquote C-quoted exotic paths; those simply
/// fail to match and the file is reported without hunks.
fn header_path(rest: &str, prefix: &str) -> Option<String> {
    let value = rest.split('\t').next().unwrap_or(rest).trim_end();
    if value == "/dev/null" || value.is_empty() {
        return None;
    }
    Some(value.strip_prefix(prefix).unwrap_or(value).to_string())
}

fn parse_hunk_header(line: &str) -> Option<RepoDiffHunk> {
    let rest = line.strip_prefix("@@ ")?;
    let end = rest.find(" @@")?;
    let ranges = &rest[..end];
    let section = rest[end + 3..].trim();
    let mut parts = ranges.split(' ');
    let old = parts.next()?.strip_prefix('-')?;
    let new = parts.next()?.strip_prefix('+')?;
    let (old_start, old_lines) = parse_range(old);
    let (new_start, new_lines) = parse_range(new);
    Some(RepoDiffHunk {
        old_start,
        old_lines,
        new_start,
        new_lines,
        section: if section.is_empty() {
            None
        } else {
            Some(section.to_string())
        },
        additions: 0,
        deletions: 0,
        truncated: false,
    })
}

fn parse_range(value: &str) -> (u32, u32) {
    let mut parts = value.split(',');
    let start = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    let lines = parts.next().and_then(|v| v.parse().ok()).unwrap_or(1);
    (start, lines)
}

fn truncate_patch(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut cut = max;
    while cut > 0 && !text.is_char_boundary(cut) {
        cut -= 1;
    }
    let slice = &text[..cut];
    match slice.rfind('\n') {
        Some(newline) => text[..=newline].to_string(),
        None => slice.to_string(),
    }
}

/// FNV-1a (128-bit) over the layer command identity and patch bytes. This is a
/// stable content hash for cache keys, not a Git object id.
fn fnv1a_128_hex(command: &[String], patch: &[u8]) -> String {
    const OFFSET: u128 = 0x6c62272e07bb014262b821756295c58d;
    const PRIME: u128 = 0x0000000001000000000000000000013B;
    let mut hash = OFFSET;
    for (i, part) in command.iter().enumerate() {
        if i > 0 {
            hash = fnv_byte(hash, b' ', PRIME);
        }
        for byte in part.as_bytes() {
            hash = fnv_byte(hash, *byte, PRIME);
        }
    }
    hash = fnv_byte(hash, 0, PRIME);
    for byte in patch {
        hash = fnv_byte(hash, *byte, PRIME);
    }
    format!("{hash:032x}")
}

#[inline]
fn fnv_byte(hash: u128, byte: u8, prime: u128) -> u128 {
    (hash ^ byte as u128).wrapping_mul(prime)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;

    #[test]
    fn parses_raw_z_added_deleted_renamed() {
        // Verbatim shape from `git diff --cached --raw -z`.
        let raw = ":000000 100644 0000000 d5a09df A\0added.txt\0\
                   :100644 000000 72943a1 0000000 D\0del.txt\0\
                   :100644 100644 a0a295f a0a295f R100\0ren.txt\0renamed.txt\0";
        let entries = parse_raw_z(raw.as_bytes());
        assert_eq!(entries.len(), 3);

        assert_eq!(entries[0].status, RepoDiffFileStatus::Added);
        assert_eq!(entries[0].old_path, None);
        assert_eq!(entries[0].new_path.as_deref(), Some("added.txt"));
        assert_eq!(entries[0].old_mode, None);
        assert_eq!(entries[0].new_mode.as_deref(), Some("100644"));

        assert_eq!(entries[1].status, RepoDiffFileStatus::Deleted);
        assert_eq!(entries[1].old_path.as_deref(), Some("del.txt"));
        assert_eq!(entries[1].new_path, None);

        assert_eq!(entries[2].status, RepoDiffFileStatus::Renamed);
        assert_eq!(entries[2].old_path.as_deref(), Some("ren.txt"));
        assert_eq!(entries[2].new_path.as_deref(), Some("renamed.txt"));
        assert_eq!(entries[2].similarity, Some(100));
    }

    #[test]
    fn parses_numstat_z_with_rename_and_binary() {
        let numstat = "1\t0\tadded.txt\0\
                       0\t1\tdel.txt\0\
                       0\t0\t\0ren.txt\0renamed.txt\0\
                       -\t-\tbin.dat\0";
        let map = parse_numstat_z(numstat.as_bytes());
        assert_eq!(map.get("added.txt").unwrap().additions, Some(1));
        assert_eq!(map.get("del.txt").unwrap().deletions, Some(1));
        let renamed = map.get("renamed.txt").unwrap();
        assert_eq!(renamed.additions, Some(0));
        assert_eq!(renamed.deletions, Some(0));
        let bin = map.get("bin.dat").unwrap();
        assert!(bin.binary);
        assert_eq!(bin.additions, None);
        assert_eq!(bin.deletions, None);
    }

    #[test]
    fn attaches_hunks_from_patch() {
        let mut files = vec![RepoDiffFile {
            old_path: Some("src/index.ts".to_string()),
            new_path: Some("src/index.ts".to_string()),
            status: RepoDiffFileStatus::Modified,
            old_oid: None,
            new_oid: None,
            old_mode: Some("100644".to_string()),
            new_mode: Some("100644".to_string()),
            similarity: None,
            binary: false,
            additions: Some(2),
            deletions: Some(1),
            hunks: Vec::new(),
            truncated: false,
        }];
        let patch = "diff --git a/src/index.ts b/src/index.ts\n\
                     index 111..222 100644\n\
                     --- a/src/index.ts\n\
                     +++ b/src/index.ts\n\
                     @@ -1,3 +1,4 @@ export function main() {\n\
                     context line\n\
                     -removed\n\
                     +added one\n\
                     +added two\n\
                     context tail\n";
        attach_hunks(&mut files, patch, &DiffLimits::default());
        assert_eq!(files[0].hunks.len(), 1);
        let hunk = &files[0].hunks[0];
        assert_eq!(hunk.old_start, 1);
        assert_eq!(hunk.old_lines, 3);
        assert_eq!(hunk.new_start, 1);
        assert_eq!(hunk.new_lines, 4);
        assert_eq!(hunk.section.as_deref(), Some("export function main() {"));
        assert_eq!(hunk.additions, 2);
        assert_eq!(hunk.deletions, 1);
    }

    #[test]
    fn patch_oid_is_stable_and_content_sensitive() {
        let command = vec!["git".to_string(), "diff".to_string()];
        let a = fnv1a_128_hex(&command, b"patch body");
        let b = fnv1a_128_hex(&command, b"patch body");
        let c = fnv1a_128_hex(&command, b"different");
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_eq!(a.len(), 32);
    }

    #[test]
    fn diffs_staged_and_unstaged_layers() {
        let root = temp_dir("openscout-repo-diff-test");
        fs::create_dir_all(&root).unwrap();
        run_git(&root, &["init", "-b", "main"]);
        // Baseline commit.
        fs::write(root.join("mod.txt"), "one\ntwo\nthree\n").unwrap();
        fs::write(root.join("del.txt"), "bye\n").unwrap();
        fs::write(root.join("ren.txt"), "rename me\nsecond\n").unwrap();
        fs::write(root.join("bin.dat"), [0u8, 1, 2, 3, 0, 9]).unwrap();
        run_git(&root, &["add", "-A"]);
        commit(&root, "init");

        // Staged: a new file, a delete, and a rename.
        fs::write(root.join("added.txt"), "fresh\n").unwrap();
        run_git(&root, &["add", "added.txt"]);
        run_git(&root, &["rm", "del.txt"]);
        run_git(&root, &["mv", "ren.txt", "renamed.txt"]);
        // Unstaged: a modification and a binary change.
        fs::write(root.join("mod.txt"), "one\nTWO\nthree\nfour\n").unwrap();
        fs::write(root.join("bin.dat"), [9u8, 9, 9, 0, 1]).unwrap();

        let response = diff(RepoDiffRequest {
            schema: None,
            worktree_path: root.display().to_string(),
            layers: None,
            base_ref: None,
            compare_ref: None,
            paths: Vec::new(),
            limits: DiffLimits::default(),
        });

        assert_eq!(response.schema, "openscout.repo.diff/v1");
        assert_eq!(response.layers.len(), 2);
        assert_eq!(response.coverage.emitted_layers, 2);

        let unstaged = layer(&response, RepoDiffLayerKind::Unstaged);
        let modified = file_by_new(unstaged, "mod.txt").expect("mod.txt in unstaged");
        assert_eq!(modified.status, RepoDiffFileStatus::Modified);
        assert_eq!(modified.additions, Some(2));
        assert_eq!(modified.deletions, Some(1));
        assert_eq!(modified.new_mode.as_deref(), Some("100644"));
        assert!(!modified.hunks.is_empty());
        let binary = file_by_new(unstaged, "bin.dat").expect("bin.dat in unstaged");
        assert!(binary.binary);
        assert!(binary.hunks.is_empty());
        assert!(unstaged.raw_patch.as_ref().unwrap().contains("diff --git"));

        let staged = layer(&response, RepoDiffLayerKind::Staged);
        let added = file_by_new(staged, "added.txt").expect("added.txt staged");
        assert_eq!(added.status, RepoDiffFileStatus::Added);
        assert_eq!(added.old_path, None);
        let deleted = staged
            .files
            .iter()
            .find(|f| f.old_path.as_deref() == Some("del.txt"))
            .expect("del.txt staged");
        assert_eq!(deleted.status, RepoDiffFileStatus::Deleted);
        assert_eq!(deleted.new_path, None);
        let renamed = file_by_new(staged, "renamed.txt").expect("renamed.txt staged");
        assert_eq!(renamed.status, RepoDiffFileStatus::Renamed);
        assert_eq!(renamed.old_path.as_deref(), Some("ren.txt"));
        assert_eq!(renamed.similarity, Some(100));

        assert!(!staged.patch_oid.is_empty());
        assert_ne!(unstaged.patch_oid, staged.patch_oid);

        let _ = fs::remove_dir_all(root);
    }

    fn layer(response: &RepoDiffResponse, kind: RepoDiffLayerKind) -> &RepoDiffLayer {
        response
            .layers
            .iter()
            .find(|layer| layer.kind == kind)
            .unwrap_or_else(|| panic!("missing {kind:?} layer"))
    }

    fn file_by_new<'a>(layer: &'a RepoDiffLayer, path: &str) -> Option<&'a RepoDiffFile> {
        layer
            .files
            .iter()
            .find(|file| file.new_path.as_deref() == Some(path))
    }

    fn temp_dir(prefix: &str) -> PathBuf {
        let mut base = std::env::temp_dir();
        base.push(format!("{prefix}-{}-{}", std::process::id(), now_ms()));
        base
    }

    fn run_git(cwd: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn commit(cwd: &Path, message: &str) {
        run_git(
            cwd,
            &[
                "-c",
                "user.email=scout@example.test",
                "-c",
                "user.name=Scout",
                "commit",
                "-m",
                message,
            ],
        );
    }
}
