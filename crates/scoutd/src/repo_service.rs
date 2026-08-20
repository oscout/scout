use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub mod diff;

pub fn run_cli_from_env() -> Result<(), String> {
    let command = env::args().nth(1).unwrap_or_else(|| "scan".to_string());
    match command.as_str() {
        "scan" | "diff" => {
            let mut input = String::new();
            io::stdin()
                .read_to_string(&mut input)
                .map_err(|error| error.to_string())?;
            let output = run_command_json(command.as_str(), &input)?;
            println!("{output}");
            Ok(())
        }
        "-h" | "--help" | "help" => {
            eprintln!("openscout-repo-service scan < request.json");
            eprintln!("openscout-repo-service diff < request.json");
            Ok(())
        }
        other => Err(format!("unknown command: {other}")),
    }
}

pub fn run_command_json(command: &str, input: &str) -> Result<String, String> {
    let value = match command {
        "scan" => scan_json(input)?,
        "diff" => diff_json(input)?,
        other => return Err(format!("unknown command: {other}")),
    };
    serde_json::to_string_pretty(&value).map_err(|error| error.to_string())
}

pub fn scan_json(input: &str) -> Result<Value, String> {
    let request: ScanRequest = if input.trim().is_empty() {
        ScanRequest::default()
    } else {
        serde_json::from_str(input).map_err(|error| format!("invalid scan request: {error}"))?
    };
    serde_json::to_value(scan(request)).map_err(|error| error.to_string())
}

pub fn diff_json(input: &str) -> Result<Value, String> {
    let request: diff::RepoDiffRequest =
        serde_json::from_str(input).map_err(|error| format!("invalid diff request: {error}"))?;
    serde_json::to_value(diff::diff(request)).map_err(|error| error.to_string())
}

pub fn scan_value(input: Value) -> Result<Value, String> {
    let request: ScanRequest =
        serde_json::from_value(input).map_err(|error| format!("invalid scan request: {error}"))?;
    serde_json::to_value(scan(request)).map_err(|error| error.to_string())
}

pub fn diff_value(input: Value) -> Result<Value, String> {
    let request: diff::RepoDiffRequest =
        serde_json::from_value(input).map_err(|error| format!("invalid diff request: {error}"))?;
    serde_json::to_value(diff::diff(request)).map_err(|error| error.to_string())
}

const DEFAULT_MAX_ROOTS: usize = 8;
const DEFAULT_MAX_WORKTREES: usize = 4;
const DEFAULT_MAX_FILES_PER_WORKTREE: usize = 12;
const DEFAULT_SCAN_BUDGET_MS: u64 = 4_000;
const GIT_TIMEOUT: Duration = Duration::from_millis(650);
const POLL_INTERVAL: Duration = Duration::from_millis(10);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanRequest {
    #[serde(default)]
    hints: Vec<PathHint>,
    #[serde(default)]
    limits: ScanLimits,
}

impl Default for ScanRequest {
    fn default() -> Self {
        Self {
            hints: Vec::new(),
            limits: ScanLimits::default(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathHint {
    path: String,
    #[serde(default)]
    source: String,
    #[serde(default)]
    hint_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanLimits {
    #[serde(default = "default_max_roots")]
    max_roots: usize,
    #[serde(default = "default_max_worktrees")]
    max_worktrees: usize,
    #[serde(default = "default_max_files_per_worktree")]
    max_files_per_worktree: usize,
    #[serde(default = "default_scan_budget_ms")]
    scan_budget_ms: u64,
    #[serde(default)]
    include_diff: bool,
    #[serde(default)]
    include_last_commit: bool,
}

impl Default for ScanLimits {
    fn default() -> Self {
        Self {
            max_roots: DEFAULT_MAX_ROOTS,
            max_worktrees: DEFAULT_MAX_WORKTREES,
            max_files_per_worktree: DEFAULT_MAX_FILES_PER_WORKTREE,
            scan_budget_ms: DEFAULT_SCAN_BUDGET_MS,
            include_diff: false,
            include_last_commit: false,
        }
    }
}

fn default_max_roots() -> usize {
    DEFAULT_MAX_ROOTS
}

fn default_max_worktrees() -> usize {
    DEFAULT_MAX_WORKTREES
}

fn default_max_files_per_worktree() -> usize {
    DEFAULT_MAX_FILES_PER_WORKTREE
}

fn default_scan_budget_ms() -> u64 {
    DEFAULT_SCAN_BUDGET_MS
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResponse {
    schema: &'static str,
    generated_at: u64,
    projects: Vec<RawProject>,
    coverage: ScanCoverage,
    diagnostics: Vec<ScanDiagnostic>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawProject {
    root: String,
    common_git_dir: String,
    worktrees: Vec<RawWorktree>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawWorktree {
    path: String,
    name: String,
    is_bare: bool,
    branch: BranchSummary,
    status: StatusSummary,
    diff: DiffSummary,
    last_commit_at: Option<u64>,
    scanned_at: u64,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BranchSummary {
    name: Option<String>,
    upstream: Option<String>,
    head: Option<String>,
    detached: bool,
    ahead: u32,
    behind: u32,
    is_main: bool,
    diverged: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusSummary {
    clean: bool,
    staged: u32,
    unstaged: u32,
    untracked: u32,
    conflicts: u32,
    changed_files: u32,
    files: Vec<ChangedFile>,
}

impl Default for StatusSummary {
    fn default() -> Self {
        Self {
            clean: true,
            staged: 0,
            unstaged: 0,
            untracked: 0,
            conflicts: 0,
            changed_files: 0,
            files: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ChangedFile {
    path: String,
    status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffSummary {
    branch_shortstat: Option<String>,
    unstaged_shortstat: Option<String>,
    staged_shortstat: Option<String>,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScanCoverage {
    hinted_paths: usize,
    discovered_roots: usize,
    scanned_roots: usize,
    scanned_worktrees: usize,
    skipped_missing_paths: usize,
    skipped_non_git_paths: usize,
    skipped_unreadable_worktrees: usize,
    capped_roots: bool,
    capped_worktree_roots: usize,
    scan_budget_reached: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanDiagnostic {
    level: DiagnosticLevel,
    kind: String,
    message: String,
    path: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosticLevel {
    Info,
    Warning,
}

#[derive(Debug, Clone)]
struct GitRoot {
    top_level: PathBuf,
    common_git_dir: PathBuf,
    hint_paths: Vec<PathBuf>,
}

#[derive(Debug, Clone)]
struct ParsedWorktree {
    path: PathBuf,
    head: Option<String>,
    branch: Option<String>,
    detached: bool,
    bare: bool,
}

#[derive(Debug)]
struct ParsedStatus {
    branch: BranchSummary,
    status: StatusSummary,
}

pub fn scan(request: ScanRequest) -> ScanResponse {
    let started = Instant::now();
    let budget = Duration::from_millis(request.limits.scan_budget_ms.max(1));
    let generated_at = now_ms();
    let mut coverage = ScanCoverage {
        hinted_paths: request.hints.len(),
        ..ScanCoverage::default()
    };
    let mut diagnostics = Vec::new();
    let roots = discover_roots(
        &request.hints,
        &request.limits,
        started,
        budget,
        &mut coverage,
        &mut diagnostics,
    );
    let mut projects = Vec::new();

    for root in roots.iter().take(request.limits.max_roots) {
        if started.elapsed() >= budget {
            coverage.scan_budget_reached = true;
            diagnostics.push(scan_budget_diag());
            break;
        }
        coverage.scanned_roots += 1;
        let project = scan_project(
            root,
            &request.limits,
            started,
            budget,
            generated_at,
            &mut coverage,
            &mut diagnostics,
        );
        if !project.worktrees.is_empty() {
            projects.push(project);
        }
    }

    ScanResponse {
        schema: "openscout.repo.scan/v1",
        generated_at,
        projects,
        coverage,
        diagnostics,
    }
}

fn discover_roots(
    hints: &[PathHint],
    limits: &ScanLimits,
    started: Instant,
    budget: Duration,
    coverage: &mut ScanCoverage,
    diagnostics: &mut Vec<ScanDiagnostic>,
) -> Vec<GitRoot> {
    let mut roots = HashMap::<String, GitRoot>::new();
    let mut seen_hints = HashSet::<String>::new();

    for hint in hints {
        if started.elapsed() >= budget {
            coverage.scan_budget_reached = true;
            diagnostics.push(scan_budget_diag());
            break;
        }
        if roots.len() >= limits.max_roots {
            coverage.capped_roots = true;
            diagnostics.push(ScanDiagnostic {
                level: DiagnosticLevel::Warning,
                kind: "max_roots".to_string(),
                message: format!(
                    "Repo scan limited discovery to {} repositories.",
                    limits.max_roots
                ),
                path: None,
            });
            break;
        }
        let normalized = normalize_path(&hint.path);
        let hint_key = format!(
            "{}\0{}\0{}",
            normalized.display(),
            hint.source,
            hint.hint_id.as_deref().unwrap_or("")
        );
        if !seen_hints.insert(hint_key) {
            continue;
        }
        let Some(existing) = existing_directory_for_path(&normalized) else {
            coverage.skipped_missing_paths += 1;
            diagnostics.push(ScanDiagnostic {
                level: DiagnosticLevel::Info,
                kind: "missing_path".to_string(),
                message: "Skipped missing repo scan path.".to_string(),
                path: Some(normalized.display().to_string()),
            });
            continue;
        };
        let Ok(top_level_raw) = git_string(&existing, &["rev-parse", "--show-toplevel"]) else {
            coverage.skipped_non_git_paths += 1;
            continue;
        };
        let top_level = normalize_path(top_level_raw.trim());
        let common_raw = git_string(&top_level, &["rev-parse", "--git-common-dir"])
            .unwrap_or_else(|_| top_level.display().to_string());
        let common_git_dir = if Path::new(common_raw.trim()).is_absolute() {
            normalize_path(common_raw.trim())
        } else {
            normalize_path(top_level.join(common_raw.trim()).display().to_string())
        };
        let key = common_git_dir.display().to_string();
        roots
            .entry(key)
            .and_modify(|root| root.hint_paths.push(normalized.clone()))
            .or_insert_with(|| GitRoot {
                top_level,
                common_git_dir,
                hint_paths: vec![normalized],
            });
    }

    let mut out: Vec<GitRoot> = roots.into_values().collect();
    out.sort_by(|left, right| left.top_level.cmp(&right.top_level));
    coverage.discovered_roots = out.len();
    out
}

fn scan_project(
    root: &GitRoot,
    limits: &ScanLimits,
    started: Instant,
    budget: Duration,
    generated_at: u64,
    coverage: &mut ScanCoverage,
    diagnostics: &mut Vec<ScanDiagnostic>,
) -> RawProject {
    let worktree_output = git_string(&root.top_level, &["worktree", "list", "--porcelain"]).ok();
    let mut worktrees = worktree_output
        .as_deref()
        .map(parse_worktree_list)
        .filter(|parsed| !parsed.is_empty())
        .unwrap_or_else(|| {
            vec![ParsedWorktree {
                path: root.top_level.clone(),
                head: None,
                branch: None,
                detached: false,
                bare: false,
            }]
        });
    worktrees.sort_by(|left, right| {
        let left_rank = hint_rank_for_worktree(&left.path, &root.hint_paths);
        let right_rank = hint_rank_for_worktree(&right.path, &root.hint_paths);
        left_rank
            .cmp(&right_rank)
            .then_with(|| left.path.cmp(&right.path))
    });
    if worktrees.len() > limits.max_worktrees {
        coverage.capped_worktree_roots += 1;
        diagnostics.push(ScanDiagnostic {
            level: DiagnosticLevel::Warning,
            kind: "max_worktrees".to_string(),
            message: format!(
                "Repo scan limited {} to {} worktrees.",
                root.top_level.display(),
                limits.max_worktrees
            ),
            path: Some(root.top_level.display().to_string()),
        });
        worktrees.truncate(limits.max_worktrees);
    }

    let mut scanned = Vec::new();
    for worktree in worktrees {
        if started.elapsed() >= budget {
            coverage.scan_budget_reached = true;
            diagnostics.push(scan_budget_diag());
            break;
        }
        match scan_worktree(&worktree, limits, generated_at) {
            Some(raw) => {
                coverage.scanned_worktrees += 1;
                scanned.push(raw);
            }
            None => {
                coverage.skipped_unreadable_worktrees += 1;
                diagnostics.push(ScanDiagnostic {
                    level: DiagnosticLevel::Info,
                    kind: "unreadable_worktree".to_string(),
                    message: "Skipped unreadable worktree.".to_string(),
                    path: Some(worktree.path.display().to_string()),
                });
            }
        }
    }

    RawProject {
        root: root.top_level.display().to_string(),
        common_git_dir: root.common_git_dir.display().to_string(),
        worktrees: scanned,
    }
}

fn scan_worktree(
    worktree: &ParsedWorktree,
    limits: &ScanLimits,
    generated_at: u64,
) -> Option<RawWorktree> {
    let status_output = git_string(
        &worktree.path,
        &["status", "--porcelain=v2", "--branch", "-unormal"],
    )
    .ok()?;
    let parsed = parse_status_porcelain_v2(&status_output, limits.max_files_per_worktree);
    let mut branch = parsed.branch;
    if branch.name.is_none() {
        branch.name = worktree.branch.clone();
    }
    if branch.head.is_none() {
        branch.head = worktree.head.clone();
    }
    branch.detached = branch.name.is_none() && worktree.branch.is_none();
    branch.is_main = matches!(branch.name.as_deref(), Some("main") | Some("master"));
    branch.diverged = branch.ahead > 0 && branch.behind > 0;

    let diff = if limits.include_diff {
        DiffSummary {
            branch_shortstat: branch_diff_shortstat(&worktree.path, &branch),
            unstaged_shortstat: git_trimmed(&worktree.path, &["diff", "--shortstat"]),
            staged_shortstat: git_trimmed(&worktree.path, &["diff", "--cached", "--shortstat"]),
        }
    } else {
        DiffSummary {
            branch_shortstat: None,
            unstaged_shortstat: None,
            staged_shortstat: None,
        }
    };
    let last_commit_at = if limits.include_last_commit {
        git_trimmed(&worktree.path, &["log", "-1", "--format=%ct"])
            .and_then(|value| value.parse::<u64>().ok())
            .map(|seconds| seconds * 1_000)
    } else {
        None
    };

    Some(RawWorktree {
        path: worktree.path.display().to_string(),
        name: worktree
            .path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_else(|| worktree.path.to_str().unwrap_or(""))
            .to_string(),
        is_bare: worktree.bare,
        branch,
        status: parsed.status,
        diff,
        last_commit_at,
        scanned_at: generated_at,
    })
}

fn parse_worktree_list(output: &str) -> Vec<ParsedWorktree> {
    let mut worktrees = Vec::new();
    let mut current: Option<ParsedWorktree> = None;
    for line in output.lines() {
        if line.trim().is_empty() {
            flush_worktree(&mut worktrees, &mut current);
            continue;
        }
        let mut parts = line.splitn(2, ' ');
        let key = parts.next().unwrap_or("");
        let value = parts.next().unwrap_or("").trim();
        match key {
            "worktree" => {
                flush_worktree(&mut worktrees, &mut current);
                current = Some(ParsedWorktree {
                    path: normalize_path(value),
                    head: None,
                    branch: None,
                    detached: false,
                    bare: false,
                });
            }
            "HEAD" => {
                if let Some(worktree) = current.as_mut() {
                    if !value.is_empty() {
                        worktree.head = Some(value.to_string());
                    }
                }
            }
            "branch" => {
                if let Some(worktree) = current.as_mut() {
                    let branch = value.strip_prefix("refs/heads/").unwrap_or(value);
                    if !branch.is_empty() {
                        worktree.branch = Some(branch.to_string());
                    }
                }
            }
            "detached" => {
                if let Some(worktree) = current.as_mut() {
                    worktree.detached = true;
                }
            }
            "bare" => {
                if let Some(worktree) = current.as_mut() {
                    worktree.bare = true;
                }
            }
            _ => {}
        }
    }
    flush_worktree(&mut worktrees, &mut current);
    worktrees
}

fn flush_worktree(worktrees: &mut Vec<ParsedWorktree>, current: &mut Option<ParsedWorktree>) {
    if let Some(mut worktree) = current.take() {
        worktree.detached = worktree.detached || worktree.branch.is_none();
        worktrees.push(worktree);
    }
}

fn parse_status_porcelain_v2(output: &str, max_files: usize) -> ParsedStatus {
    let mut status = StatusSummary::default();
    let mut branch = BranchSummary::default();
    for line in output.lines() {
        if line.starts_with("# branch.oid ") {
            let value = line.trim_start_matches("# branch.oid ").trim();
            if !value.is_empty() && value != "(initial)" {
                branch.head = Some(value.to_string());
            }
            continue;
        }
        if line.starts_with("# branch.head ") {
            let value = line.trim_start_matches("# branch.head ").trim();
            if !value.is_empty() && value != "(detached)" {
                branch.name = Some(value.to_string());
            }
            continue;
        }
        if line.starts_with("# branch.upstream ") {
            let value = line.trim_start_matches("# branch.upstream ").trim();
            if !value.is_empty() {
                branch.upstream = Some(value.to_string());
            }
            continue;
        }
        if line.starts_with("# branch.ab ") {
            parse_branch_ab(line, &mut branch);
            continue;
        }
        if line.starts_with("? ") {
            status.untracked += 1;
            push_changed_file(
                &mut status,
                line.trim_start_matches("? ").trim(),
                "untracked",
                max_files,
            );
            continue;
        }
        if line.starts_with("u ") {
            status.conflicts += 1;
            push_changed_file(
                &mut status,
                &extract_status_path(line),
                "conflict",
                max_files,
            );
            continue;
        }
        if line.starts_with("1 ") || line.starts_with("2 ") {
            let xy = line.get(2..4).unwrap_or("..").as_bytes();
            let staged = xy.first().is_some_and(|value| *value != b'.');
            let unstaged = xy.get(1).is_some_and(|value| *value != b'.');
            if staged {
                status.staged += 1;
            }
            if unstaged {
                status.unstaged += 1;
            }
            let label = match (staged, unstaged) {
                (true, true) => "staged+unstaged",
                (true, false) => "staged",
                (false, true) => "unstaged",
                (false, false) => "changed",
            };
            push_changed_file(&mut status, &extract_status_path(line), label, max_files);
        }
    }
    status.clean = status.staged == 0
        && status.unstaged == 0
        && status.untracked == 0
        && status.conflicts == 0;
    branch.detached = branch.name.is_none();
    branch.is_main = matches!(branch.name.as_deref(), Some("main") | Some("master"));
    branch.diverged = branch.ahead > 0 && branch.behind > 0;
    ParsedStatus { branch, status }
}

fn parse_branch_ab(line: &str, branch: &mut BranchSummary) {
    for part in line.trim_start_matches("# branch.ab ").split_whitespace() {
        if let Some(value) = part.strip_prefix('+') {
            branch.ahead = value.parse::<u32>().unwrap_or(0);
        } else if let Some(value) = part.strip_prefix('-') {
            branch.behind = value.parse::<u32>().unwrap_or(0);
        }
    }
}

fn extract_status_path(line: &str) -> String {
    if line.starts_with("? ") {
        return line.trim_start_matches("? ").trim().to_string();
    }
    if line.starts_with("u ") {
        return line
            .split_whitespace()
            .skip(10)
            .collect::<Vec<&str>>()
            .join(" ");
    }
    if line.starts_with("2 ") {
        let primary = line.split('\t').next().unwrap_or(line);
        return primary
            .split_whitespace()
            .skip(9)
            .collect::<Vec<&str>>()
            .join(" ");
    }
    if line.starts_with("1 ") {
        return line
            .split_whitespace()
            .skip(8)
            .collect::<Vec<&str>>()
            .join(" ");
    }
    String::new()
}

fn push_changed_file(status: &mut StatusSummary, path: &str, label: &str, max_files: usize) {
    status.changed_files += 1;
    if status.files.len() < max_files {
        status.files.push(ChangedFile {
            path: if path.is_empty() { "unknown" } else { path }.to_string(),
            status: label.to_string(),
        });
    }
}

fn git_trimmed(cwd: &Path, args: &[&str]) -> Option<String> {
    git_string(cwd, args)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

const TRUNK_REFS: &[&str] = &[
    "origin/main",
    "main",
    "origin/master",
    "master",
    "origin/trunk",
    "trunk",
];

fn git_ref_exists(cwd: &Path, ref_name: &str) -> bool {
    let commit_ref = format!("{ref_name}^{{commit}}");
    git_string(cwd, &["rev-parse", "--verify", "--quiet", &commit_ref]).is_ok()
}

fn preferred_branch_base_ref(cwd: &Path, branch: &BranchSummary) -> Option<String> {
    if branch.is_main || branch.detached {
        return None;
    }
    let mut candidates: Vec<String> = Vec::new();
    candidates.extend(TRUNK_REFS.iter().map(|value| value.to_string()));
    if let Some(upstream) = branch.upstream.as_deref() {
        if !upstream.is_empty() {
            candidates.push(upstream.to_string());
        }
    }

    for candidate in candidates {
        if Some(candidate.as_str()) == branch.name.as_deref() || candidate == "HEAD" {
            continue;
        }
        if git_ref_exists(cwd, &candidate) {
            return Some(candidate);
        }
    }
    None
}

fn branch_diff_shortstat(cwd: &Path, branch: &BranchSummary) -> Option<String> {
    let base_ref = preferred_branch_base_ref(cwd, branch)?;
    let merge_base = git_trimmed(cwd, &["merge-base", &base_ref, "HEAD"])?;
    let range = format!("{merge_base}..HEAD");
    git_trimmed(cwd, &["diff", "--shortstat", &range])
}

fn git_string(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let bytes = git_capture(cwd, args, GIT_TIMEOUT)?;
    String::from_utf8(bytes).map_err(|error| error.to_string())
}

/// Run a bounded `git` subprocess and capture stdout bytes. Kills the child if
/// it outlives `timeout`. Shared by the scan and diff commands.
///
/// Stdout/stderr are drained on helper threads while the parent polls for exit.
/// Without concurrent reads, large `git diff` output can fill the pipe buffer
/// (~64 KiB), block the child, and look like a timeout even when Git is fast.
pub(crate) fn git_capture(cwd: &Path, args: &[&str], timeout: Duration) -> Result<Vec<u8>, String> {
    let mut child = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| error.to_string())?;

    let mut stdout_pipe = child
        .stdout
        .take()
        .ok_or_else(|| "failed to capture git stdout".to_string())?;
    let mut stderr_pipe = child
        .stderr
        .take()
        .ok_or_else(|| "failed to capture git stderr".to_string())?;

    let stdout_handle = thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout_pipe.read_to_end(&mut buf);
        buf
    });
    let stderr_handle = thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr_pipe.read_to_end(&mut buf);
        buf
    });

    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let stdout = stdout_handle
                    .join()
                    .map_err(|_| "git stdout reader panicked".to_string())?;
                let stderr = stderr_handle
                    .join()
                    .map_err(|_| "git stderr reader panicked".to_string())?;
                if status.success() {
                    return Ok(stdout);
                }
                let stderr_text = String::from_utf8_lossy(&stderr).trim().to_string();
                return Err(if stderr_text.is_empty() {
                    format!("git {} failed", args.join(" "))
                } else {
                    stderr_text
                });
            }
            Ok(None) => {
                if started.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = stdout_handle.join();
                    let _ = stderr_handle.join();
                    return Err(format!("git {} timed out", args.join(" ")));
                }
                thread::sleep(POLL_INTERVAL);
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}

fn existing_directory_for_path(path: &Path) -> Option<PathBuf> {
    let meta = fs::metadata(path).ok()?;
    if meta.is_dir() {
        Some(path.to_path_buf())
    } else if meta.is_file() {
        path.parent().map(Path::to_path_buf)
    } else {
        None
    }
}

fn hint_rank_for_worktree(path: &Path, hints: &[PathBuf]) -> usize {
    hints
        .iter()
        .position(|hint| path_contains(path, hint) || path_contains(hint, path))
        .unwrap_or(usize::MAX)
}

fn path_contains(parent: &Path, child: &Path) -> bool {
    child.strip_prefix(parent).is_ok()
}

pub(crate) fn normalize_path<T: AsRef<str>>(input: T) -> PathBuf {
    let raw = input.as_ref().trim();
    let expanded = if raw == "~" {
        home_dir()
    } else if let Some(rest) = raw.strip_prefix("~/") {
        home_dir().join(rest)
    } else {
        PathBuf::from(raw)
    };
    if expanded.is_absolute() {
        expanded
    } else {
        env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(expanded)
    }
}

fn home_dir() -> PathBuf {
    env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_millis(0))
        .as_millis() as u64
}

fn scan_budget_diag() -> ScanDiagnostic {
    ScanDiagnostic {
        level: DiagnosticLevel::Warning,
        kind: "scan_budget".to_string(),
        message: "Repo scan stopped after reaching the scan budget.".to_string(),
        path: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn parses_git_worktree_porcelain() {
        let parsed = parse_worktree_list(
            "worktree /Users/me/dev/openscout\nHEAD abc123\nbranch refs/heads/main\n\nworktree /Users/me/dev/feature\nHEAD def456\ndetached\n\n",
        );
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].path, PathBuf::from("/Users/me/dev/openscout"));
        assert_eq!(parsed[0].branch.as_deref(), Some("main"));
        assert!(!parsed[0].detached);
        assert!(parsed[1].detached);
    }

    #[test]
    fn parses_status_porcelain_v2() {
        let parsed = parse_status_porcelain_v2(
            "# branch.oid abc123\n# branch.head feature/repo-watch\n# branch.upstream origin/feature/repo-watch\n# branch.ab +2 -1\n1 .M N... 100644 100644 100644 abc abc src/index.ts\n1 A. N... 000000 100644 100644 000 def src/new.ts\n? scratch.md\nu UU N... 100644 100644 100644 100644 a b c d conflicted.txt\n",
            12,
        );
        assert_eq!(parsed.branch.name.as_deref(), Some("feature/repo-watch"));
        assert_eq!(parsed.branch.ahead, 2);
        assert_eq!(parsed.branch.behind, 1);
        assert!(parsed.branch.diverged);
        assert!(!parsed.status.clean);
        assert_eq!(parsed.status.staged, 1);
        assert_eq!(parsed.status.unstaged, 1);
        assert_eq!(parsed.status.untracked, 1);
        assert_eq!(parsed.status.conflicts, 1);
    }

    #[test]
    fn scans_real_git_repo() {
        let root = temp_dir("openscout-repo-service-test");
        fs::create_dir_all(&root).unwrap();
        run_git(&root, &["init", "-b", "main"]);
        fs::write(root.join("README.md"), "hello\n").unwrap();
        run_git(&root, &["add", "README.md"]);
        run_git(
            &root,
            &[
                "-c",
                "user.email=scout@example.test",
                "-c",
                "user.name=Scout",
                "commit",
                "-m",
                "initial",
            ],
        );
        fs::write(root.join("README.md"), "hello\nworld\n").unwrap();
        fs::write(root.join("scratch.md"), "scratch\n").unwrap();

        let response = scan(ScanRequest {
            hints: vec![PathHint {
                path: root.display().to_string(),
                source: "test".to_string(),
                hint_id: None,
            }],
            limits: ScanLimits {
                include_diff: true,
                include_last_commit: true,
                ..ScanLimits::default()
            },
        });

        assert_eq!(response.projects.len(), 1);
        assert_eq!(response.coverage.scanned_worktrees, 1);
        let worktree = &response.projects[0].worktrees[0];
        assert_eq!(worktree.branch.name.as_deref(), Some("main"));
        assert_eq!(worktree.status.unstaged, 1);
        assert_eq!(worktree.status.untracked, 1);
        assert!(worktree.diff.unstaged_shortstat.is_some());
        assert!(worktree.last_commit_at.is_some());

        let _ = fs::remove_dir_all(root);
    }

    fn temp_dir(prefix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let mut base = env::temp_dir();
        base.push(format!("{prefix}-{}-{nanos}", std::process::id()));
        base
    }

    fn run_git(cwd: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .unwrap();
        if !output.status.success() {
            let _ = io::stderr().write_all(&output.stderr);
            panic!("git {} failed", args.join(" "));
        }
    }
}
