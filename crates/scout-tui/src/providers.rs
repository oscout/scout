//! Live provider quota windows from the same `/api/service-budgets` feed
//! that the web Providers page and `scout providers usage` already use.

use std::env;
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;

use crate::app::{Plan, QuotaWindow};
use crate::http;
use crate::local_config;

const WEB_AUTH_COOKIE: &str = "openscout_web_session";
const BOOTSTRAP_PATH: &str = "/api/bootstrap.js";
const BUDGETS_PATH: &str = "/api/service-budgets";
const SPARK_POINTS: usize = 16;
const HOUR_MS: i64 = 60 * 60 * 1000;
const DAY_MS: i64 = 24 * HOUR_MS;

pub struct ProviderSnapshot {
    pub plans: Vec<Plan>,
    pub error: Option<String>,
    pub ready: bool,
}

pub fn spawn_providers() -> Receiver<ProviderSnapshot> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut cookie: Option<String> = None;
        loop {
            match fetch_plans(cookie.as_deref()) {
                Ok(FetchResult {
                    plans,
                    cookie: next_cookie,
                }) => {
                    cookie = next_cookie.or(cookie);
                    if tx
                        .send(ProviderSnapshot {
                            plans,
                            error: None,
                            ready: true,
                        })
                        .is_err()
                    {
                        return;
                    }
                }
                Err(err) => {
                    if tx
                        .send(ProviderSnapshot {
                            plans: Vec::new(),
                            error: Some(err),
                            ready: true,
                        })
                        .is_err()
                    {
                        return;
                    }
                }
            }
            thread::sleep(Duration::from_secs(30));
        }
    });
    rx
}

struct FetchResult {
    plans: Vec<Plan>,
    cookie: Option<String>,
}

fn fetch_plans(existing_cookie: Option<&str>) -> Result<FetchResult, String> {
    let endpoint = local_config::web_endpoint()?;
    let host = endpoint.host;
    let port = endpoint.port;
    let now_ms = now_ms();
    let mut headers = vec![("Accept", "application/json".to_string())];
    if let Some(token) = web_auth_token() {
        headers.push(("Authorization", format!("Bearer {token}")));
    }
    if let Some(cookie) = existing_cookie {
        headers.push(("Cookie", cookie.to_string()));
    }

    let header_refs: Vec<(&str, &str)> = headers
        .iter()
        .map(|(name, value)| (*name, value.as_str()))
        .collect();
    let resp = http::request(
        &host,
        port,
        "GET",
        BUDGETS_PATH,
        &header_refs,
        Duration::from_secs(25),
    )
    .map_err(|err| format!("providers feed: {err}"))?;

    if resp.status == 401 {
        let cookie = bootstrap_cookie(&host, port)?;
        let retry_headers = [("Accept", "application/json"), ("Cookie", cookie.as_str())];
        let retry = http::request(
            &host,
            port,
            "GET",
            BUDGETS_PATH,
            &retry_headers,
            Duration::from_secs(25),
        )
        .map_err(|err| format!("providers feed: {err}"))?;
        if retry.status != 200 {
            return Err(status_error(&retry));
        }
        let value = http::json(&retry).map_err(|err| format!("providers feed: {err}"))?;
        return Ok(FetchResult {
            plans: plans_from_payload(&value, now_ms),
            cookie: Some(cookie),
        });
    }

    if resp.status != 200 {
        return Err(status_error(&resp));
    }
    let value = http::json(&resp).map_err(|err| format!("providers feed: {err}"))?;
    Ok(FetchResult {
        plans: plans_from_payload(&value, now_ms),
        cookie: None,
    })
}

fn bootstrap_cookie(host: &str, port: u16) -> Result<String, String> {
    let resp = http::request(
        host,
        port,
        "GET",
        BOOTSTRAP_PATH,
        &[("Accept", "application/javascript")],
        Duration::from_secs(8),
    )
    .map_err(|err| format!("providers auth: {err}"))?;
    if resp.status != 200 {
        return Err("providers feed unauthorized".into());
    }
    http::cookie_from_set_cookie(&resp.header_text, WEB_AUTH_COOKIE)
        .ok_or_else(|| "providers feed unauthorized".into())
}

fn status_error(resp: &http::HttpResponse) -> String {
    if let Ok(value) = http::json(resp) {
        if let Some(error) = value.get("error").and_then(|v| v.as_str()) {
            if !error.trim().is_empty() {
                return format!("providers feed: {error}");
            }
        }
    }
    let status = resp
        .header_text
        .lines()
        .next()
        .unwrap_or("providers feed error");
    format!("providers feed: {status}")
}

fn web_auth_token() -> Option<String> {
    if let Ok(token) = env::var("OPENSCOUT_WEB_AUTH_TOKEN") {
        let trimmed = token.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    let path = web_auth_token_path()?;
    std::fs::read_to_string(path)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn web_auth_token_path() -> Option<PathBuf> {
    if let Ok(support) = env::var("OPENSCOUT_SUPPORT_DIRECTORY") {
        let trimmed = support.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed).join("runtime/web-auth-token"));
        }
    }
    let home = env::var("HOME")
        .ok()
        .filter(|value| !value.trim().is_empty())?;
    Some(PathBuf::from(home).join("Library/Application Support/OpenScout/runtime/web-auth-token"))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServiceBudgetsPayload {
    gauges: Option<Vec<ServiceGaugePayload>>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ServiceGaugePayload {
    id: Option<String>,
    label: Option<String>,
    kind: Option<String>,
    fill: Option<f64>,
    used_label: Option<String>,
    unit_label: Option<String>,
    reset_at: Option<i64>,
    windows: Option<Vec<ServiceWindowPayload>>,
    plan: Option<String>,
    captured_at: Option<i64>,
    source: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ServiceWindowPayload {
    label: Option<String>,
    fill: Option<f64>,
    used_label: Option<String>,
    unit_label: Option<String>,
    reset_at: Option<i64>,
    window_ms: Option<i64>,
    captured_at: Option<i64>,
    source: Option<String>,
    history: Option<Vec<HistoryPoint>>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct HistoryPoint {
    fill: Option<f64>,
}

pub fn plans_from_payload(value: &serde_json::Value, now_ms: i64) -> Vec<Plan> {
    let payload: ServiceBudgetsPayload = match serde_json::from_value(value.clone()) {
        Ok(payload) => payload,
        Err(_) => return Vec::new(),
    };
    payload
        .gauges
        .unwrap_or_default()
        .into_iter()
        .filter_map(|gauge| plan_from_gauge(gauge, now_ms))
        .collect()
}

fn plan_from_gauge(gauge: ServiceGaugePayload, now_ms: i64) -> Option<Plan> {
    if gauge.kind.as_deref() != Some("quota") {
        return None;
    }
    let windows: Vec<QuotaWindow> = windows_from_gauge(&gauge)
        .into_iter()
        .filter_map(|window| quota_window_from_payload(&window, &gauge, now_ms))
        .collect();
    if windows.is_empty() {
        return None;
    }

    let id = gauge
        .id
        .clone()
        .or_else(|| gauge.label.clone())
        .unwrap_or_else(|| "unknown".into());
    let binding = windows
        .iter()
        .min_by_key(|window| 100u8.saturating_sub(window.used))
        .cloned();
    let remaining = binding
        .as_ref()
        .map(|window| 100u8.saturating_sub(window.used));
    let paced = windows
        .iter()
        .find(|window| window.pace != "pace unknown")
        .cloned()
        .or_else(|| windows.first().cloned());
    let stale = windows.iter().any(|window| window.confidence == "stale");
    let fresh = windows.iter().any(|window| window.confidence == "fresh");
    let confidence = if stale {
        "stale"
    } else if fresh {
        "fresh"
    } else {
        "unknown"
    };

    Some(Plan {
        id: id.clone(),
        name: provider_label(&id, gauge.label.as_deref()),
        plan: gauge.plan.unwrap_or_default(),
        source: gauge
            .source
            .or_else(|| windows.first().map(|window| window.source.clone()))
            .unwrap_or_else(|| "provider report".into()),
        availability: availability_from_remaining(remaining).into(),
        confidence: confidence.into(),
        burn_rate: paced
            .as_ref()
            .map(|window| window.pace.clone())
            .unwrap_or_else(|| "pace unknown".into()),
        primary_roles: Vec::new(),
        failover: String::new(),
        windows,
        status: None,
    })
}

fn windows_from_gauge(gauge: &ServiceGaugePayload) -> Vec<ServiceWindowPayload> {
    let windows = gauge.windows.clone().unwrap_or_default();
    if !windows.is_empty() {
        return windows;
    }
    vec![ServiceWindowPayload {
        label: Some(legacy_window_label(gauge.unit_label.as_deref())),
        fill: gauge.fill,
        used_label: gauge.used_label.clone(),
        unit_label: gauge.unit_label.clone(),
        reset_at: gauge.reset_at,
        window_ms: None,
        captured_at: gauge.captured_at,
        source: gauge.source.clone(),
        history: None,
    }]
}

fn quota_window_from_payload(
    window: &ServiceWindowPayload,
    gauge: &ServiceGaugePayload,
    now_ms: i64,
) -> Option<QuotaWindow> {
    let used = used_percent(window.fill, window.used_label.as_deref())?;
    let label = window
        .label
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| legacy_window_label(window.unit_label.as_deref()));
    let reset_at = window.reset_at.or(gauge.reset_at);
    let captured_at = window.captured_at.or(gauge.captured_at);
    let window_ms = window
        .window_ms
        .or_else(|| infer_window_ms(&label, reset_at));
    let (pace, confidence) = pace_and_confidence(used, window_ms, reset_at, captured_at, now_ms);
    let mut spark: Vec<f32> = window
        .history
        .clone()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|point| point.fill.map(|fill| fill.clamp(0.0, 1.0) as f32))
        .collect();
    if spark.is_empty() {
        spark.push((used as f32) / 100.0);
    } else if spark.len() > SPARK_POINTS {
        spark = spark.split_off(spark.len() - SPARK_POINTS);
    }

    Some(QuotaWindow {
        label,
        used,
        reset: format_reset(reset_at, now_ms),
        spark,
        pace,
        confidence,
        source: window
            .source
            .clone()
            .or_else(|| gauge.source.clone())
            .unwrap_or_else(|| "provider report".into()),
    })
}

fn used_percent(fill: Option<f64>, used_label: Option<&str>) -> Option<u8> {
    if let Some(fill) = fill {
        return Some(((fill.clamp(0.0, 1.0) * 100.0).round() as i32).clamp(0, 100) as u8);
    }
    let label = used_label?.trim().trim_end_matches('%');
    label
        .parse::<f64>()
        .ok()
        .map(|percent| percent.clamp(0.0, 100.0).round() as u8)
}

fn pace_and_confidence(
    used: u8,
    window_ms: Option<i64>,
    reset_at: Option<i64>,
    captured_at: Option<i64>,
    now_ms: i64,
) -> (String, String) {
    let elapsed_percent = match (window_ms, reset_at) {
        (Some(duration), Some(reset)) if duration > 0 => {
            let remaining = (reset - now_ms) as f64;
            let elapsed = 100.0 - (remaining / duration as f64) * 100.0;
            Some(elapsed.clamp(0.0, 100.0))
        }
        _ => None,
    };
    let pace = match elapsed_percent {
        Some(elapsed) if elapsed >= 1.0 => {
            let ratio = used as f64 / elapsed;
            let delta = used as f64 - elapsed;
            if ratio > 1.1 && delta > 3.0 {
                "ahead of pace"
            } else if ratio < 0.7 && delta < -10.0 {
                "underused"
            } else {
                "on track"
            }
        }
        _ => "pace unknown",
    };
    let stale_after = window_ms
        .map(|duration| duration.clamp(HOUR_MS, DAY_MS) / 4)
        .unwrap_or(DAY_MS);
    let confidence = match captured_at {
        Some(captured) if now_ms.saturating_sub(captured) > stale_after => "stale",
        Some(_) => "fresh",
        None => "unknown",
    };
    (pace.into(), confidence.into())
}

fn availability_from_remaining(remaining: Option<u8>) -> &'static str {
    match remaining {
        Some(value) if value >= 60 => "abundant",
        Some(value) if value >= 30 => "available",
        Some(value) if value >= 15 => "guarded",
        Some(_) => "constrained",
        None => "unknown",
    }
}

fn infer_window_ms(label: &str, reset_at: Option<i64>) -> Option<i64> {
    let normalized = label.trim().to_ascii_lowercase();
    if let Some((value, unit)) = duration_token(&normalized) {
        return Some(if unit == 'h' {
            value * HOUR_MS
        } else {
            value * DAY_MS
        });
    }
    if matches!(normalized.as_str(), "weekly" | "week" | "7-day") {
        return Some(7 * DAY_MS);
    }
    if normalized == "5-hour" {
        return Some(5 * HOUR_MS);
    }
    if matches!(normalized.as_str(), "monthly" | "month") {
        let _ = reset_at;
        return Some(30 * DAY_MS);
    }
    None
}

fn duration_token(label: &str) -> Option<(i64, char)> {
    let token = label.split_whitespace().last()?;
    let unit = token.chars().last()?;
    if unit != 'h' && unit != 'd' {
        return None;
    }
    let value = token[..token.len() - 1].parse::<f64>().ok()?;
    Some((value.round() as i64, unit))
}

fn format_reset(reset_at: Option<i64>, now_ms: i64) -> String {
    let Some(reset_at) = reset_at else {
        return "unknown".into();
    };
    format_relative(reset_at - now_ms)
}

fn format_relative(delta_ms: i64) -> String {
    let past = delta_ms < 0;
    let minutes = delta_ms.abs() / 60_000;
    let value = if minutes < 1 {
        "less than 1m".to_string()
    } else if minutes < 60 {
        format!("{minutes}m")
    } else if minutes < 24 * 60 {
        let hours = minutes / 60;
        let remainder = minutes % 60;
        if remainder > 0 {
            format!("{hours}h {remainder}m")
        } else {
            format!("{hours}h")
        }
    } else {
        let days = minutes / (24 * 60);
        let hours = (minutes % (24 * 60)) / 60;
        if hours > 0 {
            format!("{days}d {hours}h")
        } else {
            format!("{days}d")
        }
    };
    if past {
        format!("{value} ago")
    } else {
        value
    }
}

fn legacy_window_label(label: Option<&str>) -> String {
    match label {
        Some("weekly") => "7d".into(),
        Some("req/h") => "1h".into(),
        Some(value) => value.to_string(),
        None => "quota".into(),
    }
}

fn provider_label(id: &str, label: Option<&str>) -> String {
    match id.trim().to_ascii_lowercase().as_str() {
        "claude" => "Claude".into(),
        "codex" => "Codex".into(),
        "cursor" => "Cursor".into(),
        "github" => "GitHub".into(),
        "grok" => "Grok".into(),
        "kimi" => "Kimi".into(),
        "minimax" => "MiniMax".into(),
        _ => label
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(title_case)
            .unwrap_or_else(|| title_case(id)),
    }
}

fn title_case(value: &str) -> String {
    let mut chars = value.trim().chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => value.to_string(),
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_786_968_000_000;

    fn payload() -> serde_json::Value {
        serde_json::json!({
            "generatedAt": NOW - 2_000,
            "gauges": [
                {
                    "id": "claude",
                    "label": "claude",
                    "kind": "quota",
                    "fill": 0.4,
                    "plan": "Max",
                    "capturedAt": NOW - 60_000,
                    "source": "Claude local status",
                    "windows": [
                        {
                            "label": "5h",
                            "fill": 0.125,
                            "resetAt": NOW + 2 * 60 * 60_000,
                            "windowMs": 5 * 60 * 60_000,
                            "capturedAt": NOW - 60_000,
                            "source": "Claude local status",
                            "history": [
                                { "fill": 0.08 },
                                { "fill": 0.125 }
                            ]
                        },
                        {
                            "label": "7d",
                            "fill": 0.4,
                            "resetAt": NOW + 6 * 24 * 60 * 60_000,
                            "windowMs": 7 * 24 * 60 * 60_000,
                            "capturedAt": NOW - 90_000,
                            "source": "Claude local status"
                        }
                    ]
                },
                {
                    "id": "cursor",
                    "label": "cursor",
                    "kind": "status",
                    "statusLabel": "Pro"
                },
                {
                    "id": "nova-ai",
                    "label": "nova ai",
                    "kind": "quota",
                    "fill": 0.2,
                    "unitLabel": "weekly",
                    "resetAt": NOW + 7 * 24 * 60 * 60_000,
                    "capturedAt": NOW - 30_000,
                    "source": "provider report"
                }
            ]
        })
    }

    #[test]
    fn maps_quota_windows_and_skips_status_gauges() {
        let plans = plans_from_payload(&payload(), NOW);
        assert_eq!(
            plans
                .iter()
                .map(|plan| plan.id.as_str())
                .collect::<Vec<_>>(),
            ["claude", "nova-ai"]
        );
        assert_eq!(plans[0].name, "Claude");
        assert_eq!(plans[0].plan, "Max");
        assert_eq!(plans[0].windows.len(), 2);
        assert_eq!(plans[0].windows[0].label, "5h");
        assert_eq!(plans[0].windows[0].used, 13);
        assert_eq!(plans[0].windows[0].spark, vec![0.08, 0.125]);
        assert_eq!(plans[1].windows[0].label, "7d");
        assert_eq!(plans[1].windows[0].used, 20);
    }

    #[test]
    fn names_an_empty_payload_as_empty_not_a_missing_feed() {
        let plans = plans_from_payload(&serde_json::json!({ "gauges": [] }), NOW);
        assert!(plans.is_empty());
    }
}
