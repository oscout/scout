//! Real working-tree churn. Line counts come from `git diff --numstat` in the
//! repos the fleet is actually working in — never estimated from event counts.

use std::collections::{HashMap, HashSet};
use std::process::Command;
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::thread;
use std::time::Duration;

pub struct GitSnapshot {
    /// Absolute file path → (added lines, deleted lines) against HEAD.
    pub churn: HashMap<String, (usize, usize)>,
    /// Absolute paths git knows nothing about yet.
    pub untracked: HashSet<String>,
    /// Repo roots that answered, so files outside them can be named as such.
    pub roots: Vec<String>,
    pub error: Option<String>,
}

/// Send the working directories the fleet is in; receive their churn.
pub fn spawn_git() -> (Sender<Vec<String>>, Receiver<GitSnapshot>) {
    let (cwd_tx, cwd_rx) = mpsc::channel::<Vec<String>>();
    let (snap_tx, snap_rx) = mpsc::channel::<GitSnapshot>();

    thread::spawn(move || {
        let mut cwds: Vec<String> = Vec::new();
        loop {
            loop {
                match cwd_rx.try_recv() {
                    Ok(next) => cwds = next,
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => return,
                }
            }

            if !cwds.is_empty() && snap_tx.send(probe(&cwds)).is_err() {
                return;
            }
            thread::sleep(Duration::from_secs(8));
        }
    });

    (cwd_tx, snap_rx)
}

fn probe(cwds: &[String]) -> GitSnapshot {
    let mut roots: Vec<String> = Vec::new();
    for cwd in cwds {
        if let Some(root) = repo_root(cwd) {
            if !roots.contains(&root) {
                roots.push(root);
            }
        }
    }

    let mut churn = HashMap::new();
    let mut untracked = HashSet::new();
    let mut error = None;

    for root in &roots {
        match numstat(root) {
            Ok(rows) => {
                for (path, adds, dels) in rows {
                    let entry = churn.entry(join(root, &path)).or_insert((0, 0));
                    entry.0 += adds;
                    entry.1 += dels;
                }
            }
            Err(err) => error = Some(err),
        }
        if let Ok(paths) = others(root) {
            for path in paths {
                untracked.insert(join(root, &path));
            }
        }
    }

    if roots.is_empty() && error.is_none() {
        error = Some("no git repository under the fleet's working directories".into());
    }

    GitSnapshot {
        churn,
        untracked,
        roots,
        error,
    }
}

fn join(root: &str, path: &str) -> String {
    format!("{}/{}", root.trim_end_matches('/'), path)
}

fn repo_root(cwd: &str) -> Option<String> {
    let out = Command::new("git")
        .args(["-C", cwd, "rev-parse", "--show-toplevel"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let root = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!root.is_empty()).then_some(root)
}

/// Staged and unstaged line counts against HEAD, per file.
fn numstat(root: &str) -> Result<Vec<(String, usize, usize)>, String> {
    let out = Command::new("git")
        .args(["-C", root, "diff", "--numstat", "HEAD"])
        .output()
        .map_err(|err| format!("git diff: {err}"))?;
    if !out.status.success() {
        return Err(format!(
            "git diff in {root}: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }

    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let mut rows = Vec::new();
    for line in text.lines() {
        let mut parts = line.split('\t');
        let (Some(a), Some(d), Some(path)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        // Binary files report "-"; they have no line counts to claim.
        rows.push((
            path.to_string(),
            a.parse().unwrap_or(0),
            d.parse().unwrap_or(0),
        ));
    }
    Ok(rows)
}

fn others(root: &str) -> Result<Vec<String>, String> {
    let out = Command::new("git")
        .args(["-C", root, "ls-files", "--others", "--exclude-standard"])
        .output()
        .map_err(|err| format!("git ls-files: {err}"))?;
    if !out.status.success() {
        return Err("git ls-files failed".into());
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::to_string)
        .collect())
}
