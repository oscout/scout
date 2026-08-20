use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::cmp::Ordering;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const REQUEST_SCHEMA: &str = "openscout.native.read.request/v1";
pub const SNAPSHOT_SCHEMA: &str = "openscout.native.read.snapshot/v1";
pub const EVENT_SCHEMA: &str = "openscout.native.read.event/v1";
const CACHE_SCHEMA: &str = "openscout.native.read.cache/v1";
const DEFAULT_LIMIT: usize = 10;
const MAX_LIMIT: usize = 100;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeReadRequest {
    #[serde(default)]
    pub request_id: Option<String>,
    pub resource: String,
    #[serde(default)]
    pub mode: NativeReadMode,
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub after_sequence: Option<u64>,
}

impl NativeReadRequest {
    pub fn normalized_limit(&self) -> usize {
        self.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT)
    }

    pub fn request_id(&self) -> &str {
        self.request_id.as_deref().unwrap_or("")
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum NativeReadMode {
    #[default]
    Snapshot,
    Subscribe,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JournalAgent {
    id: String,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    handle: Option<String>,
    #[serde(default)]
    agent_class: Option<String>,
    #[serde(default)]
    selector: Option<String>,
    #[serde(default)]
    capabilities: Vec<String>,
    #[serde(default)]
    home_node_id: Option<String>,
    #[serde(default)]
    authority_node_id: Option<String>,
    #[serde(default)]
    metadata: Map<String, Value>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JournalEndpoint {
    id: String,
    agent_id: String,
    #[serde(default)]
    harness: Option<String>,
    #[serde(default)]
    transport: Option<String>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    project_root: Option<String>,
    #[serde(default)]
    metadata: Map<String, Value>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JournalNode {
    id: String,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JournalFlight {
    id: String,
    target_agent_id: String,
    state: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAgentSummary {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_class: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub harness: Option<String>,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transport: Option<String>,
    pub capabilities: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authority_node_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub home_node_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub harness_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAgentsSnapshot {
    pub schema: &'static str,
    #[serde(rename = "type")]
    pub event_type: &'static str,
    pub request_id: String,
    pub sequence: u64,
    pub generated_at: u128,
    pub source_updated_at: u128,
    pub source: &'static str,
    pub agents: Vec<NativeAgentSummary>,
    pub has_more: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeReadHeartbeat {
    pub schema: &'static str,
    #[serde(rename = "type")]
    pub event_type: &'static str,
    pub request_id: String,
    pub sequence: u64,
    pub generated_at: u128,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedProjection {
    schema: String,
    sequence: u64,
    generated_at: u128,
    source_updated_at: u128,
    agents: Vec<NativeAgentSummary>,
}

#[derive(Clone, Debug, Default)]
struct PublishedProjection {
    sequence: u64,
    generated_at: u128,
    source_updated_at: u128,
    agents: Vec<NativeAgentSummary>,
}

#[derive(Clone, Debug)]
pub struct NativeReadService {
    state: Arc<(Mutex<PublishedProjection>, Condvar)>,
}

impl NativeReadService {
    pub fn start(journal_path: PathBuf, cache_path: PathBuf, poll_interval: Duration) -> Self {
        let initial = load_cached_projection(&cache_path).unwrap_or_default();
        let service = Self {
            state: Arc::new((Mutex::new(initial), Condvar::new())),
        };
        let worker = service.clone();
        thread::Builder::new()
            .name("scoutd-native-read".to_string())
            .spawn(move || run_projection_watcher(worker, journal_path, cache_path, poll_interval))
            .expect("failed to start scoutd native-read projection thread");
        service
    }

    pub fn snapshot(&self, request: &NativeReadRequest) -> NativeAgentsSnapshot {
        let (lock, _) = &*self.state;
        let projection = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        snapshot_for_projection(&projection, request)
    }

    pub fn wait_for_change(
        &self,
        request: &NativeReadRequest,
        after_sequence: u64,
        timeout: Duration,
    ) -> Option<NativeAgentsSnapshot> {
        let (lock, cvar) = &*self.state;
        let projection = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if projection.sequence > after_sequence {
            return Some(snapshot_for_projection(&projection, request));
        }
        let (projection, _) = cvar
            .wait_timeout_while(projection, timeout, |state| {
                state.sequence <= after_sequence
            })
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        (projection.sequence > after_sequence)
            .then(|| snapshot_for_projection(&projection, request))
    }

    pub fn heartbeat(&self, request: &NativeReadRequest) -> NativeReadHeartbeat {
        let (lock, _) = &*self.state;
        let projection = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        NativeReadHeartbeat {
            schema: EVENT_SCHEMA,
            event_type: "heartbeat",
            request_id: request.request_id().to_string(),
            sequence: projection.sequence,
            generated_at: epoch_ms(),
        }
    }

    fn publish(&self, agents: Vec<NativeAgentSummary>, source_updated_at: u128, cache_path: &Path) {
        let cached;
        {
            let (lock, cvar) = &*self.state;
            let mut state = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            // Unrelated broker journal traffic (messages, deliveries, etc.) must
            // not wake native agent-list subscribers. The source timestamp is
            // the timestamp of the last change that materially altered this
            // projection, not the journal's latest append of any kind.
            if state.agents == agents {
                return;
            }
            state.sequence = state.sequence.saturating_add(1);
            state.generated_at = epoch_ms();
            state.source_updated_at = source_updated_at;
            state.agents = agents;
            cached = CachedProjection {
                schema: CACHE_SCHEMA.to_string(),
                sequence: state.sequence,
                generated_at: state.generated_at,
                source_updated_at: state.source_updated_at,
                agents: state.agents.clone(),
            };
            cvar.notify_all();
        }
        if let Err(error) = persist_cached_projection(cache_path, &cached) {
            eprintln!("[scoutd native-read] failed to persist projection: {error}");
        }
    }
}

fn snapshot_for_projection(
    projection: &PublishedProjection,
    request: &NativeReadRequest,
) -> NativeAgentsSnapshot {
    let limit = request.normalized_limit();
    NativeAgentsSnapshot {
        schema: SNAPSHOT_SCHEMA,
        event_type: "agents.snapshot",
        request_id: request.request_id().to_string(),
        sequence: projection.sequence,
        generated_at: epoch_ms(),
        source_updated_at: projection.source_updated_at,
        source: "broker-journal",
        agents: projection.agents.iter().take(limit).cloned().collect(),
        has_more: projection.agents.len() > limit,
    }
}

fn load_cached_projection(path: &Path) -> Option<PublishedProjection> {
    let bytes = fs::read(path).ok()?;
    let cached: CachedProjection = serde_json::from_slice(&bytes).ok()?;
    if cached.schema != CACHE_SCHEMA {
        return None;
    }
    Some(PublishedProjection {
        sequence: cached.sequence,
        generated_at: cached.generated_at,
        source_updated_at: cached.source_updated_at,
        agents: cached.agents,
    })
}

fn persist_cached_projection(path: &Path, projection: &CachedProjection) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "cache path has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    let payload = serde_json::to_vec(projection).map_err(|error| error.to_string())?;
    fs::write(&temporary, payload).map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

#[derive(Default)]
struct JournalProjection {
    agents: HashMap<String, JournalAgent>,
    endpoints: HashMap<String, JournalEndpoint>,
    nodes: HashMap<String, JournalNode>,
    flights: HashMap<String, JournalFlight>,
}

impl JournalProjection {
    fn apply_line(&mut self, line: &str) -> bool {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return false;
        };
        match value.get("kind").and_then(Value::as_str) {
            Some("agent.upsert") => {
                if let Some(agent) = value
                    .get("agent")
                    .cloned()
                    .and_then(|entry| serde_json::from_value::<JournalAgent>(entry).ok())
                {
                    self.agents.insert(agent.id.clone(), agent);
                    return true;
                }
            }
            Some("agent.endpoint.upsert") => {
                if let Some(endpoint) = value
                    .get("endpoint")
                    .cloned()
                    .and_then(|entry| serde_json::from_value::<JournalEndpoint>(entry).ok())
                {
                    self.endpoints.insert(endpoint.id.clone(), endpoint);
                    return true;
                }
            }
            Some("agent.endpoint.delete") => {
                if let Some(endpoint_id) = value.get("endpointId").and_then(Value::as_str) {
                    self.endpoints.remove(endpoint_id);
                    return true;
                }
            }
            Some("node.upsert") => {
                if let Some(node) = value
                    .get("node")
                    .cloned()
                    .and_then(|entry| serde_json::from_value::<JournalNode>(entry).ok())
                {
                    self.nodes.insert(node.id.clone(), node);
                    return true;
                }
            }
            Some("flight.record") => {
                if let Some(flight) = value
                    .get("flight")
                    .cloned()
                    .and_then(|entry| serde_json::from_value::<JournalFlight>(entry).ok())
                {
                    self.flights.insert(flight.id.clone(), flight);
                    return true;
                }
            }
            _ => {}
        }
        false
    }

    fn summaries(&self) -> Vec<NativeAgentSummary> {
        let working_agents = self
            .flights
            .values()
            .filter(|flight| {
                matches!(
                    flight.state.as_str(),
                    "queued" | "waking" | "running" | "waiting"
                )
            })
            .map(|flight| flight.target_agent_id.as_str())
            .collect::<std::collections::HashSet<_>>();
        let mut summaries = self
            .agents
            .values()
            .filter(|agent| !metadata_bool(&agent.metadata, "staleLocalRegistration"))
            .filter(|agent| !metadata_bool(&agent.metadata, "retiredFromFleet"))
            .map(|agent| {
                let endpoint = preferred_endpoint(
                    self.endpoints
                        .values()
                        .filter(|endpoint| endpoint.agent_id == agent.id),
                );
                let endpoint_metadata = endpoint.map(|entry| &entry.metadata);
                let project_root = endpoint
                    .and_then(|entry| entry.project_root.clone())
                    .or_else(|| metadata_string(&agent.metadata, "projectRoot"));
                let project = metadata_string(&agent.metadata, "project")
                    .or_else(|| project_root.as_deref().and_then(project_name));
                let updated_at = latest_timestamp(agent, endpoint);
                NativeAgentSummary {
                    id: agent.id.clone(),
                    name: nonempty(&agent.display_name)
                        .unwrap_or(&agent.id)
                        .to_string(),
                    handle: agent.handle.clone().and_then(nonempty_owned),
                    agent_class: agent.agent_class.clone().and_then(nonempty_owned),
                    harness: endpoint
                        .and_then(|entry| entry.harness.clone())
                        .and_then(nonempty_owned),
                    state: if working_agents.contains(agent.id.as_str()) {
                        "working"
                    } else {
                        "available"
                    }
                    .to_string(),
                    role: metadata_string(&agent.metadata, "role"),
                    project_root,
                    cwd: endpoint
                        .and_then(|entry| entry.cwd.clone())
                        .and_then(nonempty_owned),
                    project,
                    branch: metadata_string(&agent.metadata, "branch").or_else(|| {
                        endpoint_metadata.and_then(|metadata| metadata_string(metadata, "branch"))
                    }),
                    selector: agent
                        .selector
                        .clone()
                        .and_then(nonempty_owned)
                        .or_else(|| metadata_string(&agent.metadata, "selector")),
                    model: endpoint_metadata
                        .and_then(|metadata| metadata_string(metadata, "model"))
                        .or_else(|| metadata_string(&agent.metadata, "model")),
                    transport: endpoint
                        .and_then(|entry| entry.transport.clone())
                        .and_then(nonempty_owned)
                        .or_else(|| metadata_string(&agent.metadata, "transport")),
                    capabilities: agent.capabilities.clone(),
                    authority_node_name: agent
                        .authority_node_id
                        .as_deref()
                        .and_then(|id| self.nodes.get(id))
                        .and_then(|node| node.name.clone()),
                    home_node_name: agent
                        .home_node_id
                        .as_deref()
                        .and_then(|id| self.nodes.get(id))
                        .and_then(|node| node.name.clone()),
                    harness_session_id: endpoint.and_then(resolve_harness_session_id),
                    updated_at,
                    created_at: ["createdAt", "registeredAt"]
                        .iter()
                        .filter_map(|key| metadata_timestamp(&agent.metadata, key))
                        .max(),
                }
            })
            .collect::<Vec<_>>();
        summaries.sort_by(|left, right| {
            right
                .updated_at
                .unwrap_or(0)
                .cmp(&left.updated_at.unwrap_or(0))
                .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
                .then_with(|| left.id.cmp(&right.id))
        });
        summaries
    }
}

fn preferred_endpoint<'a>(
    endpoints: impl Iterator<Item = &'a JournalEndpoint>,
) -> Option<&'a JournalEndpoint> {
    endpoints.min_by(|left, right| compare_endpoint(left, right))
}

fn compare_endpoint(left: &JournalEndpoint, right: &JournalEndpoint) -> Ordering {
    let left_tuple = (
        metadata_bool(&left.metadata, "staleLocalRegistration"),
        endpoint_state_rank(left.state.as_deref()),
        std::cmp::Reverse(endpoint_freshness(left)),
        left.id.as_str(),
    );
    let right_tuple = (
        metadata_bool(&right.metadata, "staleLocalRegistration"),
        endpoint_state_rank(right.state.as_deref()),
        std::cmp::Reverse(endpoint_freshness(right)),
        right.id.as_str(),
    );
    left_tuple.cmp(&right_tuple)
}

fn endpoint_state_rank(state: Option<&str>) -> u8 {
    match state {
        Some("active") => 0,
        Some("idle") => 1,
        Some("waiting") => 2,
        Some("offline") => 5,
        _ => 4,
    }
}

fn endpoint_freshness(endpoint: &JournalEndpoint) -> u64 {
    [
        "lastSeenAt",
        "lastEnsuredAt",
        "lastStartedAt",
        "startedAt",
        "lastCompletedAt",
        "lastFailedAt",
    ]
    .iter()
    .filter_map(|key| metadata_timestamp(&endpoint.metadata, key))
    .max()
    .unwrap_or(0)
}

fn latest_timestamp(agent: &JournalAgent, endpoint: Option<&JournalEndpoint>) -> Option<u64> {
    let mut timestamps = ["createdAt", "registeredAt", "updatedAt"]
        .iter()
        .filter_map(|key| metadata_timestamp(&agent.metadata, key))
        .collect::<Vec<_>>();
    if let Some(endpoint) = endpoint {
        timestamps.push(endpoint_freshness(endpoint));
    }
    timestamps.into_iter().filter(|value| *value > 0).max()
}

fn resolve_harness_session_id(endpoint: &JournalEndpoint) -> Option<String> {
    endpoint
        .session_id
        .clone()
        .and_then(nonempty_owned)
        .or_else(|| {
            [
                "externalSessionId",
                "threadId",
                "nativeSessionId",
                "pairingSessionId",
                "runtimeSessionId",
            ]
            .iter()
            .find_map(|key| metadata_string(&endpoint.metadata, key))
        })
}

fn metadata_bool(metadata: &Map<String, Value>, key: &str) -> bool {
    metadata.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn metadata_string(metadata: &Map<String, Value>, key: &str) -> Option<String> {
    metadata
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .and_then(nonempty_owned)
}

fn metadata_timestamp(metadata: &Map<String, Value>, key: &str) -> Option<u64> {
    epoch_value(metadata.get(key)?)
}

fn epoch_value(value: &Value) -> Option<u64> {
    let raw = match value {
        Value::Number(number) => number.as_f64()?,
        Value::String(string) => string.parse::<f64>().ok()?,
        _ => return None,
    };
    if !raw.is_finite() || raw <= 0.0 {
        return None;
    }
    let milliseconds = if raw < 100_000_000_000.0 {
        raw * 1000.0
    } else {
        raw
    };
    Some(milliseconds.round() as u64)
}

fn project_name(path: &str) -> Option<String> {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::to_string)
        .and_then(nonempty_owned)
}

fn nonempty(value: &str) -> Option<&str> {
    (!value.trim().is_empty()).then_some(value)
}

fn nonempty_owned(value: String) -> Option<String> {
    (!value.trim().is_empty()).then_some(value)
}

fn run_projection_watcher(
    service: NativeReadService,
    journal_path: PathBuf,
    cache_path: PathBuf,
    poll_interval: Duration,
) {
    let mut projection = JournalProjection::default();
    let mut cursor = JournalCursor::default();
    loop {
        match cursor.read_updates(&journal_path, &mut projection) {
            Ok(Some(source_updated_at)) => {
                service.publish(projection.summaries(), source_updated_at, &cache_path);
            }
            Ok(None) => {}
            Err(error) => eprintln!("[scoutd native-read] journal projection failed: {error}"),
        }
        thread::sleep(poll_interval.max(Duration::from_millis(50)));
    }
}

#[derive(Default)]
struct JournalCursor {
    inode: Option<u64>,
    offset: u64,
    pending: String,
}

impl JournalCursor {
    fn read_updates(
        &mut self,
        path: &Path,
        projection: &mut JournalProjection,
    ) -> Result<Option<u128>, String> {
        let metadata = match fs::metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.to_string()),
        };
        let inode = metadata.ino();
        if self.inode != Some(inode) || metadata.len() < self.offset {
            *projection = JournalProjection::default();
            self.offset = 0;
            self.pending.clear();
            self.inode = Some(inode);
        }
        if metadata.len() == self.offset {
            return Ok(None);
        }

        let mut file = File::open(path).map_err(|error| error.to_string())?;
        file.seek(SeekFrom::Start(self.offset))
            .map_err(|error| error.to_string())?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        self.offset = self.offset.saturating_add(bytes.len() as u64);
        self.pending.push_str(&String::from_utf8_lossy(&bytes));
        let Some(last_newline) = self.pending.rfind('\n') else {
            return Ok(None);
        };
        let complete = self.pending[..last_newline].to_string();
        self.pending = self.pending[last_newline + 1..].to_string();
        let mut material_change = false;
        for line in BufReader::new(complete.as_bytes())
            .lines()
            .map_while(Result::ok)
        {
            material_change |= projection.apply_line(&line);
        }
        Ok(material_change
            .then(|| system_time_ms(metadata.modified().unwrap_or_else(|_| SystemTime::now()))))
    }
}

fn system_time_ms(time: SystemTime) -> u128 {
    time.duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn epoch_ms() -> u128 {
    system_time_ms(SystemTime::now())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(value: Value) -> String {
        serde_json::to_string(&value).unwrap()
    }

    #[test]
    fn projection_filters_stale_agents_and_orders_by_endpoint_freshness() {
        let mut projection = JournalProjection::default();
        projection.apply_line(&line(serde_json::json!({
            "kind": "agent.upsert",
            "agent": {
                "id": "old", "displayName": "Old", "agentClass": "general",
                "capabilities": ["chat"], "metadata": {"staleLocalRegistration": true}
            }
        })));
        for (id, name) in [("one", "One"), ("two", "Two")] {
            projection.apply_line(&line(serde_json::json!({
                "kind": "agent.upsert",
                "agent": {
                    "id": id, "displayName": name, "agentClass": "general",
                    "capabilities": ["chat", "invoke"], "metadata": {"project": "OpenScout"}
                }
            })));
        }
        projection.apply_line(&line(serde_json::json!({
            "kind": "agent.endpoint.upsert",
            "endpoint": {
                "id": "ep-one", "agentId": "one", "harness": "codex", "transport": "codex_app_server",
                "state": "idle", "projectRoot": "/work/one", "metadata": {"lastEnsuredAt": 1000}
            }
        })));
        projection.apply_line(&line(serde_json::json!({
            "kind": "agent.endpoint.upsert",
            "endpoint": {
                "id": "ep-two", "agentId": "two", "harness": "claude", "transport": "tmux",
                "state": "active", "projectRoot": "/work/two", "metadata": {"lastEnsuredAt": 2000}
            }
        })));

        let summaries = projection.summaries();
        assert_eq!(
            summaries
                .iter()
                .map(|agent| agent.id.as_str())
                .collect::<Vec<_>>(),
            ["two", "one"]
        );
        assert_eq!(summaries[0].harness.as_deref(), Some("claude"));
        assert_eq!(summaries[0].project_root.as_deref(), Some("/work/two"));
    }

    #[test]
    fn snapshot_is_bounded_and_reports_more_rows() {
        let service = NativeReadService {
            state: Arc::new((
                Mutex::new(PublishedProjection {
                    sequence: 7,
                    generated_at: 1,
                    source_updated_at: 2,
                    agents: (0..12)
                        .map(|index| NativeAgentSummary {
                            id: format!("agent-{index}"),
                            name: format!("Agent {index}"),
                            handle: None,
                            agent_class: None,
                            harness: None,
                            state: "available".to_string(),
                            role: None,
                            project_root: None,
                            cwd: None,
                            project: None,
                            branch: None,
                            selector: None,
                            model: None,
                            transport: None,
                            capabilities: Vec::new(),
                            authority_node_name: None,
                            home_node_name: None,
                            harness_session_id: None,
                            updated_at: None,
                            created_at: None,
                        })
                        .collect(),
                }),
                Condvar::new(),
            )),
        };
        let request = NativeReadRequest {
            request_id: Some("req-1".to_string()),
            resource: "agents".to_string(),
            mode: NativeReadMode::Snapshot,
            limit: Some(10),
            after_sequence: None,
        };
        let snapshot = service.snapshot(&request);
        assert_eq!(snapshot.agents.len(), 10);
        assert!(snapshot.has_more);
        assert_eq!(snapshot.sequence, 7);
        assert_eq!(snapshot.request_id, "req-1");
    }
}
