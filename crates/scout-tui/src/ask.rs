use std::time::Duration;

use crate::http;
use crate::local_config;
use crate::providers;

const WEB_AUTH_COOKIE: &str = "openscout_web_session";

pub fn session_target(session_id: &str) -> String {
    let trimmed = session_id.trim();
    if trimmed.is_empty() {
        String::new()
    } else if trimmed.starts_with("session:") {
        trimmed.to_string()
    } else {
        format!("session:{trimmed}")
    }
}

pub fn post_ask(target_id: &str, target_label: &str, body: &str) -> Result<String, String> {
    let endpoint = local_config::web_endpoint()?;
    let continuity = session_target(target_id);
    let label = if target_label.trim().is_empty() {
        continuity.clone()
    } else {
        target_label.trim().to_string()
    };
    let payload = serde_json::json!({
        "body": body,
        "targetAgentId": target_id,
        "targetLabel": continuity,
        "metadata": {
            "source": "scout-tui",
            "originSurface": "scout-tui",
            "targetSessionId": target_id,
            "targetHandle": label,
        }
    });
    let bytes = serde_json::to_vec(&payload).map_err(|err| err.to_string())?;
    let mut headers: Vec<(String, String)> = vec![("Accept".into(), "application/json".into())];
    if let Some(token) = providers::web_auth_token() {
        headers.push(("Authorization".into(), format!("Bearer {token}")));
    }
    let header_refs: Vec<(&str, &str)> = headers
        .iter()
        .map(|(name, value)| (name.as_str(), value.as_str()))
        .collect();
    let resp = http::request_with_body(
        &endpoint.host,
        endpoint.port,
        "POST",
        "/api/ask",
        &header_refs,
        Some(&bytes),
        Duration::from_secs(8),
    )?;
    if resp.status == 401 {
        let cookie = bootstrap_cookie(&endpoint.host, endpoint.port)?;
        let retry_headers = [
            ("Accept", "application/json"),
            ("Cookie", cookie.as_str()),
        ];
        let retry = http::request_with_body(
            &endpoint.host,
            endpoint.port,
            "POST",
            "/api/ask",
            &retry_headers,
            Some(&bytes),
            Duration::from_secs(8),
        )?;
        return interpret_ask(&retry, &label);
    }
    interpret_ask(&resp, &label)
}

fn interpret_ask(resp: &http::HttpResponse, target_label: &str) -> Result<String, String> {
    let value = http::json(resp).ok();
    if resp.status >= 200 && resp.status < 300 {
        let flight = value
            .as_ref()
            .and_then(|v| v.get("flight").and_then(|f| f.get("id")).and_then(|id| id.as_str()))
            .or_else(|| {
                value
                    .as_ref()
                    .and_then(|v| v.get("ref").and_then(|id| id.as_str()))
            });
        return Ok(match flight {
            Some(id) => format!("asked {target_label} · {id}"),
            None => format!("asked {target_label}"),
        });
    }
    let error = value
        .as_ref()
        .and_then(|v| v.get("error").and_then(|e| e.as_str()))
        .unwrap_or("ask failed");
    Err(format!("{error} ({})", resp.status))
}

#[cfg(test)]
mod tests {
    use super::session_target;

    #[test]
    fn session_target_prefixes_bare_ids() {
        assert_eq!(session_target("abc"), "session:abc");
        assert_eq!(session_target("session:abc"), "session:abc");
        assert_eq!(session_target("  sess-1  "), "session:sess-1");
        assert_eq!(session_target(""), "");
    }
}

fn bootstrap_cookie(host: &str, port: u16) -> Result<String, String> {
    let resp = http::request(
        host,
        port,
        "GET",
        "/api/bootstrap.js",
        &[("Accept", "application/javascript")],
        Duration::from_secs(8),
    )?;
    http::cookie_from_set_cookie(&resp.header_text, WEB_AUTH_COOKIE)
        .ok_or_else(|| "ask unauthorized".into())
}
