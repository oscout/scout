use std::net::TcpStream;
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::http;
use crate::local_config;

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TailEvent {
    /// Transport-local offset identity. Retained for diagnostics only; disk
    /// hydration and live tail assign different ids to the same transcript row.
    #[allow(dead_code)]
    pub id: String,
    pub ts: i64,
    pub source: String,
    pub session_id: String,
    pub kind: String,
    pub summary: String,
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    /// Kept only through ingest so classify can read tool names/args, then dropped.
    #[serde(default)]
    pub raw: Option<serde_json::Value>,
}

pub struct Snapshot {
    pub events: Vec<TailEvent>,
    pub error: Option<String>,
    pub fetched_at: Instant,
}

pub fn spawn_tail() -> Receiver<Snapshot> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        match fetch_recent() {
            Ok(events) => {
                let _ = tx.send(Snapshot {
                    events,
                    error: None,
                    fetched_at: Instant::now(),
                });
            }
            Err(err) => {
                let _ = tx.send(Snapshot {
                    events: Vec::new(),
                    error: Some(err),
                    fetched_at: Instant::now(),
                });
            }
        }

        let mut backoff = Duration::from_millis(250);
        loop {
            match subscribe_once(&tx) {
                Ok(()) => break,
                Err(err) => {
                    if tx
                        .send(Snapshot {
                            events: Vec::new(),
                            error: Some(err),
                            fetched_at: Instant::now(),
                        })
                        .is_err()
                    {
                        break;
                    }
                    thread::sleep(backoff);
                    backoff = (backoff * 2).min(Duration::from_secs(8));
                }
            }
        }
    });
    rx
}

pub fn broker_endpoint() -> Result<local_config::Endpoint, String> {
    local_config::broker_endpoint()
}

pub fn fetch_recent() -> Result<Vec<TailEvent>, String> {
    let mut last = String::new();
    for attempt in 0..4 {
        match fetch_recent_once() {
            Ok(events) => return Ok(events),
            Err(err) => {
                last = err;
                if !is_transient(&last) {
                    break;
                }
                thread::sleep(Duration::from_millis(180 * (attempt + 1)));
            }
        }
    }
    Err(last)
}

fn is_transient(err: &str) -> bool {
    let lower = err.to_ascii_lowercase();
    lower.contains("temporarily")
        || lower.contains("wouldblock")
        || lower.contains("timed out")
        || lower.contains("os error 35")
        || lower.contains("connection reset")
}

fn fetch_recent_once() -> Result<Vec<TailEvent>, String> {
    let value = http_json("GET", "/v1/tail/recent?transcripts=true&limit=1200")?;
    let events = value
        .get("events")
        .cloned()
        .ok_or_else(|| "recent: missing events".to_string())?;
    serde_json::from_value(events).map_err(|err| format!("recent json {err}"))
}

fn http_json(method: &str, path: &str) -> Result<serde_json::Value, String> {
    let endpoint = broker_endpoint()?;
    let resp = http::request(
        &endpoint.host,
        endpoint.port,
        method,
        path,
        &[],
        Duration::from_secs(8),
    )?;
    if resp.status != 200 {
        let status = resp
            .header_text
            .lines()
            .next()
            .unwrap_or("http error")
            .to_string();
        return Err(status);
    }
    http::json(&resp)
}

fn subscribe_once(tx: &mpsc::Sender<Snapshot>) -> Result<(), String> {
    let endpoint = broker_endpoint()?;
    let stream = TcpStream::connect((endpoint.host.as_str(), endpoint.port))
        .map_err(|err| format!("connect {err}"))?;
    stream
        .set_nodelay(true)
        .map_err(|err| format!("nodelay {err}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(15)))
        .map_err(|err| format!("timeout {err}"))?;
    let url = format!("ws://{}:{}/trpc", endpoint.host, endpoint.port);
    let (mut ws, _response) =
        tungstenite::client(&url, stream).map_err(|err| format!("handshake {err}"))?;
    let _ = ws.get_mut().set_read_timeout(None);
    ws.send(tungstenite::Message::Text(
        r#"{"id":1,"method":"subscription","params":{"path":"tail.events","input":{}}}"#.into(),
    ))
    .map_err(|err| format!("sub {err}"))?;

    loop {
        match ws.read().map_err(|err| format!("read {err}"))? {
            tungstenite::Message::Text(text) => {
                if let Some(kind) = trpc_result_type(text.as_str()) {
                    if kind == "started" {
                        let _ = tx.send(Snapshot {
                            events: Vec::new(),
                            error: None,
                            fetched_at: Instant::now(),
                        });
                        continue;
                    }
                    if kind == "error" {
                        return Err(format!("trpc {text}"));
                    }
                }
                if let Some(event) = parse_trpc_tail_event(text.as_str()) {
                    if tx
                        .send(Snapshot {
                            events: vec![event],
                            error: None,
                            fetched_at: Instant::now(),
                        })
                        .is_err()
                    {
                        return Ok(());
                    }
                }
            }
            tungstenite::Message::Ping(payload) => {
                let _ = ws.send(tungstenite::Message::Pong(payload));
            }
            tungstenite::Message::Close(_) => return Err("closed".into()),
            _ => {}
        }
    }
}

fn trpc_result_type(text: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    value.pointer("/result/type")?.as_str().map(str::to_string)
}

fn parse_trpc_tail_event(text: &str) -> Option<TailEvent> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    if value.get("error").is_some() && !value.get("error").unwrap().is_null() {
        return None;
    }
    let data = value.pointer("/result/data")?;
    if let Some(inner) = data.get("data") {
        if let Ok(event) = serde_json::from_value::<TailEvent>(inner.clone()) {
            return Some(event);
        }
    }
    serde_json::from_value::<TailEvent>(data.clone()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const EVENT: &str = r#"{
        "id":"evt-1",
        "ts":1700000000000,
        "source":"codex",
        "sessionId":"session-1",
        "kind":"assistant",
        "summary":"done"
    }"#;

    #[test]
    fn parses_direct_trpc_subscription_data() {
        let text = format!(r#"{{"result":{{"data":{EVENT}}}}}"#);

        let event = parse_trpc_tail_event(&text).expect("direct event");
        assert_eq!(event.id, "evt-1");
        assert_eq!(event.session_id, "session-1");
    }

    #[test]
    fn parses_nested_trpc_subscription_data() {
        let text = format!(r#"{{"result":{{"data":{{"data":{EVENT}}}}}}}"#);

        let event = parse_trpc_tail_event(&text).expect("nested event");
        assert_eq!(event.source, "codex");
        assert_eq!(event.summary, "done");
    }

    #[test]
    fn ignores_trpc_error_payloads() {
        let text = r#"{"error":{"message":"subscription failed"},"result":{"data":null}}"#;

        assert!(parse_trpc_tail_event(text).is_none());
    }
}
