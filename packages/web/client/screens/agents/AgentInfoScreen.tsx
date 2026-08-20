import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import "./agents-detail-redesign.css";
import { agentStateCssToken, agentStateLabel } from "../../lib/agent-state.ts";
import {
  compactAgentId,
  minimalAgentHandle,
} from "../../lib/agent-labels.ts";
import { actorColor, stateColor } from "../../lib/colors.ts";
import { api } from "../../lib/api.ts";
import { useBrokerEvents } from "../../lib/sse.ts";
import { fullTimestamp, timeAgo } from "../../lib/time.ts";
import { formatLabel } from "../../lib/text.ts";
import { useScout } from "../../scout/Provider.tsx";
import { openContent } from "../../scout/slots/openContent.ts";
import { BackToPicker } from "../../scout/slots/BackToPicker.tsx";
import { AgentLiveActions } from "../../components/AgentLiveActions.tsx";
import { ObservedTopologyPanel } from "../../components/ObservedTopologyPanel.tsx";
import type { Agent, Route, SessionEntry } from "../../lib/types.ts";
import { projectIdentityForAgent } from "./model.ts";

type ProfileField = {
  label: string;
  value: ReactNode;
};

function CapabilityTokens({ values }: { values: string[] }) {
  return (
    <span className="s-agent-token-list">
      {values.map((value) => (
        <span key={value} className="s-agent-token">
          {value}
        </span>
      ))}
    </span>
  );
}

function CodeValue({ value }: { value: string }) {
  return <span className="s-agent-code-value">{value}</span>;
}

function FieldChip({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value?.trim()) {
    return null;
  }
  return (
    <span className="s-agent-profile-chip">
      <span className="s-agent-profile-chip-label">{label}</span>
      <span className="s-agent-profile-chip-value">{value}</span>
    </span>
  );
}

function normalizeIdentityText(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function humanizeAlias(value: string): string {
  return value
    .trim()
    .replace(/^@+/, "")
    .replace(/^(project|agent|session)[-_.:\s]+/iu, "")
    .split(/[-_\s·]+/u)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function stripProjectPrefix(
  value: string,
  projectTitle: string,
  projectSlug: string | null,
  harness: string | null,
): string {
  let next = value.trim().replace(/^@+/, "");
  const prefixes = [
    projectTitle,
    projectSlug,
    harness,
    harness ? formatLabel(harness) : null,
  ].filter((v): v is string => Boolean(v?.trim()));
  for (const prefix of prefixes) {
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    next = next.replace(new RegExp(`^${escaped}[-_.:\\s·]+`, "iu"), "");
  }
  return next;
}

function aliasTitleForAgent(
  agent: Agent,
  session: SessionEntry | null,
  projectTitle: string,
  projectSlug: string | null,
): string | null {
  const participant = session?.participants?.find((entry) =>
    entry.agentId === agent.id || entry.actorId === agent.id,
  );
  const harnessName = normalizeIdentityText(agent.harness);
  const projectName = normalizeIdentityText(projectTitle);
  const candidates = [
    participant?.scopedAlias,
    session?.alias,
    agent.handle,
    participant?.displayName,
    session?.agentName,
    agent.name,
  ];

  for (const candidate of candidates) {
    if (!candidate?.trim()) continue;
    const stripped = stripProjectPrefix(candidate, projectTitle, projectSlug, agent.harness);
    const label = humanizeAlias(stripped);
    const normalized = normalizeIdentityText(label);
    if (!normalized || normalized === projectName || normalized === harnessName) continue;
    return label;
  }
  return null;
}

function protocolLabel(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }
  return normalized.toLowerCase() === "a2a"
    ? "A2A"
    : formatLabel(normalized) ?? normalized;
}

function ProviderValue({
  name,
  url,
}: {
  name: string;
  url?: string | null;
}) {
  if (!url) {
    return <>{name}</>;
  }
  return (
    <a href={url} target="_blank" rel="noreferrer">
      {name}
    </a>
  );
}

function ProfileCard({
  title,
  subtitle,
  items,
  variant,
}: {
  title: string;
  subtitle?: string;
  items: ProfileField[];
  variant?: "primary" | "secondary";
}) {
  if (items.length === 0) {
    return null;
  }

  return (
    <section className={`s-agent-profile-card${variant ? ` s-agent-profile-card-${variant}` : ""}`}>
      <div className="s-agent-profile-card-header">
        <div>
          <div className="s-agent-profile-card-title">{title}</div>
          {subtitle && <div className="s-agent-profile-card-subtitle">{subtitle}</div>}
        </div>
      </div>
      <div className="s-agent-meta-card-body">
        {items.map((item) => (
          <div key={item.label} className="s-agent-meta-row">
            <span className="s-agent-meta-label">{item.label}</span>
            <span className="s-agent-meta-value">{item.value}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export function AgentInfoScreen({
  conversationId,
  navigate,
}: {
  conversationId: string;
  navigate: (r: Route) => void;
}) {
  const { agents, route } = useScout();
  const [session, setSession] = useState<SessionEntry | null>(null);
  const [agentDetail, setAgentDetail] = useState<Agent | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const sessionEntry = await api<SessionEntry>(
        `/api/session/${encodeURIComponent(conversationId)}`,
      ).catch(() => null);
      setSession(sessionEntry);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSession(null);
    }
  }, [conversationId]);

  useEffect(() => {
    void load();
  }, [load]);
  useBrokerEvents(() => {
    void load();
  });

  const resolvedAgentId = session?.agentId ?? null;
  useEffect(() => {
    if (!resolvedAgentId || agents.some((candidate) => candidate.id === resolvedAgentId)) {
      setAgentDetail(null);
      return;
    }

    let cancelled = false;
    api<Agent>(`/api/agents/${encodeURIComponent(resolvedAgentId)}`)
      .then((next) => {
        if (!cancelled) setAgentDetail(next);
      })
      .catch(() => {
        if (!cancelled) setAgentDetail(null);
      });

    return () => {
      cancelled = true;
    };
  }, [agents, resolvedAgentId]);

  const agent = useMemo(
    () => (resolvedAgentId
      ? agents.find((candidate) => candidate.id === resolvedAgentId) ??
        (agentDetail?.id === resolvedAgentId ? agentDetail : null)
      : null),
    [agentDetail, agents, resolvedAgentId],
  );

  if (!agent) {
    return (
      <div>
        <BackToPicker
          slot="agent-info"
          fallback={{ view: "conversation", conversationId }}
          navigate={navigate}
        />
        {error && <p className="s-error">{error}</p>}
        <div className="s-empty"><p>Agent not found</p></div>
      </div>
    );
  }

  const shortHandle = minimalAgentHandle(agent);
  const displayHandle = agent.handle ? `@${agent.handle.replace(/^@+/, "")}` : null;
  const primarySelector = agent.selector ?? agent.defaultSelector ?? displayHandle;
  const stateLabel = agentStateLabel(agent.state);
  const nodeLabel = agent.authorityNodeName
    ? `${agent.authorityNodeName} (${agent.authorityNodeId ?? "unknown"})`
    : agent.authorityNodeId;
  const homeNodeLabel = agent.homeNodeName
    ? `${agent.homeNodeName} (${agent.homeNodeId ?? "unknown"})`
    : agent.homeNodeId;
  const skills = agent.skills ?? [];
  const protocol = protocolLabel(agent.protocol);
  const hasExternalCardIdentity = Boolean(agent.providerName || protocol || skills.length > 0);
  const projectIdentity = projectIdentityForAgent(agent);
  const projectTitle = projectIdentity.title;
  const aliasTitle = aliasTitleForAgent(agent, session, projectTitle, projectIdentity.slug);
  const profileTitle = aliasTitle ? `${projectTitle} · ${aliasTitle}` : projectTitle;
  const participant = session?.participants?.find((entry) =>
    entry.agentId === agent.id || entry.actorId === agent.id,
  );
  const modelLabel = agent.model && agent.harness && agent.model.startsWith(`${agent.harness}-`)
    ? agent.model.slice(agent.harness.length + 1)
    : agent.model;
  const runtimeLabel = [formatLabel(agent.harness ?? "") ?? agent.harness, modelLabel]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
  const stableAliasItems: ProfileField[] = [
    { label: "Project", value: projectTitle },
    { label: "Alias", value: aliasTitle ?? "Default project participant" },
    ...(primarySelector ? [{ label: "Primary selector", value: <CodeValue value={primarySelector} /> }] : []),
    ...(participant?.scopedAlias ? [{ label: "Scoped alias", value: <CodeValue value={participant.scopedAlias} /> }] : []),
    ...(displayHandle ? [{ label: "Handle", value: <CodeValue value={displayHandle} /> }] : []),
    ...(agent.defaultSelector && agent.defaultSelector !== agent.selector
      ? [{ label: "Default selector", value: <CodeValue value={agent.defaultSelector} /> }]
      : []),
    { label: "Definition", value: <CodeValue value={agent.definitionId} /> },
  ];
  const diagnosticsItems: ProfileField[] = [
    { label: "Routable agent ID", value: <CodeValue value={agent.id} /> },
    ...(agent.providerName
      ? [{ label: "Provider", value: <ProviderValue name={agent.providerName} url={agent.providerUrl} /> }]
      : []),
    ...(protocol ? [{ label: "Protocol", value: protocol }] : []),
    ...(skills.length > 0 ? [{ label: "Skills", value: <CapabilityTokens values={skills} /> }] : []),
    ...(!hasExternalCardIdentity ? [{ label: "Class", value: formatLabel(agent.agentClass) ?? "—" }] : []),
    ...(!hasExternalCardIdentity && agent.role ? [{ label: "Role", value: formatLabel(agent.role) ?? agent.role }] : []),
    ...(agent.authorityProfile
      ? [{ label: "Authority profile", value: <CodeValue value={agent.authorityProfile.roleId} /> }]
      : []),
    ...(agent.workspaceQualifier
      ? [{ label: "Workspace qualifier", value: <CodeValue value={agent.workspaceQualifier} /> }]
      : []),
    ...(agent.nodeQualifier ? [{ label: "Node qualifier", value: <CodeValue value={agent.nodeQualifier} /> }] : []),
    ...(agent.staleLocalRegistration
      ? [{
        label: "Registration",
        value: agent.replacedByAgentId
          ? `Superseded by ${agent.replacedByAgentId}`
          : "Historical registration",
      }]
      : []),
    ...(agent.retiredFromFleet ? [{ label: "Fleet state", value: "Retired" }] : []),
  ];
  const locationItems: ProfileField[] = [
    ...(agent.projectRoot ? [{ label: "Project path", value: <CodeValue value={agent.projectRoot} /> }] : []),
    ...(agent.cwd ? [{ label: "Working dir", value: <CodeValue value={agent.cwd} /> }] : []),
    ...(agent.branch ? [{ label: "Branch", value: agent.branch }] : []),
    ...(nodeLabel ? [{ label: "Authority node", value: <CodeValue value={nodeLabel} /> }] : []),
    ...(homeNodeLabel ? [{ label: "Home node", value: <CodeValue value={homeNodeLabel} /> }] : []),
    ...(agent.ownerId ? [{ label: "Owner", value: agent.ownerName ? `${agent.ownerName} (${agent.ownerId})` : agent.ownerId }] : []),
    ...(agent.conversationId
      ? [{ label: "Direct conversation", value: <CodeValue value={agent.conversationId} /> }]
      : []),
  ];
  const runtimeItems: ProfileField[] = [
    ...(!hasExternalCardIdentity && agent.harness ? [{ label: "Harness", value: agent.harness }] : []),
    ...(agent.model ? [{ label: "Model", value: agent.model }] : []),
    ...(!hasExternalCardIdentity && agent.transport ? [{ label: "Transport", value: formatLabel(agent.transport) ?? agent.transport }] : []),
    ...(agent.wakePolicy ? [{ label: "Wake policy", value: formatLabel(agent.wakePolicy) ?? agent.wakePolicy }] : []),
    ...(agent.harnessSessionId ? [{ label: protocol ? `${protocol} session` : "Harness session", value: <CodeValue value={agent.harnessSessionId} /> }] : []),
    ...(agent.harnessLogPath ? [{ label: "Harness log", value: <CodeValue value={agent.harnessLogPath} /> }] : []),
    ...(agent.capabilities.length > 0 ? [{ label: "Capabilities", value: <CapabilityTokens values={agent.capabilities} /> }] : []),
    ...(agent.authorityProfile?.readTools.length
      ? [{ label: "Broker reads", value: <CapabilityTokens values={agent.authorityProfile.readTools} /> }]
      : []),
    ...(agent.authorityProfile?.writeTools.length
      ? [{ label: "Broker writes", value: <CapabilityTokens values={agent.authorityProfile.writeTools} /> }]
      : []),
    ...(agent.authorityProfile
      ? [{
          label: "Machine access",
          value: `shell ${agent.authorityProfile.shell ? "allowed" : "blocked"} · code writes ${agent.authorityProfile.codebaseWrites ? "allowed" : "blocked"}`,
        }]
      : []),
    ...(agent.runtimePolicy?.sandbox
      ? [{ label: "Sandbox", value: agent.runtimePolicy.sandbox }]
      : []),
  ];
  const conversationItems: ProfileField[] = [
    { label: "Conversation ID", value: <CodeValue value={conversationId} /> },
    ...(session?.alias ? [{ label: "Conversation alias", value: <CodeValue value={session.alias} /> }] : []),
    ...(session?.naturalKey ? [{ label: "Natural key", value: <CodeValue value={session.naturalKey} /> }] : []),
    ...(session?.workspaceRoot ? [{ label: "Workspace", value: <CodeValue value={session.workspaceRoot} /> }] : []),
    ...(session?.currentBranch ? [{ label: "Session branch", value: session.currentBranch }] : []),
    ...(session?.messageCount != null ? [{ label: "Messages", value: String(session.messageCount) }] : []),
    ...(session?.lastMessageAt ? [{ label: "Last message", value: fullTimestamp(session.lastMessageAt) }] : []),
  ];

  return (
    <div className="s-agent-profile-page">
      <div className="s-agent-profile-page-topbar">
        <BackToPicker
          slot="agent-info"
          fallback={{ view: "conversation", conversationId }}
          navigate={navigate}
        />
        <button
          type="button"
          className="s-btn"
          onClick={() => navigate({ view: "agents-v2", agentId: agent.id })}
        >
          Open in Agents
        </button>
      </div>

      {error && <p className="s-error">{error}</p>}

      <section className="s-agent-profile-hero">
        <div className="s-agent-profile-hero-main">
          <div className="s-agent-profile-hero-title-row">
            <div
              className="s-avatar s-agent-profile-hero-avatar"
              style={{ background: actorColor(agent.name) }}
            >
              {agent.name[0].toUpperCase()}
            </div>
            <div className="s-agent-profile-hero-copy">
              <div className="s-agent-casefile-title-meta">
                <span className="s-agent-casefile-record">
                  {primarySelector ?? shortHandle ?? compactAgentId(agent.id) ?? agent.id}
                </span>
                {stateLabel && (
                  <span className={`s-agent-state-chip s-agent-state-chip-${agentStateCssToken(agent.state)}`}>
                    <span className="s-dot" style={{ background: stateColor(agent.state) }} />
                    {stateLabel}
                  </span>
                )}
                {agent.staleLocalRegistration && (
                  <span className="s-agent-state-chip s-agent-state-chip-offline">
                    Superseded registration
                  </span>
                )}
              </div>
              <h1 className="s-agent-profile-hero-title">{profileTitle}</h1>
              <div className="s-agent-profile-hero-tags">
                <FieldChip label="Project" value={projectTitle} />
                <FieldChip label="Alias" value={aliasTitle ?? "Default"} />
                <FieldChip label="Runtime" value={runtimeLabel || null} />
                <FieldChip label="Host" value={agent.homeNodeName?.replace(/\.local$/i, "") ?? null} />
              </div>
              <p className="s-agent-profile-hero-context">
                {session?.title
                  ? `Conversation: ${session.title}.`
                  : "Attached to this conversation."}
                {agent.updatedAt ? ` Updated ${timeAgo(agent.updatedAt)}.` : ""}
              </p>
            </div>
          </div>
        </div>
        <div className="s-agent-profile-hero-actions">
          <AgentLiveActions
            agent={agent}
            navigate={navigate}
            returnTo={route}
          />
          <button
            type="button"
            className="s-btn s-btn-primary"
            onClick={() => openContent(navigate, { view: "conversation", conversationId }, { returnTo: route })}
          >
            Open conversation
          </button>
        </div>
      </section>

      <div className="s-agent-profile-grid">
        <ProfileCard
          title="Stable alias"
          subtitle="Repeatable project identity used to route future work."
          items={stableAliasItems}
          variant="primary"
        />
        <ProfileCard
          title="Current conversation"
          subtitle="Unique DM/context attached to this page."
          items={conversationItems}
        />
        <ProfileCard
          title="Runtime instance"
          subtitle="Concrete harness state for the current attachment."
          items={runtimeItems}
        />
        <ProfileCard
          title="Location"
          subtitle="Where this alias resolves right now."
          items={locationItems}
        />
        <ProfileCard
          title="Diagnostics"
          subtitle="Broker and provider fields for debugging."
          items={diagnosticsItems}
          variant="secondary"
        />
      </div>

      <ObservedTopologyPanel
        title="Observed harness families"
        size="compact"
        maxAgents={8}
        maxTasks={4}
        showEmpty
      />
    </div>
  );
}
