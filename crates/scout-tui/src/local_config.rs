//! Local Scout endpoints from env and `~/.openscout/config.json`.
//! Port numbers are never invented here; they come from the operator's config.

use std::collections::HashMap;
use std::env;
use std::fs;
use std::net::IpAddr;
use std::path::PathBuf;

use serde::Deserialize;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Endpoint {
    pub host: String,
    pub port: u16,
}

#[derive(Clone, Debug, Default, Deserialize)]
struct FileConfig {
    host: Option<String>,
    ports: Option<FilePorts>,
}

#[derive(Clone, Debug, Default, Deserialize)]
struct FilePorts {
    broker: Option<u16>,
    web: Option<u16>,
}

pub fn broker_endpoint() -> Result<Endpoint, String> {
    broker_endpoint_from(&process_env(), load_file_config())
}

pub fn web_endpoint() -> Result<Endpoint, String> {
    web_endpoint_from(&process_env(), load_file_config())
}

fn process_env() -> HashMap<String, String> {
    env::vars().collect()
}

fn env_value(env: &HashMap<String, String>, key: &str) -> Option<String> {
    env.get(key)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn env_port(env: &HashMap<String, String>, key: &str) -> Option<u16> {
    env_value(env, key).and_then(|value| value.parse().ok())
}

fn load_file_config() -> FileConfig {
    let path = local_config_path();
    let Ok(text) = fs::read_to_string(path) else {
        return FileConfig::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn local_config_path() -> PathBuf {
    if let Some(home) = env::var("OPENSCOUT_HOME")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        return PathBuf::from(home).join("config.json");
    }
    let home = env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join(".openscout/config.json")
}

fn connect_host(host: &str) -> String {
    match host.trim() {
        "" | "0.0.0.0" | "::" | "[::]" => "127.0.0.1".into(),
        other => other.to_string(),
    }
}

fn configured_host(env: &HashMap<String, String>, file: &FileConfig) -> Option<String> {
    env_value(env, "OPENSCOUT_BROKER_HOST")
        .or_else(|| env_value(env, "OPENSCOUT_HOST"))
        .or_else(|| file.host.clone())
}

fn broker_endpoint_from(
    env: &HashMap<String, String>,
    file: FileConfig,
) -> Result<Endpoint, String> {
    let url_authority = env_value(env, "OPENSCOUT_BROKER_INTERNAL_URL")
        .or_else(|| env_value(env, "OPENSCOUT_BROKER_URL"))
        .as_deref()
        .and_then(parse_http_authority);
    let port = url_authority
        .as_ref()
        .and_then(|authority| authority.port)
        .or_else(|| env_port(env, "OPENSCOUT_BROKER_PORT"))
        .or(file.ports.as_ref().and_then(|ports| ports.broker))
        .ok_or_else(|| {
            "broker port is not configured (set OPENSCOUT_BROKER_PORT or run scout setup)"
                .to_string()
        })?;
    let host = url_authority
        .as_ref()
        .map(|authority| connect_host(&authority.host))
        .or_else(|| configured_host(env, &file).map(|host| connect_host(&host)))
        .unwrap_or_else(|| "127.0.0.1".into());
    Ok(Endpoint { host, port })
}

fn web_endpoint_from(env: &HashMap<String, String>, file: FileConfig) -> Result<Endpoint, String> {
    let url = env_value(env, "OPENSCOUT_WEB_URL").or_else(|| env_value(env, "SCOUT_WEB_URL"));
    let parsed = url
        .as_deref()
        .map(|value| {
            parse_http_authority(value)
                .ok_or_else(|| "web URL must be an http:// or https:// URL with a host".to_string())
        })
        .transpose()?;
    if parsed
        .as_ref()
        .is_some_and(|authority| authority.scheme == HttpScheme::Https)
    {
        return Err(
            "https web URLs are unsupported by the local TUI transport; use the loopback Scout web endpoint"
                .into(),
        );
    }
    let port = parsed
        .as_ref()
        .and_then(|authority| authority.port)
        .or_else(|| env_port(env, "OPENSCOUT_WEB_PORT"))
        .or_else(|| env_port(env, "SCOUT_WEB_PORT"))
        .or(file.ports.as_ref().and_then(|ports| ports.web))
        .ok_or_else(|| {
            "web port is not configured (set OPENSCOUT_WEB_PORT or run scout setup)".to_string()
        })?;
    let host = parsed
        .as_ref()
        .map(|authority| connect_host(&authority.host))
        .or_else(|| configured_host(env, &file).map(|host| connect_host(&host)))
        .unwrap_or_else(|| "127.0.0.1".into());
    if !is_loopback_host(&host) {
        return Err(
            "the TUI providers feed only accepts a loopback web endpoint so local credentials cannot leave this machine"
                .into(),
        );
    }
    Ok(Endpoint { host, port })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HttpScheme {
    Http,
    Https,
}

struct Authority {
    scheme: HttpScheme,
    host: String,
    port: Option<u16>,
}

fn parse_http_authority(url: &str) -> Option<Authority> {
    let trimmed = url.trim();
    let (scheme, rest) = if let Some(rest) = trimmed.strip_prefix("http://") {
        (HttpScheme::Http, rest)
    } else if let Some(rest) = trimmed.strip_prefix("https://") {
        (HttpScheme::Https, rest)
    } else {
        return None;
    };
    let authority = rest.split('/').next().unwrap_or(rest).trim();
    if authority.is_empty() {
        return None;
    }
    if let Some(bracketed) = authority.strip_prefix('[') {
        let (host, suffix) = bracketed.split_once(']')?;
        let port = if suffix.is_empty() {
            None
        } else {
            suffix.strip_prefix(':')?.parse().ok()
        };
        return Some(Authority {
            scheme,
            host: host.to_string(),
            port,
        });
    }
    if let Some((host, port)) = authority.rsplit_once(':') {
        if host.is_empty() {
            return None;
        }
        return Some(Authority {
            scheme,
            host: host.to_string(),
            port: port.parse().ok(),
        });
    }
    Some(Authority {
        scheme,
        host: authority.to_string(),
        port: None,
    })
}

fn is_loopback_host(host: &str) -> bool {
    let normalized = host.trim().trim_start_matches('[').trim_end_matches(']');
    normalized.eq_ignore_ascii_case("localhost")
        || normalized
            .parse::<IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect()
    }

    fn file(host: &str, broker: u16, web: u16) -> FileConfig {
        FileConfig {
            host: Some(host.into()),
            ports: Some(FilePorts {
                broker: Some(broker),
                web: Some(web),
            }),
        }
    }

    #[test]
    fn web_url_supplies_loopback_host_and_port() {
        let endpoint = web_endpoint_from(
            &env(&[("OPENSCOUT_WEB_URL", "http://localhost:43201")]),
            FileConfig::default(),
        )
        .expect("web endpoint");
        assert_eq!(endpoint.host, "localhost");
        assert_eq!(endpoint.port, 43201);
    }

    #[test]
    fn non_loopback_web_url_is_rejected_before_credentials_can_be_loaded() {
        let error = web_endpoint_from(
            &env(&[("OPENSCOUT_WEB_URL", "http://10.0.0.8:43201")]),
            FileConfig::default(),
        )
        .expect_err("remote plaintext endpoint");
        assert!(error.contains("only accepts a loopback web endpoint"));
    }

    #[test]
    fn https_web_url_is_rejected_instead_of_downgraded_to_plaintext() {
        let error = web_endpoint_from(
            &env(&[("OPENSCOUT_WEB_URL", "https://127.0.0.1:43201")]),
            FileConfig::default(),
        )
        .expect_err("unsupported tls transport");
        assert!(error.contains("https web URLs are unsupported"));
    }

    #[test]
    fn configured_non_loopback_web_host_is_rejected() {
        let error = web_endpoint_from(&HashMap::new(), file("192.0.2.10", 9, 43210))
            .expect_err("remote configured host");
        assert!(error.contains("only accepts a loopback web endpoint"));
    }

    #[test]
    fn bracketed_ipv6_loopback_web_url_is_supported() {
        let endpoint = web_endpoint_from(
            &env(&[("OPENSCOUT_WEB_URL", "http://[::1]:43201")]),
            FileConfig::default(),
        )
        .expect("ipv6 loopback endpoint");
        assert_eq!(endpoint.host, "::1");
        assert_eq!(endpoint.port, 43201);
    }

    #[test]
    fn web_url_without_port_uses_configured_port() {
        let endpoint = web_endpoint_from(
            &env(&[("OPENSCOUT_WEB_URL", "http://127.0.0.1")]),
            file("127.0.0.1", 9, 43210),
        )
        .expect("web endpoint");
        assert_eq!(endpoint.port, 43210);
    }

    #[test]
    fn env_port_overrides_file_port() {
        let endpoint = web_endpoint_from(
            &env(&[("OPENSCOUT_WEB_PORT", "43222")]),
            file("127.0.0.1", 9, 43210),
        )
        .expect("web endpoint");
        assert_eq!(endpoint.port, 43222);
    }

    #[test]
    fn missing_web_port_is_an_error_not_a_default() {
        let error =
            web_endpoint_from(&HashMap::new(), FileConfig::default()).expect_err("missing port");
        assert!(error.contains("web port is not configured"));
    }

    #[test]
    fn broker_url_and_file_config_resolve_without_hardcoded_ports() {
        let from_url = broker_endpoint_from(
            &env(&[("OPENSCOUT_BROKER_URL", "http://127.0.0.1:43200")]),
            FileConfig::default(),
        )
        .expect("broker url");
        assert_eq!(from_url.port, 43200);

        let from_file =
            broker_endpoint_from(&HashMap::new(), file("0.0.0.0", 43211, 1)).expect("broker file");
        assert_eq!(from_file.host, "127.0.0.1");
        assert_eq!(from_file.port, 43211);
    }
}
