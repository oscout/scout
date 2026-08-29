#![allow(dead_code)]

//! Turns a raw tail event into a renderable row: one of eight quiet tiers,
//! with tool name/target pulled out of the raw payload while we still have it.

use serde_json::Value;

use crate::app::{clean_summary, Row};
use crate::feed::TailEvent;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Class {
    /// Words a person actually typed.
    Human,
    /// user-kind machine payload: env context, heartbeat, skill, approvals.
    Machine,
    /// Assistant prose.
    Convo,
    /// Codex reasoning titles ("**Doing a thing**").
    Plan,
    /// JSON blobs (permission decisions, structured results).
    Json,
    Tool,
    ToolResult,
    /// task start/complete, world state, turn markers.
    Sys,
}

impl Class {
    pub fn glyph(self) -> &'static str {
        match self {
            Class::Human => "›",
            Class::Machine => "·",
            Class::Convo => "·",
            Class::Plan => "·",
            Class::Json => "◦",
            Class::Tool => "▸",
            Class::ToolResult => "↳",
            Class::Sys => "◦",
        }
    }
}

pub fn classify(mut event: TailEvent) -> Row {
    let summary = event.summary.trim().to_string();
    let raw = event.raw.take();
    let (cls, tool, target, text) = match event.kind.as_str() {
        "tool" => {
            let (name, targ) = extract_tool(raw.as_ref(), &summary);
            (Class::Tool, name, targ, clean_summary(&summary))
        }
        "tool-result" => (Class::ToolResult, None, None, result_text(&summary)),
        "user" => match machine_label(&summary) {
            Some(label) => (Class::Machine, None, None, label),
            None => (Class::Human, None, None, clean_summary(&summary)),
        },
        "assistant" => {
            let trimmed = summary.trim_start();
            if trimmed.starts_with('{') {
                (Class::Json, None, None, json_brief(trimmed))
            } else {
                (Class::Convo, None, None, clean_summary(&summary))
            }
        }
        _ => {
            if summary.starts_with("**") {
                (Class::Plan, None, None, clean_plan(&summary))
            } else {
                (Class::Sys, None, None, sys_label(&summary))
            }
        }
    };
    Row {
        event,
        cls,
        tool,
        target,
        text,
    }
}

fn extract_tool(raw: Option<&Value>, summary: &str) -> (Option<String>, Option<String>) {
    // Claude: raw.message.content[] holds tool_use { name, input }.
    if let Some(content) = raw
        .and_then(|r| r.pointer("/message/content"))
        .and_then(Value::as_array)
    {
        for item in content {
            if item.get("type").and_then(Value::as_str) == Some("tool_use") {
                let name = item.get("name").and_then(Value::as_str).map(norm_tool);
                let target = item.get("input").and_then(tool_target);
                return (name, target);
            }
        }
    }
    // Codex: raw.payload { name, arguments(json string) | input(js string) }.
    if let Some(payload) = raw.and_then(|r| r.get("payload")) {
        let name = payload.get("name").and_then(Value::as_str).map(norm_tool);
        let mut target = payload
            .get("arguments")
            .and_then(Value::as_str)
            .and_then(|args| serde_json::from_str::<Value>(args).ok())
            .and_then(|v| tool_target(&v));
        if target.is_none() {
            target = payload
                .get("input")
                .and_then(Value::as_str)
                .and_then(|input| extract_cmd(input).or_else(|| Some(shorten(input, 60))));
        }
        if name.is_some() {
            return (name, target);
        }
    }
    // Fallback: first token, if it looks like a name rather than prose.
    let first = summary.split_whitespace().next().unwrap_or("");
    if !first.is_empty()
        && first.len() <= 16
        && first
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_-.".contains(c))
    {
        (None, Some(shorten(summary, 60)))
    } else {
        (None, None)
    }
}

fn norm_tool(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    match lower.as_str() {
        "exec_command" | "shell" => "exec".into(),
        other => other.to_string(),
    }
}

fn tool_target(input: &Value) -> Option<String> {
    let obj = input.as_object()?;
    for key in [
        "command",
        "cmd",
        "file_path",
        "path",
        "pattern",
        "query",
        "url",
    ] {
        if let Some(value) = obj.get(key).and_then(Value::as_str) {
            let value = value.trim();
            if !value.is_empty() {
                return Some(shorten(value, 90));
            }
        }
    }
    None
}

/// Pull `cmd:"…"` out of codex's JS-wrapped exec input.
fn extract_cmd(input: &str) -> Option<String> {
    for key in ["cmd:\"", "command:\""] {
        if let Some(start) = input.find(key) {
            let rest = &input[start + key.len()..];
            let end = rest.find('"').unwrap_or(rest.len());
            let cmd = rest[..end].trim();
            if !cmd.is_empty() {
                return Some(shorten(cmd, 90));
            }
        }
    }
    None
}

fn result_text(summary: &str) -> String {
    let text = match summary.split_once("-> res:") {
        Some((_, res)) => res.trim(),
        None => summary.trim(),
    };
    let text = clean_summary(text);
    let lower = text.to_ascii_lowercase();
    if text.is_empty() || lower.starts_with("script completed") {
        return "done".into();
    }
    text
}

fn machine_label(summary: &str) -> Option<String> {
    let t = summary.trim_start();
    if t.starts_with("<environment_context") {
        return Some("env context".into());
    }
    if t.starts_with("<heartbeat") {
        return Some(match tag_value(t, "automation_id") {
            Some(id) => format!("heartbeat {id}"),
            None => "heartbeat".into(),
        });
    }
    if t.starts_with("<skill") {
        return Some(match tag_value(t, "name") {
            Some(name) => format!("skill {name}"),
            None => "skill".into(),
        });
    }
    if t.starts_with("<permissions") {
        return Some("permissions".into());
    }
    if t.starts_with("<system")
        || t.starts_with("<user_instructions")
        || t.starts_with("<turn_context")
    {
        return Some("instructions".into());
    }
    if t.starts_with("# AGENTS.md") || t.starts_with("# AGENTS") {
        return Some("agents.md".into());
    }
    if t.starts_with("The following is the Codex agent history") {
        return Some("approval review".into());
    }
    if let Some(rest) = t.strip_prefix("New broker ask from ") {
        let from: String = rest
            .chars()
            .take_while(|c| !c.is_whitespace())
            .take(28)
            .collect();
        return Some(format!("broker ask {from}"));
    }
    None
}

fn tag_value(text: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = text.find(&open)? + open.len();
    let end = text[start..].find(&close)? + start;
    let value = text[start..end].trim();
    if value.is_empty() {
        None
    } else {
        Some(shorten(value, 32))
    }
}

fn json_brief(text: &str) -> String {
    let Ok(Value::Object(map)) = serde_json::from_str::<Value>(text) else {
        return "json".into();
    };
    let mut parts: Vec<String> = Vec::new();
    for key in [
        "outcome",
        "decision",
        "risk_level",
        "status",
        "action",
        "type",
    ] {
        if let Some(value) = map.get(key).and_then(scalar) {
            parts.push(format!("{key} {value}"));
        }
    }
    if parts.is_empty() {
        for (key, value) in map.iter().take(3) {
            if let Some(value) = scalar(value) {
                parts.push(format!("{key} {value}"));
            }
        }
    }
    if parts.is_empty() {
        "json".into()
    } else {
        parts.join(" · ")
    }
}

fn scalar(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(shorten(s, 24)),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

fn clean_plan(summary: &str) -> String {
    clean_summary(&summary.replace("**", ""))
}

fn sys_label(summary: &str) -> String {
    match summary {
        "task started" => "task start".into(),
        other => clean_summary(other),
    }
}

fn shorten(text: &str, max: usize) -> String {
    let collapsed: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let chars: Vec<char> = collapsed.chars().collect();
    if chars.len() <= max {
        return collapsed;
    }
    let mut out: String = chars.into_iter().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}
