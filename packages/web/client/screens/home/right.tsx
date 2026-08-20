import { useScout } from "../../scout/Provider.tsx";
import { openAgent } from "../../scout/slots/openAgent.ts";
import { agentStateLabel, isAgentOnline, normalizeAgentState } from "../../lib/agent-state.ts";
import { AgentAvatar } from "../../components/AgentAvatar.tsx";
import { timeAgo } from "../../lib/time.ts";
import type { Agent } from "../../lib/types.ts";

export function HomeRight() {
  const { agents, agentsLoaded, apiConnection, navigate, route } = useScout();
  const openFromHome = (agent: Agent) =>
    openAgent(navigate, agent, { from: "home", returnTo: route });

  if (!agentsLoaded) {
    return (
      <div className="flex h-full flex-col justify-center" aria-busy="true">
        <div className="base-rail-loading" role="status" aria-label="Loading agent roster">
          <span aria-hidden="true" />
          <span aria-hidden="true" />
          <span aria-hidden="true" />
          <span aria-hidden="true" />
        </div>
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-4 text-center font-mono text-sm leading-relaxed text-[var(--scout-chrome-ink-faint)]">
        <div className="mb-1 uppercase tracking-[0.15em]">
          {apiConnection.status === "offline" ? "Roster unavailable" : "No agents"}
        </div>
        <div>{apiConnection.status === "offline" ? apiConnection.message : "Connect an agent to see your roster here."}</div>
      </div>
    );
  }

  const busy = agents.filter((agent) => {
    const state = normalizeAgentState(agent.state, agent);
    return state === "in_turn" || state === "in_flight";
  });
  const callable = agents.filter((agent) => isAgentOnline(agent.state, agent) && !busy.includes(agent));
  const blocked = agents.filter((agent) => !isAgentOnline(agent.state, agent));

  return (
    <div className="flex flex-col h-full overflow-y-auto frame-scrollbar p-4 gap-4 text-sm">
      {busy.length > 0 && (
        <Section label="In progress" count={busy.length}>
          {busy.map((agent) => (
            <AgentRow
              key={agent.id}
              agent={agent}
              onOpen={openFromHome}
              subLabel={agentStateLabel(agent.state, agent)}
            />
          ))}
        </Section>
      )}
      {callable.length > 0 && (
        <Section label="Callable" count={callable.length}>
          {callable.map((agent) => (
            <AgentRow key={agent.id} agent={agent} onOpen={openFromHome} />
          ))}
        </Section>
      )}
      {blocked.length > 0 && (
        <Section label="Blocked" count={blocked.length}>
          {blocked.map((agent) => (
            <AgentRow
              key={agent.id}
              agent={agent}
              onOpen={openFromHome}
              subLabel={agentStateLabel(agent.state, agent)}
              dim
            />
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col">
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-2xs font-mono uppercase tracking-[0.15em] text-[var(--scout-chrome-ink-faint)]">
          {label}
        </span>
        <span className="text-2xs font-mono tabular-nums text-[var(--scout-chrome-ink-ghost)]">
          {count}
        </span>
      </div>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

function AgentRow({
  agent,
  onOpen,
  subLabel,
  dim,
}: {
  agent: Agent;
  onOpen: (agent: Agent) => void;
  subLabel?: string;
  dim?: boolean;
}) {
  return (
    <button
      onClick={() => onOpen(agent)}
      className={`group flex items-center gap-2.5 px-2 py-1.5 rounded-sm text-left transition-colors ${
        dim
          ? "opacity-60 hover:opacity-100 hover:bg-[var(--scout-chrome-hover)]"
          : "hover:bg-[var(--scout-chrome-hover)]"
      }`}
    >
      <AgentAvatar agent={agent} placement="row" />
      <div className="flex flex-col min-w-0 flex-1">
        <span className="truncate font-medium text-[var(--scout-chrome-ink)]">{agent.name}</span>
        {subLabel ? (
          <span className="truncate text-xs text-[var(--scout-chrome-ink-faint)]">{subLabel}</span>
        ) : agent.updatedAt ? (
          <span className="truncate text-xs text-[var(--scout-chrome-ink-ghost)]">
            {timeAgo(agent.updatedAt)}
          </span>
        ) : null}
      </div>
    </button>
  );
}
