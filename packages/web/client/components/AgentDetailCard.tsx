import "./agent-detail-card.css";

import { forwardRef } from "react";
import type { Agent } from "../lib/types.ts";
import { agentStateCssToken, agentStateLabel, normalizeAgentState } from "../lib/agent-state.ts";
import { stateColor } from "../lib/colors.ts";
import { timeAgo } from "../lib/time.ts";
import { AgentLiveActions } from "./AgentLiveActions.tsx";

function homify(path: string | null | undefined): string | null {
  if (!path) return null;
  return path.replace(/^\/Users\/[^/]+/, "~");
}

export type AgentDetailCardProps = {
  agent: Agent;
  pinned: boolean;
  onOpen: () => void;
  onClose: () => void;
  onAction?: () => void;
  style?: React.CSSProperties;
  className?: string;
};

export const AgentDetailCard = forwardRef<HTMLDivElement, AgentDetailCardProps>(
  function AgentDetailCard({ agent, pinned, onOpen, onClose, onAction, style, className }, ref) {
    const state = normalizeAgentState(agent.state);
    const stateClass = agentStateCssToken(agent.state);
    const cwdFull = agent.cwd ?? agent.projectRoot;
    const cwd = pinned ? cwdFull : homify(cwdFull);
    const handle = agent.handle ? `@${agent.handle.replace(/^@+/, "")}` : null;
    const selector = agent.selector ?? agent.defaultSelector;
    const name = handle ?? agent.name;
    const machine = agent.authorityNodeName
      ?? agent.homeNodeName
      ?? agent.authorityNodeId
      ?? agent.homeNodeId;
    const stateLabel = agentStateLabel(state);

    return (
      <div
        ref={ref}
        className={`agent-card${pinned ? " agent-card--pinned" : ""}${className ? ` ${className}` : ""}`}
        style={style}
        role="dialog"
        aria-label={`${name} details`}
      >
        <header className="agent-card-head">
          <div className="agent-card-name">{name}</div>
          <div className="agent-card-meta">
            <span
              className={`agent-card-dot agent-card-dot--${stateClass}`}
              style={state === "in_turn" || state === "in_flight" ? { background: stateColor(agent.state) } : undefined}
            />
            {stateLabel && (
              <span className={`agent-card-state agent-card-state--${stateClass}`}>{stateLabel}</span>
            )}
            {agent.updatedAt && (
              <>
                {stateLabel && <span className="agent-card-sep">·</span>}
                <span className="agent-card-time">{timeAgo(agent.updatedAt)}</span>
              </>
            )}
          </div>
        </header>

        <div className="agent-card-body">
          {handle && (
            <Field label="handle">
              <code className="agent-card-mono">{handle}</code>
            </Field>
          )}

          {selector && (
            <Field label="selector">
              <code className="agent-card-mono">{selector}</code>
            </Field>
          )}

          {cwd && (
            <Field label="cwd">
              <code className="agent-card-mono" title={cwdFull ?? cwd}>{cwd}</code>
            </Field>
          )}

          {machine && (
            <Field label="machine">
              <span className="agent-card-mono">{machine}</span>
            </Field>
          )}

          {(agent.project || agent.branch) && (
            <Field label="project">
              <span className="agent-card-mono">
                {agent.project ?? "—"}
                {agent.branch && (
                  <>
                    <span className="agent-card-sep agent-card-sep--inline">·</span>
                    <span className="agent-card-branch">{agent.branch}</span>
                  </>
                )}
              </span>
            </Field>
          )}

          {(agent.harness || agent.model) && (
            <Field label="runtime">
              <span className="agent-card-mono">
                {agent.harness ?? "—"}
                {agent.model && (
                  <>
                    <span className="agent-card-sep agent-card-sep--inline">·</span>
                    <span className="agent-card-model">{agent.model}</span>
                  </>
                )}
              </span>
            </Field>
          )}

          {agent.transport && (
            <Field label="launch transport">
              <span className="agent-card-mono">{agent.transport}</span>
            </Field>
          )}

          {agent.role && (
            <Field label="role">
              <span className="agent-card-mono">{agent.role}</span>
            </Field>
          )}

          {agent.capabilities && agent.capabilities.length > 0 && (
            <Field label="capabilities">
              <div className="agent-card-caps">
                {agent.capabilities.slice(0, 8).map((cap) => (
                  <span key={cap} className="agent-card-cap">{cap}</span>
                ))}
                {agent.capabilities.length > 8 && (
                  <span className="agent-card-cap agent-card-cap--more">
                    +{agent.capabilities.length - 8}
                  </span>
                )}
              </div>
            </Field>
          )}
        </div>

        <AgentLiveActions
          agent={agent}
          variant="compact"
          onNavigate={onAction}
        />

        <footer className="agent-card-foot">
          <button type="button" className="agent-card-link" onClick={onOpen}>
            Open agent <span aria-hidden>→</span>
          </button>
          {pinned && (
            <button type="button" className="agent-card-close" onClick={onClose} aria-label="Close">
              esc
            </button>
          )}
        </footer>
      </div>
    );
  },
);

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="agent-card-field">
      <span className="agent-card-label">{label}</span>
      <div className="agent-card-value">{children}</div>
    </div>
  );
}
