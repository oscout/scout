use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::Duration;

use crate::deliver::{self, Delivery};
use crate::http;
use crate::local_config;
use crate::providers;

const WEB_AUTH_COOKIE: &str = "openscout_web_session";

/// One drafted ask, handed from the draw loop to the ask worker.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AskRequest {
    pub session_id: String,
    pub handle: String,
    pub harness: String,
    pub body: String,
}

/// Posts asks off the draw loop. Each request yields exactly one result.
pub fn spawn_asker() -> (Sender<AskRequest>, Receiver<Result<String, String>>) {
    let (req_tx, req_rx) = mpsc::channel::<AskRequest>();
    let (res_tx, res_rx) = mpsc::channel();
    thread::spawn(move || {
        for req in req_rx {
            let result = post_ask(&req);
            if res_tx.send(result).is_err() {
                break;
            }
        }
    });
    (req_tx, res_rx)
}

/// Generous: a reply may be typed into a terminal or resume a session.
const REPLY_TIMEOUT: Duration = Duration::from_secs(45);

/// Replies to a harness session through the web server's session reply route,
/// which types into the session's live place (Herdr, tmux, Lattices) or
/// resumes it when nothing holds it. Refusals come back in plain words.
pub fn post_ask(req: &AskRequest) -> Result<String, String> {
    // The session's live place first, typed in right here; only a session
    // nothing holds goes to Scout to be resumed.
    match deliver::deliver(&req.session_id, &req.harness, &req.body) {
        Delivery::Sent(location) => return Ok(format!("sent into {location}")),
        Delivery::Refused(why) => return Err(why),
        Delivery::NotLive => {}
    }
    let endpoint = local_config::web_endpoint()?;
    let mut payload = serde_json::json!({
        "sessionId": req.session_id.trim(),
        "body": req.body,
        "source": "scout-tui",
    });
    if !req.harness.trim().is_empty() {
        payload["harness"] = serde_json::Value::from(req.harness.trim());
    }
    let bytes = serde_json::to_vec(&payload).map_err(|err| err.to_string())?;
    let mut headers: Vec<(String, String)> = vec![("Accept".into(), "application/json".into())];
    if let Some(token) = providers::web_auth_token() {
        headers.push(("Authorization".into(), format!("Bearer {token}")));
    }
    let header_refs: Vec<(&str, &str)> = headers
        .iter()
        .map(|(name, value)| (name.as_str(), value.as_str()))
        .collect();
    let post = |headers: &[(&str, &str)]| {
        http::request_with_body(
            &endpoint.host,
            endpoint.port,
            "POST",
            "/api/sessions/reply",
            headers,
            Some(&bytes),
            REPLY_TIMEOUT,
        )
        .map_err(explain_transport)
    };
    let mut resp = post(&header_refs)?;
    if resp.status == 401 {
        let cookie = bootstrap_cookie(&endpoint.host, endpoint.port)?;
        resp = post(&[("Accept", "application/json"), ("Cookie", cookie.as_str())])?;
    }
    interpret_reply(&resp, &req.handle)
}

/// A read that outlives the timeout surfaces as EAGAIN ("Resource
/// temporarily unavailable"); say what that means instead.
fn explain_transport(err: String) -> String {
    if err.starts_with("read ") && (err.contains("os error 35") || err.contains("os error 11")) {
        return "Scout didn't answer in 45s; the reply may still land".into();
    }
    if err.starts_with("connect ") {
        return "Scout isn't running on this Mac, so nothing was sent".into();
    }
    err
}

fn interpret_reply(resp: &http::HttpResponse, handle: &str) -> Result<String, String> {
    if resp.status == 404 {
        return Err("This session isn't open anywhere the TUI can type into, and Scout here can't resume it yet. Nothing was sent.".into());
    }
    let value = http::json(resp).ok();
    let field = |name: &str| {
        value
            .as_ref()
            .and_then(|v| v.get(name))
            .and_then(|v| v.as_str())
            .map(str::to_string)
    };
    let ok = value
        .as_ref()
        .and_then(|v| v.get("ok"))
        .and_then(|v| v.as_bool());
    match ok {
        Some(true) => Ok(match (field("delivery").as_deref(), field("location")) {
            (Some("in_place"), Some(location)) => format!("sent into {location}"),
            _ => format!("sent · resumed {handle}"),
        }),
        Some(false) => Err(field("message").unwrap_or_else(|| "nothing was sent".into())),
        None => Err(field("error")
            .map(|error| format!("{error} ({})", resp.status))
            .unwrap_or_else(|| format!("reply failed ({})", resp.status))),
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

#[cfg(test)]
mod tests {
    use super::{explain_transport, interpret_reply};
    use crate::http::HttpResponse;

    fn resp(status: u16, body: &str) -> HttpResponse {
        HttpResponse {
            status,
            header_text: String::new(),
            body: body.as_bytes().to_vec(),
        }
    }

    #[test]
    fn reply_receipts_say_where_the_words_went() {
        let typed = resp(
            200,
            r#"{"ok":true,"delivery":"in_place","via":"tmux","location":"tmux scout:1.0"}"#,
        );
        assert_eq!(
            interpret_reply(&typed, "claude").unwrap(),
            "sent into tmux scout:1.0"
        );
        let resumed = resp(200, r#"{"ok":true,"mode":"resumed","delivery":"resumed"}"#);
        assert_eq!(
            interpret_reply(&resumed, "claude").unwrap(),
            "sent · resumed claude"
        );
    }

    #[test]
    fn refusals_and_old_servers_read_as_words() {
        let refused = resp(
            200,
            r#"{"ok":false,"code":"session_live_unbound","message":"This session is open in a terminal Scout can't reach."}"#,
        );
        assert_eq!(
            interpret_reply(&refused, "claude").unwrap_err(),
            "This session is open in a terminal Scout can't reach."
        );
        assert!(interpret_reply(&resp(404, "not found"), "claude")
            .unwrap_err()
            .contains("Nothing was sent"));
        assert_eq!(
            explain_transport("read Resource temporarily unavailable (os error 35)".into()),
            "Scout didn't answer in 45s; the reply may still land"
        );
    }
}
