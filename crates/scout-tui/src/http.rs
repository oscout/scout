use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

pub struct HttpResponse {
    pub status: u16,
    pub header_text: String,
    pub body: Vec<u8>,
}

pub fn request(
    host: &str,
    port: u16,
    method: &str,
    path: &str,
    extra_headers: &[(&str, &str)],
    timeout: Duration,
) -> Result<HttpResponse, String> {
    let mut stream = TcpStream::connect((host, port)).map_err(|err| format!("connect {err}"))?;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|err| format!("timeout {err}"))?;
    let mut req =
        format!("{method} {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n");
    for (name, value) in extra_headers {
        req.push_str(&format!("{name}: {value}\r\n"));
    }
    req.push_str("\r\n");
    stream
        .write_all(req.as_bytes())
        .map_err(|err| format!("write {err}"))?;
    let mut buf = Vec::new();
    stream
        .read_to_end(&mut buf)
        .map_err(|err| format!("read {err}"))?;
    let split = buf
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "http: no header terminator".to_string())?;
    let header_text = String::from_utf8_lossy(&buf[..split]).into_owned();
    let status = status_code(&header_text);
    let mut body = buf[split + 4..].to_vec();
    if header_text
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked")
    {
        body = decode_chunked(&body)?;
    }
    Ok(HttpResponse {
        status,
        header_text,
        body,
    })
}

pub fn json(resp: &HttpResponse) -> Result<serde_json::Value, String> {
    serde_json::from_slice(&resp.body).map_err(|err| format!("json {err}"))
}

pub fn cookie_from_set_cookie(header_text: &str, cookie_name: &str) -> Option<String> {
    let prefix = format!("{cookie_name}=");
    for line in header_text.lines() {
        if !line.to_ascii_lowercase().starts_with("set-cookie:") {
            continue;
        }
        let value = line.split_once(':')?.1.trim();
        if let Some(rest) = value.strip_prefix(&prefix) {
            let token = rest.split(';').next()?.trim();
            if !token.is_empty() {
                return Some(format!("{cookie_name}={token}"));
            }
        }
    }
    None
}

fn status_code(header_text: &str) -> u16 {
    header_text
        .lines()
        .next()
        .and_then(|line| {
            line.split_whitespace()
                .nth(1)
                .and_then(|code| code.parse().ok())
        })
        .unwrap_or(0)
}

pub fn decode_chunked(input: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut rest = input;
    loop {
        let line_end = rest
            .windows(2)
            .position(|window| window == b"\r\n")
            .ok_or_else(|| "chunk: missing size".to_string())?;
        let size_line = std::str::from_utf8(&rest[..line_end]).map_err(|err| err.to_string())?;
        let size = usize::from_str_radix(size_line.trim(), 16)
            .map_err(|err| format!("chunk size {err}"))?;
        rest = &rest[line_end + 2..];
        if size == 0 {
            break;
        }
        if rest.len() < size + 2 {
            return Err("chunk: truncated".into());
        }
        out.extend_from_slice(&rest[..size]);
        rest = &rest[size + 2..];
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_chunked_http_bodies() {
        let decoded =
            decode_chunked(b"4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n").expect("chunked body");

        assert_eq!(decoded, b"Wikipedia");
    }

    #[test]
    fn reads_session_cookie_from_set_cookie() {
        let headers = "HTTP/1.1 200 OK\r\n\
Set-Cookie: openscout_web_session=local-secret; Path=/; HttpOnly; SameSite=Strict\r\n\
Content-Type: application/javascript";

        assert_eq!(
            cookie_from_set_cookie(headers, "openscout_web_session").as_deref(),
            Some("openscout_web_session=local-secret")
        );
    }
}
