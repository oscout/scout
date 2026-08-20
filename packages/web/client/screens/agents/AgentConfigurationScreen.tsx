import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Bot, Cpu, KeyRound, RefreshCw, Save, Server, Settings, Wrench } from "lucide-react";
import { EmptyState } from "../../components/EmptyState.tsx";
import { api } from "../../lib/api.ts";
import { ensureAgentChat } from "../../lib/agent-chat.ts";
import { formatClockTimestamp } from "../../lib/time.ts";
import type {
  AgentConfigurationAgent,
  AgentConfigurationProvider,
  AgentConfigurationRuntime,
  AgentConfigurationState,
  LocalAgentConfigState,
  Route,
} from "../../lib/types.ts";
import { useScout } from "../../scout/Provider.tsx";
import { openContent } from "../../scout/slots/openContent.ts";
import { AgentsSubnav } from "./AgentsSubnav.tsx";
import "../system-surfaces-redesign.css";

function chipTone(value: string): string {
  switch (value) {
    case "ready":
    case "running":
    case "available":
    case "enabled":
      return "sys-chip-success";
    case "configured":
    case "installed":
    case "working":
      return "sys-chip-warning";
    case "missing":
    case "offline":
    case "not_ready":
    case "error":
      return "sys-chip-danger";
    default:
      return "sys-chip-neutral";
  }
}

function agentConfigStatusLabel(value: string): string {
  switch (value) {
    case "available":
    case "ready":
      return "ready";
    case "offline":
    case "not_ready":
      return "not ready";
    default:
      return value;
  }
}

function shortPath(value: string | null): string {
  if (!value) return "Not reported";
  return value.replace(/^\/Users\/[^/]+/, "~");
}

function displayCapabilities(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "No capabilities reported";
}

function RuntimeRow({ runtime }: { runtime: AgentConfigurationRuntime }) {
  return (
    <div className="agent-config-row">
      <div className="agent-config-row-main">
        <span className="agent-config-icon"><Cpu size={14} /></span>
        <div className="agent-config-row-copy">
          <div className="agent-config-row-title">{runtime.label}</div>
          <div className="agent-config-row-detail">{runtime.description}</div>
          <div className="agent-config-row-meta">{runtime.detail}</div>
        </div>
      </div>
      <div className="agent-config-row-side">
        <span className={`sys-chip ${chipTone(runtime.state)}`}>{runtime.state}</span>
        <span className="agent-config-row-meta">{runtime.binaryPath ?? runtime.loginCommand ?? runtime.source}</span>
      </div>
    </div>
  );
}

function ProviderRow({ provider }: { provider: AgentConfigurationProvider }) {
  return (
    <div className="agent-config-row">
      <div className="agent-config-row-main">
        <span className="agent-config-icon"><KeyRound size={14} /></span>
        <div className="agent-config-row-copy">
          <div className="agent-config-row-title">{provider.name}</div>
          <div className="agent-config-row-detail">{provider.protocol}</div>
          <code className="agent-config-code">{provider.baseUrl}</code>
          <div className="agent-config-row-meta">Keys: {provider.envKeys.join(", ")}</div>
          <div className="agent-config-row-meta">{provider.note}</div>
        </div>
      </div>
      <div className="agent-config-row-side">
        <span className={`sys-chip ${chipTone(provider.status)}`}>{provider.status}</span>
        <a className="agent-config-link" href={provider.docsUrl} target="_blank" rel="noreferrer">Docs</a>
      </div>
    </div>
  );
}

function AgentRow({
  agent,
  selected,
  navigate,
}: {
  agent: AgentConfigurationAgent;
  selected: boolean;
  navigate: (r: Route) => void;
}) {
  return (
    <button
      type="button"
      className={`agent-config-row agent-config-row-button${selected ? " agent-config-row-selected" : ""}`}
      onClick={() => navigate({ view: "agents-v2", agentId: agent.id, tab: "config" })}
    >
      <div className="agent-config-row-main">
        <span className="agent-config-icon"><Bot size={14} /></span>
        <div className="agent-config-row-copy">
          <div className="agent-config-row-title">{agent.name}</div>
          <div className="agent-config-row-detail">{agent.id}</div>
          <div className="agent-config-row-meta">
            {agent.harness ?? "unknown harness"} / {agent.transport ?? "unknown transport"}
            {agent.model ? ` / ${agent.model}` : ""}
          </div>
        </div>
      </div>
      <div className="agent-config-row-side">
        <span className={`sys-chip ${chipTone(agent.status)}`}>{agentConfigStatusLabel(agent.status)}</span>
        <span className="agent-config-row-meta">{shortPath(agent.projectRoot ?? agent.cwd)}</span>
      </div>
    </button>
  );
}

type LocalAgentConfigUpdateResponse = {
  config: LocalAgentConfigState;
  restarted: boolean;
};

function applyConfigDrafts(
  config: LocalAgentConfigState,
  setConfig: (value: LocalAgentConfigState) => void,
  setModelDraft: (value: string) => void,
  setCwdDraft: (value: string) => void,
  setHarnessDraft: (value: string) => void,
) {
  setConfig(config);
  setModelDraft(config.model ?? "");
  setCwdDraft(config.runtime.cwd);
  setHarnessDraft(config.runtime.harness);
}

function SelectedAgentPanel({
  agent,
  navigate,
  onConfigSaved,
}: {
  agent: AgentConfigurationAgent | null;
  navigate: (r: Route) => void;
  onConfigSaved?: () => void;
}) {
  const { route } = useScout();
  const agentId = agent?.id ?? null;
  const [config, setConfig] = useState<LocalAgentConfigState | null>(null);
  const [configLoading, setConfigLoading] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [modelDraft, setModelDraft] = useState("");
  const [cwdDraft, setCwdDraft] = useState("");
  const [harnessDraft, setHarnessDraft] = useState("");
  const [restartOnSave, setRestartOnSave] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving">("idle");
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const configRequestIdRef = useRef(0);

  const loadConfig = useCallback(async () => {
    const requestId = ++configRequestIdRef.current;
    setSaveMessage(null);
    setRestartOnSave(false);
    if (!agentId) {
      setConfig(null);
      setConfigError(null);
      setConfigLoading(false);
      return;
    }
    setConfigLoading(true);
    setConfigError(null);
    try {
      const next = await api<LocalAgentConfigState>(`/api/agents/${encodeURIComponent(agentId)}/config`);
      if (requestId !== configRequestIdRef.current) return;
      applyConfigDrafts(next, setConfig, setModelDraft, setCwdDraft, setHarnessDraft);
    } catch (loadError) {
      if (requestId !== configRequestIdRef.current) return;
      setConfig(null);
      setModelDraft("");
      setCwdDraft("");
      setHarnessDraft(agent?.harness ?? "");
      setConfigError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (requestId === configRequestIdRef.current) {
        setConfigLoading(false);
      }
    }
  }, [agent?.harness, agentId]);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  const harnessOptions = useMemo(() => {
    const values = ["claude", "codex", "pi", config?.runtime.harness, agent?.harness, harnessDraft]
      .filter((value): value is string => Boolean(value?.trim()));
    return Array.from(new Set(values));
  }, [agent?.harness, config?.runtime.harness, harnessDraft]);

  const saveConfig = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!agentId || !config || saveState === "saving") return;
    setSaveState("saving");
    setSaveMessage(null);
    setConfigError(null);
    try {
      const next = await api<LocalAgentConfigUpdateResponse>(`/api/agents/${encodeURIComponent(agentId)}/config`, {
        method: "POST",
        body: JSON.stringify({
          model: modelDraft.trim() || null,
          runtime: {
            cwd: cwdDraft.trim() || config.runtime.cwd,
            harness: harnessDraft.trim() || config.runtime.harness,
          },
          restart: restartOnSave,
        }),
      });
      applyConfigDrafts(next.config, setConfig, setModelDraft, setCwdDraft, setHarnessDraft);
      setRestartOnSave(false);
      setSaveMessage(next.restarted ? "Saved and restarted" : "Saved");
      onConfigSaved?.();
    } catch (saveError) {
      setConfigError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaveState("idle");
    }
  };

  if (!agent) {
    return (
      <div className="sys-panel agent-config-detail-panel">
        <div className="sys-section-head">
          <div>
            <h3 className="sys-section-title">Agent Details</h3>
            <p className="sys-section-subtitle">Select an agent to inspect runtime, model, and tool context.</p>
          </div>
        </div>
        <div className="sys-list-empty">
          <h3>No agent selected</h3>
          <p>Choose an agent from the configuration roster.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="sys-panel agent-config-detail-panel">
      <div className="sys-section-head">
        <div>
          <h3 className="sys-section-title">{agent.name}</h3>
          <p className="sys-section-subtitle">{agent.id}</p>
        </div>
        <div className="sys-page-actions">
          <button
            type="button"
            className="s-btn"
            onClick={() => navigate({ view: "agents-v2", agentId: agent.id })}
          >
            Open Agent
          </button>
          <button
            type="button"
            className="s-btn"
            onClick={() => {
              void ensureAgentChat(agent).then((conversationId) => {
                openContent(
                  navigate,
                  { view: "conversation", conversationId },
                  { returnTo: route },
                );
              });
            }}
          >
            Open Chat
          </button>
        </div>
      </div>

      <div className="agent-config-detail-grid">
        <div>
          <span className="agent-config-label">Status</span>
          <span className={`sys-chip ${chipTone(agent.status)}`}>{agentConfigStatusLabel(agent.status)}</span>
        </div>
        <div>
          <span className="agent-config-label">Harness</span>
          <strong className="agent-config-selectable">{agent.harness ?? "Not reported"}</strong>
        </div>
        <div>
          <span className="agent-config-label">Transport</span>
          <strong className="agent-config-selectable">{agent.transport ?? "Not reported"}</strong>
        </div>
        <div>
          <span className="agent-config-label">Reported model</span>
          <strong className="agent-config-selectable">{agent.model ?? "Not reported"}</strong>
        </div>
        <div>
          <span className="agent-config-label">Configured model</span>
          <strong className="agent-config-selectable">
            {configLoading ? "Loading..." : config ? (config.model ?? "Harness default") : "Not editable"}
          </strong>
        </div>
        <div className="agent-config-detail-wide">
          <span className="agent-config-label">Project</span>
          <code className="agent-config-inline-code" title={agent.projectRoot ?? undefined}>
            {shortPath(agent.projectRoot)}
          </code>
        </div>
        <div className="agent-config-detail-wide">
          <span className="agent-config-label">Working dir</span>
          <code className="agent-config-inline-code" title={agent.cwd ?? config?.runtime.cwd ?? undefined}>
            {shortPath(agent.cwd ?? config?.runtime.cwd ?? null)}
          </code>
        </div>
        <div className="agent-config-detail-wide">
          <span className="agent-config-label">Capabilities</span>
          <span className="agent-config-selectable">{displayCapabilities(agent.capabilities)}</span>
        </div>
      </div>

      {configLoading && (
        <div className="agent-config-edit agent-config-edit-empty">
          <span className="agent-config-save-note">Loading editable launch config...</span>
        </div>
      )}

      {!configLoading && config && (
        <form className="agent-config-edit" onSubmit={saveConfig}>
          <div className="agent-config-edit-grid">
            <label className="agent-config-field">
              <span>Model</span>
              <input
                name="model"
                value={modelDraft}
                placeholder="Harness default"
                disabled={!config.editable || saveState === "saving"}
                onChange={(event) => setModelDraft(event.currentTarget.value)}
              />
            </label>
            <label className="agent-config-field">
              <span>Harness</span>
              <select
                name="harness"
                value={harnessDraft}
                disabled={!config.editable || saveState === "saving"}
                onChange={(event) => setHarnessDraft(event.currentTarget.value)}
              >
                {harnessOptions.map((value) => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </select>
            </label>
            <label className="agent-config-field agent-config-field-wide">
              <span>Working dir</span>
              <input
                name="cwd"
                value={cwdDraft}
                disabled={!config.editable || saveState === "saving"}
                onChange={(event) => setCwdDraft(event.currentTarget.value)}
              />
            </label>
          </div>
          <div className="agent-config-save-row">
            <label className="agent-config-check">
              <input
                type="checkbox"
                checked={restartOnSave}
                disabled={!config.editable || saveState === "saving"}
                onChange={(event) => setRestartOnSave(event.currentTarget.checked)}
              />
              <span>Restart after saving</span>
            </label>
            <button
              type="submit"
              className="s-btn"
              disabled={!config.editable || saveState === "saving"}
            >
              <Save size={13} />
              {saveState === "saving" ? "Saving..." : "Save config"}
            </button>
            {saveMessage && <span className="agent-config-save-note">{saveMessage}</span>}
            {configError && <span className="agent-config-save-error">{configError}</span>}
          </div>
        </form>
      )}

      {!configLoading && !config && (
        <div className="agent-config-edit agent-config-edit-empty">
          <span className="agent-config-save-error">
            {configError ?? "No editable local config found"}
          </span>
        </div>
      )}
    </div>
  );
}

export function AgentConfigurationScreen({
  navigate,
  selectedAgentId,
}: {
  navigate: (r: Route) => void;
  selectedAgentId?: string;
}) {
  const { route } = useScout();
  const [snapshot, setSnapshot] = useState<AgentConfigurationState | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const load = useCallback(async (mode: "initial" | "manual" = "initial") => {
    const requestId = ++requestIdRef.current;
    if (mode === "initial") {
      setLoading(true);
    } else {
      setRefreshing(true);
    }
    setError(null);
    try {
      const next = await api<AgentConfigurationState>("/api/agent-config/snapshot");
      if (requestId !== requestIdRef.current) return;
      setSnapshot(next);
    } catch (loadError) {
      if (requestId !== requestIdRef.current) return;
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedAgent = useMemo(() => {
    if (!snapshot) return null;
    return snapshot.agents.find((agent) => agent.id === selectedAgentId)
      ?? snapshot.agents[0]
      ?? null;
  }, [selectedAgentId, snapshot]);

  const providers = snapshot?.providers ?? [];

  const metrics = snapshot ? [
    { label: "Runtimes", value: String(snapshot.runtimes.length), detail: `${snapshot.runtimes.filter((runtime) => runtime.state === "ready").length} ready` },
    { label: "BYOK", value: String(providers.length), detail: `${providers.filter((provider) => provider.status === "configured").length} configured` },
    { label: "Agents", value: String(snapshot.agents.length), detail: `${snapshot.agents.filter((agent) => agentConfigStatusLabel(agent.status) !== "not ready").length} ready` },
    { label: "Broker", value: snapshot.broker.label, detail: snapshot.broker.nodeId ?? "No node id" },
  ] : [];

  return (
    <div className="s-secondary-nav-shell">
      <div className="s-secondary-nav-bar">
        <AgentsSubnav activeRoute={route} navigate={navigate} />
      </div>
      <div className="s-secondary-nav-body s-secondary-nav-body--scroll">
        <div className="sys-surface-page sys-surface-page-wide">
          <div className="sys-page-head">
        <div className="sys-page-title-group">
          <h2 className="sys-page-title">Agent Configuration</h2>
          <p className="sys-page-subtitle">
            Runtimes, agents, project inventory, delivery bridges, and the missing tool/provider surfaces in one control plane.
          </p>
        </div>
        <div className="sys-page-actions">
          {snapshot && (
            <div className="sys-sync-note">
              Updated {formatClockTimestamp(snapshot.generatedAt) || "unknown"}
            </div>
          )}
          <button
            type="button"
            className="s-btn"
            disabled={loading || refreshing}
            onClick={() => void load("manual")}
          >
            <RefreshCw size={13} />
            {refreshing ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>

      {snapshot && (
        <div className="sys-stat-grid">
          {metrics.map((metric) => (
            <div key={metric.label} className="sys-stat-card">
              <span className="sys-stat-label">{metric.label}</span>
              <strong className="sys-stat-value">{metric.value}</strong>
              <span className="sys-stat-detail">{metric.detail}</span>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="sys-banner sys-banner-warning">
          <strong>Configuration snapshot failed.</strong>
          <span>{error}</span>
        </div>
      )}

      {loading && !snapshot && (
        <EmptyState
          title="Loading configuration"
          body="Reading Scout settings, runtime readiness, broker agents, and project inventory."
        />
      )}

      {snapshot && (
        <>
          <div className="agent-config-layout">
            <div className="sys-panel">
              <div className="sys-section-head">
                <div>
                  <h3 className="sys-section-title">Runtimes</h3>
                  <p className="sys-section-subtitle">Harness readiness replaces provider auth for the current local-first posture.</p>
                </div>
                <Settings size={15} />
              </div>
              <div className="agent-config-list">
                {snapshot.runtimes.map((runtime) => <RuntimeRow key={runtime.id} runtime={runtime} />)}
              </div>
            </div>

            <div className="sys-panel">
              <div className="sys-section-head">
                <div>
                  <h3 className="sys-section-title">BYOK Providers</h3>
                  <p className="sys-section-subtitle">OpenAI-compatible vendors OpenScout can discover from local environment configuration.</p>
                </div>
                <KeyRound size={15} />
              </div>
              <div className="agent-config-list">
                {providers.map((provider) => <ProviderRow key={provider.id} provider={provider} />)}
              </div>
            </div>
          </div>

          <div className="agent-config-layout agent-config-layout-primary">
            <div className="sys-panel">
              <div className="sys-section-head">
                <div>
                  <h3 className="sys-section-title">Agents</h3>
                  <p className="sys-section-subtitle">Broker-visible endpoints with runtime, model, and source state.</p>
                </div>
                <Bot size={15} />
              </div>
              <div className="agent-config-list agent-config-list-scroll">
                {snapshot.agents.length === 0 ? (
                  <div className="sys-list-empty">
                    <h3>No agents registered</h3>
                    <p>Run setup or start a local agent to populate this roster.</p>
                  </div>
                ) : (
                  snapshot.agents.map((agent) => (
                    <AgentRow
                      key={agent.id}
                      agent={agent}
                      selected={agent.id === selectedAgent?.id}
                      navigate={navigate}
                    />
                  ))
                )}
              </div>
            </div>

            <SelectedAgentPanel
              agent={selectedAgent}
              navigate={navigate}
              onConfigSaved={() => void load("manual")}
            />
          </div>

          <div className="agent-config-layout">
            <div className="sys-panel">
              <div className="sys-section-head">
                <div>
                  <h3 className="sys-section-title">Tools & Context</h3>
                  <p className="sys-section-subtitle">The next model boundary to make first-class.</p>
                </div>
                <Wrench size={15} />
              </div>
              <p className="agent-config-copy">{snapshot.toolContext.note}</p>
              <div className="agent-config-chip-row">
                <span className="sys-chip sys-chip-neutral">{snapshot.toolContext.mcpServerCount} MCP servers</span>
                <span className="sys-chip sys-chip-warning">loadouts pending</span>
              </div>
            </div>

            <div className="sys-panel">
              <div className="sys-section-head">
                <div>
                  <h3 className="sys-section-title">Broker & Delivery</h3>
                  <p className="sys-section-subtitle">Control-plane state and bridges that route attention back to you.</p>
                </div>
                <Server size={15} />
              </div>
              <div className="agent-config-detail-grid">
                <div>
                  <span className="agent-config-label">Broker</span>
                  <span className={`sys-chip ${snapshot.broker.healthy ? "sys-chip-success" : "sys-chip-danger"}`}>
                    {snapshot.broker.label}
                  </span>
                </div>
                <div>
                  <span className="agent-config-label">Messages</span>
                  <strong>{snapshot.broker.messageCount}</strong>
                </div>
                {snapshot.integrations.map((integration) => (
                  <div key={integration.id} className="agent-config-detail-wide">
                    <span className="agent-config-label">{integration.name}</span>
                    <span>{integration.detail}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="sys-panel">
            <div className="sys-section-head">
              <div>
                <h3 className="sys-section-title">Known Missing Pieces</h3>
                <p className="sys-section-subtitle">The configuration model is now visible; these are the next root-cause surfaces to build.</p>
              </div>
            </div>
            <div className="agent-config-gap-list">
              {snapshot.gaps.map((gap) => <span key={gap}>{gap}</span>)}
            </div>
          </div>
        </>
      )}
        </div>
      </div>
    </div>
  );
}
