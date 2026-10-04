//! A reply typed into the place a session runs, from the TUI itself.
//!
//! Mirrors packages/web/server/core/mobile/deliver-in-place.ts, tried in order:
//!   1. Herdr: the pane whose agent session is this id gets `agent prompt`.
//!   2. tmux: a live Claude whose process record names a tmux pane gets a
//!      bracketed paste and Enter.
//!   3. Lattices: a live Claude in a plain terminal tab is typed into by tty.
//!
//! These are all local CLIs, so no server sits in the path. Scout's own
//! background copies (`flat-*` tmux sessions, relay agents) are never targets.

use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

/// What happened to a reply.
#[derive(Debug, PartialEq, Eq)]
pub enum Delivery {
    /// The words went in; the string says where.
    Sent(String),
    /// The session is live but couldn't take them; the string says why.
    Refused(String),
    /// Nothing live holds this session.
    NotLive,
}

pub fn deliver(session_id: &str, harness: &str, body: &str) -> Delivery {
    let session_id = session_id.trim();
    if session_id.is_empty() {
        return Delivery::NotLive;
    }
    if let Some(found) = herdr(session_id, body) {
        return found;
    }
    let harness = harness.trim().to_ascii_lowercase();
    if harness == "codex" {
        if codex_held_by_chatgpt_app(session_id) {
            return Delivery::Refused(
                "This session is open in the ChatGPT app; reply there. Nothing was sent.".into(),
            );
        }
        return Delivery::NotLive;
    }
    // Only Claude Code writes a process record naming its pane or terminal.
    if !harness.is_empty() && harness != "claude" {
        return Delivery::NotLive;
    }
    let Some(record) = live_claude_record(session_id) else {
        return Delivery::NotLive;
    };
    if let Some(tmux) = &record.tmux {
        let target = tmux.pane.clone().unwrap_or_else(|| tmux.session.clone());
        let location = match &tmux.pane {
            Some(pane) => format!("tmux {} · {pane}", tmux.session),
            None => format!("tmux {}", tmux.session),
        };
        return match tmux_prompt(&target, body) {
            Ok(()) => Delivery::Sent(location),
            Err(err) => Delivery::Refused(format!("couldn't type into {location}: {err}")),
        };
    }
    let Some(tty) = tty_for_pid(record.pid) else {
        return Delivery::NotLive;
    };
    let location = format!("terminal {tty}");
    match run(
        "lattices",
        &[
            "computer",
            "type-text",
            "--tty",
            &tty,
            "--text",
            body,
            "--treatment",
            "execute",
            "--enter",
            "--no-capture",
            "--json",
        ],
        None,
        Duration::from_secs(15),
    ) {
        Ok(_) => Delivery::Sent(location),
        Err(err) => Delivery::Refused(format!("couldn't type into {location}: {err}")),
    }
}

// -- Herdr --------------------------------------------------------------------

fn herdr_bin() -> String {
    std::env::var("OPENSCOUT_HERDR_BIN")
        .ok()
        .filter(|bin| !bin.trim().is_empty())
        .unwrap_or_else(|| "herdr".into())
}

fn herdr(session_id: &str, body: &str) -> Option<Delivery> {
    let bin = herdr_bin();
    let listed = run(
        &bin,
        &["session", "list", "--json"],
        None,
        Duration::from_secs(4),
    )
    .ok()?;
    let sessions: serde_json::Value = serde_json::from_str(&listed).ok()?;
    for session in sessions.get("sessions")?.as_array()? {
        if session.get("running").and_then(|v| v.as_bool()) != Some(true) {
            continue;
        }
        let Some(name) = session.get("name").and_then(|v| v.as_str()) else {
            continue;
        };
        let Ok(panes) = run(
            &bin,
            &["--session", name, "pane", "list"],
            None,
            Duration::from_secs(4),
        ) else {
            continue;
        };
        let Some((pane, status)) = herdr_pane_for(&panes, session_id) else {
            continue;
        };
        let location = format!("Herdr {name} · {pane}");
        if status.as_deref() == Some("blocked") {
            return Some(Delivery::Refused(format!(
                "{location} is waiting on a prompt; answer that first. Nothing was sent."
            )));
        }
        return Some(
            match run(
                &bin,
                &["--session", name, "agent", "prompt", &pane, body],
                None,
                Duration::from_secs(4),
            ) {
                Ok(_) => Delivery::Sent(location),
                Err(err) => Delivery::Refused(format!("couldn't type into {location}: {err}")),
            },
        );
    }
    None
}

/// The pane (and its agent status) holding this harness session, from
/// `herdr pane list` output.
fn herdr_pane_for(pane_list: &str, session_id: &str) -> Option<(String, Option<String>)> {
    let value: serde_json::Value = serde_json::from_str(pane_list).ok()?;
    let panes = value.get("result")?.get("panes")?.as_array()?;
    panes.iter().find_map(|pane| {
        let held = pane
            .get("agent_session")
            .and_then(|s| s.get("value"))
            .and_then(|v| v.as_str())?;
        if held != session_id {
            return None;
        }
        let id = pane.get("pane_id")?.as_str()?.to_string();
        let status = pane
            .get("agent_status")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        Some((id, status))
    })
}

// -- Claude process records ----------------------------------------------------

#[derive(Debug, PartialEq, Eq)]
struct TmuxLocation {
    session: String,
    pane: Option<String>,
}

#[derive(Debug)]
struct ClaudeRecord {
    pid: u32,
    proc_start: Option<String>,
    tmux: Option<TmuxLocation>,
}

fn claude_sessions_dir() -> PathBuf {
    let config = std::env::var("CLAUDE_CONFIG_DIR")
        .ok()
        .filter(|dir| !dir.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".claude")
        });
    config.join("sessions")
}

/// `"<session>:@<window>.%<pane>"` as Claude Code records it.
fn parse_tmux(value: &str) -> Option<TmuxLocation> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let Some((session, rest)) = value.split_once(':') else {
        return Some(TmuxLocation {
            session: value.into(),
            pane: None,
        });
    };
    if session.is_empty() {
        return None;
    }
    let pane = rest
        .split_once('.')
        .map(|(_, pane)| pane)
        .filter(|pane| !pane.is_empty());
    Some(TmuxLocation {
        session: session.into(),
        pane: pane.map(str::to_string),
    })
}

/// A record for this session id whose process is still the one that wrote it,
/// skipping Scout's own background copies.
fn live_claude_record(session_id: &str) -> Option<ClaudeRecord> {
    let entries = fs::read_dir(claude_sessions_dir()).ok()?;
    for entry in entries.flatten().take(1024) {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(stem) = name.strip_suffix(".json") else {
            continue;
        };
        if !stem.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if meta.len() > 64 * 1024 {
            continue;
        }
        let Ok(raw) = fs::read_to_string(entry.path()) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        if value.get("sessionId").and_then(|v| v.as_str()) != Some(session_id) {
            continue;
        }
        let Some(pid) = value.get("pid").and_then(|v| v.as_u64()) else {
            continue;
        };
        if pid.to_string() != stem {
            continue;
        }
        let tmux = value
            .get("tmux")
            .and_then(|v| v.as_str())
            .and_then(parse_tmux);
        let record_name = value.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let background = tmux
            .as_ref()
            .is_some_and(|t| t.session.starts_with("flat-"))
            || record_name.ends_with("-relay-agent");
        if background {
            continue;
        }
        let record = ClaudeRecord {
            pid: pid as u32,
            proc_start: value
                .get("procStart")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            tmux,
        };
        if still_running(&record) {
            return Some(record);
        }
    }
    None
}

fn collapse(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Same pid AND same birth time: a bare pid check would accept pid reuse.
fn still_running(record: &ClaudeRecord) -> bool {
    let Some(expected) = &record.proc_start else {
        return false;
    };
    let started = Command::new("ps")
        .args(["-p", &record.pid.to_string(), "-o", "lstart="])
        .env("TZ", "UTC")
        .env("LC_ALL", "C")
        .output();
    let Ok(started) = started else { return false };
    if collapse(&String::from_utf8_lossy(&started.stdout)) != collapse(expected) {
        return false;
    }
    let Some(tmux) = &record.tmux else {
        return true;
    };
    // The pane must still run this very process.
    let target = format!("={}", tmux.session);
    run(
        "tmux",
        &[
            "-u",
            "list-panes",
            "-s",
            "-t",
            &target,
            "-F",
            "#{pane_id}\t#{pane_pid}",
        ],
        None,
        Duration::from_secs(2),
    )
    .map(|out| {
        out.lines().any(|line| {
            let mut cols = line.split('\t');
            let pane = cols.next().unwrap_or("");
            let pid = cols.next().unwrap_or("");
            pid == record.pid.to_string() && tmux.pane.as_deref().is_none_or(|want| want == pane)
        })
    })
    .unwrap_or(false)
}

fn tty_for_pid(pid: u32) -> Option<String> {
    let out = run(
        "ps",
        &["-p", &pid.to_string(), "-o", "tty="],
        None,
        Duration::from_secs(2),
    )
    .ok()?;
    let tty = out.trim();
    if tty.is_empty() || tty == "??" {
        return None;
    }
    Some(if tty.starts_with("tty") {
        tty.to_string()
    } else {
        format!("tty{tty}")
    })
}

// -- tmux ---------------------------------------------------------------------

/// A bracketed paste from a private buffer, a beat for the pane to drain it,
/// then Enter: the same dispatch Scout uses for its own panes.
fn tmux_prompt(target: &str, body: &str) -> Result<(), String> {
    let buffer = format!(
        "scout-tui-reply-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default()
    );
    run(
        "tmux",
        &["load-buffer", "-b", &buffer, "-"],
        Some(body),
        Duration::from_secs(5),
    )?;
    if let Err(err) = run(
        "tmux",
        &["paste-buffer", "-dpr", "-b", &buffer, "-t", target],
        None,
        Duration::from_secs(2),
    ) {
        let _ = run(
            "tmux",
            &["delete-buffer", "-b", &buffer],
            None,
            Duration::from_secs(2),
        );
        return Err(err);
    }
    thread::sleep(Duration::from_millis(150));
    run(
        "tmux",
        &["send-keys", "-t", target, "Enter"],
        None,
        Duration::from_secs(2),
    )?;
    Ok(())
}

// -- Codex --------------------------------------------------------------------

/// Codex holds a per-thread writer lock; held from inside ChatGPT.app means
/// the thread is open there, a place the TUI can't type into.
fn codex_held_by_chatgpt_app(session_id: &str) -> bool {
    if session_id.len() < 16
        || !session_id
            .chars()
            .all(|c| c.is_ascii_hexdigit() || c == '-')
    {
        return false;
    }
    let home = std::env::var("CODEX_HOME")
        .ok()
        .filter(|dir| !dir.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".codex"));
    let lock = home
        .join("thread-writer-locks")
        .join(format!("{session_id}.lock"));
    let Ok(pids) = run(
        "lsof",
        &["-t", &lock.to_string_lossy()],
        None,
        Duration::from_secs(3),
    ) else {
        return false;
    };
    pids.split_whitespace().any(|pid| {
        run(
            "ps",
            &["-p", pid, "-o", "command="],
            None,
            Duration::from_secs(2),
        )
        .map(|command| command.contains("ChatGPT.app/"))
        .unwrap_or(false)
    })
}

// -- processes ----------------------------------------------------------------

/// Runs a command with a deadline; stdout on success, a short reason otherwise.
fn run(bin: &str, args: &[&str], stdin: Option<&str>, timeout: Duration) -> Result<String, String> {
    let mut child = Command::new(bin)
        .args(args)
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("{bin}: {err}"))?;
    if let (Some(text), Some(mut pipe)) = (stdin, child.stdin.take()) {
        pipe.write_all(text.as_bytes())
            .map_err(|err| format!("{bin}: {err}"))?;
    }
    let mut stdout = child.stdout.take();
    let reader = thread::spawn(move || {
        let mut out = String::new();
        if let Some(pipe) = stdout.as_mut() {
            let _ = pipe.read_to_string(&mut out);
        }
        out
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{bin} timed out"));
            }
            Err(err) => return Err(format!("{bin}: {err}")),
        }
    };
    let out = reader.join().unwrap_or_default();
    if status.success() {
        Ok(out)
    } else {
        let mut err = String::new();
        if let Some(mut pipe) = child.stderr.take() {
            let _ = pipe.read_to_string(&mut err);
        }
        let err = err.lines().next().unwrap_or("").trim().to_string();
        Err(if err.is_empty() {
            format!("{bin} exited {}", status.code().unwrap_or(-1))
        } else {
            err
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{herdr_pane_for, parse_tmux, TmuxLocation};

    #[test]
    fn tmux_locations_read_as_claude_records_them() {
        assert_eq!(
            parse_tmux("work:@84.%84"),
            Some(TmuxLocation {
                session: "work".into(),
                pane: Some("%84".into())
            })
        );
        assert_eq!(
            parse_tmux("work"),
            Some(TmuxLocation {
                session: "work".into(),
                pane: None
            })
        );
        assert_eq!(parse_tmux(":@1.%2"), None);
        assert_eq!(parse_tmux(""), None);
    }

    #[test]
    fn herdr_finds_the_pane_holding_the_session() {
        let list = r#"{"result":{"panes":[
            {"pane_id":"w1:p1","agent_status":"idle"},
            {"pane_id":"w1:p2","agent_status":"blocked","agent_session":{"agent":"claude","kind":"session","source":"hook","value":"abc-123"}}
        ]}}"#;
        assert_eq!(
            herdr_pane_for(list, "abc-123"),
            Some(("w1:p2".into(), Some("blocked".into())))
        );
        assert_eq!(herdr_pane_for(list, "nope"), None);
    }
}
