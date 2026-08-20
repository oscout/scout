import { agentStateLabel, normalizeAgentState } from "../../lib/agent-state.ts";
import { statusOnHover } from "../../lib/page-status.ts";
import { timeAgo } from "../../lib/time.ts";
import { RailRow } from "../../scout/slots/RailRow.tsx";
import type { MissionVisibleAgent } from "../../lib/mission-control-store.ts";

export function MissionLeftAgentRow({
  agent,
  state,
  isExpanded,
  isSelected,
  tabIndex,
  onToggle,
  onReveal,
  onOpen,
}: {
  agent: MissionVisibleAgent;
  state: ReturnType<typeof normalizeAgentState>;
  isExpanded: boolean;
  isSelected: boolean;
  tabIndex: 0 | -1;
  onToggle: (e: React.MouseEvent | React.KeyboardEvent) => void;
  onReveal: () => void;
  onOpen: () => void;
}) {
  const hoverHandlers = statusOnHover({
    label: `Focus ${agent.handle ?? agent.name}`,
    route: `/ops/control · ${agent.id}`,
  });
  const detail = (
    <>
      <dl className="rr-spec-list">
        <SpecLine label="MODEL" value={[agent.harness, agent.model].filter(Boolean).join("/") || "—"} />
        <SpecLine label="AT" value={[agent.project, agent.branch].filter(Boolean).join("/") || "—"} />
        <SpecLine label="STATE" value={agentStateLabel(state)} />
        <SpecLine label="ACTIVITY" value={agent.activity} />
        <SpecLine label="SOURCE" value={agent.source} />
      </dl>
      <div className="ml-detail-actions">
        <button type="button" className="ml-detail-btn" onClick={onReveal}>
          Reveal on wall
        </button>
        <button type="button" className="ml-detail-btn ml-detail-btn--primary" onClick={onOpen}>
          Open ↗
        </button>
      </div>
    </>
  );
  return (
    <RailRow
      name={agent.handle ?? agent.name}
      meta={agent.lastActiveAt ? timeAgo(agent.lastActiveAt) : agent.updatedAt ? timeAgo(agent.updatedAt) : undefined}
      tone={state}
      caret={isExpanded ? "open" : "closed"}
      selected={isSelected}
      expanded={isExpanded}
      detail={detail}
      tabIndex={tabIndex}
      onClick={(e) => onToggle(e)}
      onPointerEnter={hoverHandlers.onPointerEnter as (e: React.PointerEvent) => void}
      onPointerLeave={hoverHandlers.onPointerLeave as (e: React.PointerEvent) => void}
    />
  );
}

function SpecLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="rr-spec">
      <dt className="rr-spec-label">{label}</dt>
      <dd className="rr-spec-value" title={value}>{value}</dd>
    </div>
  );
}
