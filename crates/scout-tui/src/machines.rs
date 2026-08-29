//! Real connected-machine data: this host, tailnet peers from `tailscale status
//! --json`, and scout mesh registry nodes from `scout mesh nodes --json`.
//! Nothing here is invented — if a probe fails, the gap is reported as a gap.

use std::process::Command;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread;
use std::time::{Duration, Instant};

use crate::app::{format_age, local_hostname, Machine, MeshAction, ScoutNode};

const TAILSCALE_FALLBACK: &str = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

pub struct MachineSnapshot {
    pub machines: Vec<Machine>,
    pub error: Option<String>,
    /// False until the scout registry has answered once, so the UI can say the
    /// scout column is still loading instead of reporting zero nodes.
    pub registry_ready: bool,
    /// Result of a Mesh take action. Periodic probes leave this unset.
    pub notice: Option<String>,
}

/// Tailscale answers in milliseconds; `scout mesh nodes` takes tens of seconds.
/// The machine list paints from the fast source and folds the registry in when
/// it lands, then refreshes it on a much slower cadence.
const TAILNET_EVERY: Duration = Duration::from_secs(20);
const REGISTRY_EVERY: Duration = Duration::from_secs(180);

pub fn spawn_machines() -> (Sender<MeshAction>, Receiver<MachineSnapshot>) {
    let (tx, rx) = mpsc::channel();
    let (cmd_tx, cmd_rx) = mpsc::channel();
    thread::spawn(move || {
        let mut nodes: Vec<(String, ScoutNode)> = Vec::new();
        let mut ready = false;
        let mut last_registry: Option<Instant> = None;

        loop {
            if tx.send(collect(&nodes, ready, None)).is_err() {
                return;
            }

            let due = last_registry
                .map(|at| at.elapsed() >= REGISTRY_EVERY)
                .unwrap_or(true);
            if due {
                if let Ok(fresh) = scout_nodes() {
                    nodes = fresh;
                    ready = true;
                }
                last_registry = Some(Instant::now());
                if tx.send(collect(&nodes, ready, None)).is_err() {
                    return;
                }
            }

            match cmd_rx.recv_timeout(TAILNET_EVERY) {
                Ok(action) => {
                    let notice = match &action {
                        MeshAction::Ping { target, label } => mesh_ping(target, label),
                        MeshAction::Join => mesh_join(),
                        MeshAction::Leave => mesh_leave(),
                        MeshAction::Refresh => "registry refreshed".to_string(),
                    };
                    let refresh = !matches!(action, MeshAction::Ping { .. });
                    if refresh {
                        if let Ok(fresh) = scout_nodes() {
                            nodes = fresh;
                            ready = true;
                        }
                        last_registry = Some(Instant::now());
                    }
                    if tx.send(collect(&nodes, ready, Some(notice))).is_err() {
                        return;
                    }
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
    });
    (cmd_tx, rx)
}

/// Address `scout mesh ping` understands: broker URL, else DNS / host name.
pub fn ping_target(machine: &Machine) -> Option<String> {
    if let Some(url) = machine
        .scout
        .as_ref()
        .map(|node| node.broker_url.trim())
        .filter(|url| !url.is_empty())
    {
        return Some(url.to_string());
    }
    let host = if !machine.dns_name.trim().is_empty() {
        machine.dns_name.trim()
    } else {
        machine.name.trim()
    };
    let host = host.trim_end_matches('.');
    if host.is_empty() {
        None
    } else {
        Some(host.to_string())
    }
}

fn mesh_ping(target: &str, label: &str) -> String {
    match run_json("scout", &["mesh", "ping", target, "--json"]) {
        Ok(value) => notice_from_ping(label, &value),
        Err(err) => format!("ping {label} failed · {err}"),
    }
}

fn mesh_join() -> String {
    match run_json("scout", &["mesh", "join", "--json"]) {
        Ok(value) => notice_from_join(&value),
        Err(err) => format!("announce failed · {err}"),
    }
}

fn mesh_leave() -> String {
    match run_json("scout", &["mesh", "leave", "--json"]) {
        Ok(value) => notice_from_leave(&value),
        Err(err) => format!("withdraw failed · {err}"),
    }
}

pub fn notice_from_ping(label: &str, value: &serde_json::Value) -> String {
    let reachable = value
        .get("reachable")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let latency = int_field(value, "latencyMs");
    let url = value.get("url").and_then(|v| v.as_str()).unwrap_or("");
    let error = value
        .get("error")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if reachable {
        if url.is_empty() {
            format!("ping {label} · {latency}ms")
        } else {
            format!("ping {label} · {latency}ms · {url}")
        }
    } else {
        format!("ping {label} failed · {}", error.unwrap_or("unreachable"))
    }
}

pub fn notice_from_join(value: &serde_json::Value) -> String {
    let count = value
        .pointer("/discovery/discoveredCount")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let scope = value
        .pointer("/localNode/advertiseScope")
        .and_then(|v| v.as_str())
        .unwrap_or("mesh");
    let warning = value
        .pointer("/discovery/error")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let peers = if count == 1 { "peer" } else { "peers" };
    match warning {
        Some(warning) => format!("announced · {scope} · {count} {peers} · {warning}"),
        None => format!("announced · {scope} · {count} {peers}"),
    }
}

pub fn notice_from_leave(value: &serde_json::Value) -> String {
    let scope = value
        .pointer("/localNode/advertiseScope")
        .and_then(|v| v.as_str())
        .unwrap_or("local");
    format!("withdrawn · {scope}")
}

fn int_field(value: &serde_json::Value, key: &str) -> u64 {
    value
        .get(key)
        .and_then(|v| v.as_u64())
        .or_else(|| value.get(key).and_then(|v| v.as_f64().map(|n| n as u64)))
        .unwrap_or(0)
}

fn collect(
    nodes: &[(String, ScoutNode)],
    registry_ready: bool,
    notice: Option<String>,
) -> MachineSnapshot {
    let mut machines: Vec<Machine> = Vec::new();
    let mut error = None;

    match tailscale_status() {
        Ok(mut ts) => machines.append(&mut ts),
        Err(err) => error = Some(format!("tailscale: {err}")),
    }

    // The registry is additive: broker-advertising nodes annotate or extend the
    // tailnet list. A missing scout CLI is not an error worth shouting about.
    merge_scout(&mut machines, nodes.to_vec());

    // This machine first, then online peers, then the rest by name.
    machines.sort_by(|a, b| {
        b.is_self
            .cmp(&a.is_self)
            .then_with(|| b.online.cmp(&a.online))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    if machines.is_empty() && error.is_none() {
        error = Some("no machines reported by tailscale or scout mesh".into());
    }

    MachineSnapshot {
        machines,
        error,
        registry_ready,
        notice,
    }
}

fn run_json(bin: &str, args: &[&str]) -> Result<serde_json::Value, String> {
    let out = Command::new(bin)
        .args(args)
        .output()
        .map_err(|err| format!("{bin}: {err}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("{bin} exited {}: {}", out.status, stderr.trim()));
    }
    serde_json::from_slice(&out.stdout).map_err(|err| format!("{bin} json: {err}"))
}

fn tailscale_status() -> Result<Vec<Machine>, String> {
    let value = run_json("tailscale", &["status", "--json"])
        .or_else(|_| run_json(TAILSCALE_FALLBACK, &["status", "--json"]))?;

    let mut machines = Vec::new();
    if let Some(self_node) = value.get("Self") {
        machines.push(parse_node(self_node, true));
    }
    if let Some(peers) = value.get("Peer").and_then(|p| p.as_object()) {
        for peer in peers.values() {
            machines.push(parse_node(peer, false));
        }
    }
    Ok(machines)
}

fn parse_node(v: &serde_json::Value, is_self: bool) -> Machine {
    let str_of = |key: &str| {
        v.get(key)
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string()
    };
    let dns_name = str_of("DNSName").trim_end_matches('.').to_string();
    // The tailnet DNS label is the name Tailscale itself shows, and it stays
    // distinct where HostName does not — phones and tablets all report "localhost".
    let name = {
        let label = dns_name.split('.').next().unwrap_or("").to_string();
        let host = str_of("HostName");
        if !label.is_empty() {
            label
        } else if !host.is_empty() {
            host
        } else if is_self {
            local_hostname()
        } else {
            "unnamed".to_string()
        }
    };
    let ips: Vec<String> = v
        .get("TailscaleIPs")
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|ip| ip.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let ip = ips
        .iter()
        .find(|ip| ip.contains('.'))
        .or_else(|| ips.first())
        .cloned()
        .unwrap_or_default();
    let online = is_self || v.get("Online").and_then(|x| x.as_bool()).unwrap_or(false);
    let cur_addr = str_of("CurAddr");
    let relay = str_of("Relay");
    let link = if is_self {
        "this machine".to_string()
    } else if !cur_addr.is_empty() {
        format!("direct {cur_addr}")
    } else if online && !relay.is_empty() {
        format!("relay {relay}")
    } else if online {
        "idle".to_string()
    } else {
        "—".to_string()
    };
    let last_seen = if online {
        "now".to_string()
    } else {
        let raw = str_of("LastSeen");
        if raw.starts_with("0001") || raw.is_empty() {
            "—".to_string()
        } else {
            // "2026-08-12T14:03:22Z" -> "08-12 14:03"
            raw.chars()
                .skip(5)
                .take(11)
                .collect::<String>()
                .replacen('T', " ", 1)
        }
    };

    Machine {
        name,
        dns_name,
        ip,
        ips,
        os: str_of("OS"),
        online,
        is_self,
        link,
        last_seen,
        tx_bytes: v.get("TxBytes").and_then(|x| x.as_u64()).unwrap_or(0),
        rx_bytes: v.get("RxBytes").and_then(|x| x.as_u64()).unwrap_or(0),
        exit_node: v.get("ExitNode").and_then(|x| x.as_bool()).unwrap_or(false),
        tags: v
            .get("Tags")
            .and_then(|x| x.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|t| t.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
        scout: None,
    }
}

/// Registry entries keyed by display host name, deduped against node-id churn:
/// the same host can appear under several generated ids; the freshest wins.
fn scout_nodes() -> Result<Vec<(String, ScoutNode)>, String> {
    let value = run_json("scout", &["mesh", "nodes", "--json"])?;
    let nodes = value
        .get("nodes")
        .and_then(|n| n.as_object())
        .ok_or_else(|| "scout mesh nodes: missing nodes".to_string())?;

    let mut best: Vec<(String, ScoutNode)> = Vec::new();
    for node in nodes.values() {
        let host = node
            .get("hostName")
            .or_else(|| node.get("name"))
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        if host.is_empty() {
            continue;
        }
        let scout = ScoutNode {
            broker_url: node
                .get("brokerUrl")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
            web_url: node
                .get("webUrl")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
            scope: node
                .get("advertiseScope")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
            capabilities: node
                .get("capabilities")
                .and_then(|x| x.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|c| c.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default(),
            last_seen_ms: node.get("lastSeenAt").and_then(|x| x.as_i64()).unwrap_or(0),
        };
        let key = normalize_host(&host);
        if let Some(existing) = best.iter_mut().find(|(h, _)| normalize_host(h) == key) {
            if scout.last_seen_ms > existing.1.last_seen_ms {
                *existing = (host, scout);
            }
        } else {
            best.push((host, scout));
        }
    }
    Ok(best)
}

/// Lowercase, and for `.local` names drop the mDNS collision suffix ("-372")
/// that macOS appends on every re-registration. Tailnet names keep their
/// numbers: "studio-lab-3" is a different machine from "studio-lab".
pub fn normalize_host(raw: &str) -> String {
    let lower = raw.trim().to_lowercase();
    let Some(base) = lower.strip_suffix(".local") else {
        return lower;
    };
    if let Some(pos) = base.rfind('-') {
        let tail = &base[pos + 1..];
        if !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit()) {
            return base[..pos].to_string();
        }
    }
    base.to_string()
}

/// The host of a broker URL, minus scheme, port and trailing dot. Loopback and
/// wildcard hosts identify nothing, so they come back empty.
fn broker_host(url: &str) -> String {
    let rest = url.split("://").last().unwrap_or(url);
    let host = rest
        .split('/')
        .next()
        .unwrap_or("")
        .rsplit_once(':')
        .map(|(h, _)| h)
        .unwrap_or(rest)
        .trim_end_matches('.')
        .to_lowercase();
    match host.as_str() {
        "127.0.0.1" | "localhost" | "0.0.0.0" | "::1" | "" => String::new(),
        _ => host,
    }
}

fn merge_scout(machines: &mut Vec<Machine>, nodes: Vec<(String, ScoutNode)>) {
    for (host, node) in nodes {
        let key = normalize_host(&host);
        // Registry host names churn and go stale across renames, so a node also
        // matches on where its broker actually answers.
        let bhost = broker_host(&node.broker_url);
        let found = machines.iter_mut().find(|m| {
            let dns_label = normalize_host(m.dns_name.split('.').next().unwrap_or(""));
            if normalize_host(&m.name) == key || dns_label == key {
                return true;
            }
            !bhost.is_empty()
                && (m.dns_name.to_lowercase() == bhost
                    || (!dns_label.is_empty()
                        && normalize_host(bhost.split('.').next().unwrap_or("")) == dns_label)
                    || m.ips.iter().any(|ip| ip.to_lowercase() == bhost))
        });
        if let Some(m) = found {
            // Several churned ids can point at one machine; the freshest wins.
            let fresher = m
                .scout
                .as_ref()
                .map(|cur| node.last_seen_ms > cur.last_seen_ms)
                .unwrap_or(true);
            if fresher {
                m.scout = Some(node);
            }
        } else {
            // A scout node outside the tailnet (e.g. LAN-only). Its liveness is
            // whatever the registry last saw — reported as an age, not a guess.
            let last_seen = if node.last_seen_ms > 0 {
                format_age(node.last_seen_ms)
            } else {
                "—".to_string()
            };
            machines.push(Machine {
                name: host.trim_end_matches(".local").to_string(),
                dns_name: host,
                link: "lan".to_string(),
                last_seen,
                scout: Some(node),
                ..Machine::default()
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn machine(name: &str, dns: &str, broker: &str) -> Machine {
        Machine {
            name: name.into(),
            dns_name: dns.into(),
            scout: if broker.is_empty() {
                None
            } else {
                Some(ScoutNode {
                    broker_url: broker.into(),
                    web_url: String::new(),
                    scope: "mesh".into(),
                    capabilities: Vec::new(),
                    last_seen_ms: 0,
                })
            },
            ..Machine::default()
        }
    }

    #[test]
    fn ping_prefers_broker_url_then_dns_name() {
        assert_eq!(
            ping_target(&machine("desk", "desk.tailnet", "http://desk.tailnet:9")),
            Some("http://desk.tailnet:9".into())
        );
        assert_eq!(
            ping_target(&machine("desk", "desk.tailnet.", "")),
            Some("desk.tailnet".into())
        );
        assert_eq!(ping_target(&machine("desk", "", "")), Some("desk".into()));
        assert_eq!(ping_target(&machine("", "", "")), None);
    }

    #[test]
    fn ping_notice_uses_latency_on_success() {
        let value = serde_json::json!({
            "reachable": true,
            "latencyMs": 18,
            "url": "http://desk.tailnet:9"
        });
        assert_eq!(
            notice_from_ping("desk", &value),
            "ping desk · 18ms · http://desk.tailnet:9"
        );
    }

    #[test]
    fn ping_notice_keeps_the_cli_error() {
        let value = serde_json::json!({
            "reachable": false,
            "error": "connect timeout"
        });
        assert_eq!(
            notice_from_ping("studio", &value),
            "ping studio failed · connect timeout"
        );
    }

    #[test]
    fn join_and_leave_notices_name_scope() {
        let joined = serde_json::json!({
            "localNode": { "advertiseScope": "mesh" },
            "discovery": { "discoveredCount": 2 }
        });
        assert_eq!(notice_from_join(&joined), "announced · mesh · 2 peers");

        let left = serde_json::json!({
            "localNode": { "advertiseScope": "local" }
        });
        assert_eq!(notice_from_leave(&left), "withdrawn · local");
    }
}
