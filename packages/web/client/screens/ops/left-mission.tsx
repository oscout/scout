import { useCallback, useRef, useState } from "react";
import "../../scout/slots/ctx-panel.css";
import "../../scout/slots/mission-left.css";
import { normalizeAgentState } from "../../lib/agent-state.ts";
import {
  MISSION_ACTIVITY_WINDOWS,
  clearMissionSelection,
  requestMissionReveal,
  setMissionActivityFilter,
  setMissionActivityWindow,
  setMissionGroupMode,
  setMissionQuery,
  setMissionSourceFilter,
  toggleMissionSelected,
  useMissionControlStore,
} from "../../lib/mission-control-store.ts";
import { useScout } from "../../scout/Provider.tsx";
import {
  makeSearchHandoff,
  rovingTabIndex,
  useListArrowNav,
  useSlashToFocus,
} from "../../lib/keyboard-nav.ts";
import { MissionLeftAgentRow } from "./MissionLeftAgentRow.tsx";

export function OpsMissionLeft() {
  const { navigate } = useScout();
  const mc = useMissionControlStore();
  const visibleAgents = mc.visibleAgents;

  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const onListKeyDown = useListArrowNav();
  const onSearchKeyDown = makeSearchHandoff(() => listRef.current);
  useSlashToFocus(useCallback(() => inputRef.current, []));

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const isActive = mc.activityFilter === "active";
  const selectedCount = mc.selectedIds.length;

  const toggleExpand = (id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  const openTailForSelection = () => {
    if (selectedCount === 0) return;
    const selectedAgents = visibleAgents.filter((a) => mc.selectedIds.includes(a.id));
    const query = selectedAgents
      .map((a) => a.handle ?? a.name)
      .filter(Boolean)
      .join("|");
    if (!query) return;
    navigate({ view: "ops", mode: "tail", tailQuery: query });
  };

  return (
    <div className="ctx-panel ml-panel">
      {/* Primary: source */}
      <div className="ml-section">
        <div className="ml-section-label">Source</div>
        <div className="ml-chips ml-chips--primary">
          {(["all", "scout", "native"] as const).map((f) => (
            <button
              key={f}
              type="button"
              className={["ml-chip", mc.sourceFilter === f && "ml-chip--active"].filter(Boolean).join(" ")}
              onClick={() => setMissionSourceFilter(f)}
            >
              {f === "all" ? "All" : f === "scout" ? "Scout" : "Native"}
            </button>
          ))}
        </div>
      </div>

      {/* Search */}
      <div className="ctx-panel-search">
        <input
          ref={inputRef}
          type="text"
          className="ctx-panel-search-input"
          placeholder="Filter agents…  (press /)"
          value={mc.query}
          onChange={(e) => setMissionQuery(e.target.value)}
          onKeyDown={(e) => {
            onSearchKeyDown(e);
            if (e.key === "Escape" && mc.query) {
              setMissionQuery("");
            }
          }}
        />
      </div>

      {/* Secondary: activity + (conditional) time window — inline, smaller */}
      <div className="ml-section ml-section--secondary">
        <div className="ml-chips ml-chips--secondary">
          {(["active", "live", "all"] as const).map((f) => (
            <button
              key={f}
              type="button"
              className={["ml-chip ml-chip--ghost", mc.activityFilter === f && "ml-chip--ghost-active"].filter(Boolean).join(" ")}
              onClick={() => setMissionActivityFilter(f)}
            >
              {f === "active" ? "Active" : f === "live" ? "Live" : "Any"}
            </button>
          ))}
          {isActive && <span className="ml-divider" aria-hidden />}
          {isActive && MISSION_ACTIVITY_WINDOWS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={["ml-chip ml-chip--ghost", mc.activityWindowMs === opt.value && "ml-chip--ghost-active"].filter(Boolean).join(" ")}
              onClick={() => setMissionActivityWindow(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="ml-section ml-section--grouping">
        <div className="ml-section-label">Order by</div>
        <div className="ml-chips ml-chips--grouping">
          {([
            ["activity", "Activity"],
            ["workspace", "Project"],
            ["harness", "Harness"],
            ["state", "Status"],
            ["source", "Source"],
          ] as const).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              className={[
                "ml-chip",
                "ml-chip--group",
                mc.groupMode === mode && "ml-chip--group-active",
              ].filter(Boolean).join(" ")}
              aria-pressed={mc.groupMode === mode}
              onClick={() => setMissionGroupMode(mode)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {selectedCount > 0 ? (
        <div className="ml-selection">
          <span className="ml-selection-label">{selectedCount} selected</span>
          <div className="ml-selection-actions">
            <button type="button" className="ml-selection-btn ml-selection-btn--primary" onClick={openTailForSelection}>
              Tail ↗
            </button>
            <button type="button" className="ml-selection-btn" onClick={clearMissionSelection}>
              Clear
            </button>
          </div>
        </div>
      ) : (
        <div className="ml-count">
          {visibleAgents.length} visible
          <span className="ml-count-hint">⌘-click · ⌘A all</span>
        </div>
      )}

      <div
        ref={listRef}
        className="ctx-panel-list ctx-panel-list--scroll"
        onKeyDown={onListKeyDown}
      >
        {visibleAgents.length === 0 ? (
          <div className="ctx-panel-empty">
            {mc.query ? "No match" : "Nothing visible"}
          </div>
        ) : (
          visibleAgents.map((agent, idx) => {
            const isExpanded = agent.id === expandedId;
            const hasExpanded = visibleAgents.some((a) => a.id === expandedId);
            const isSelected = mc.selectedIds.includes(agent.id);
            const state = normalizeAgentState(agent.state);
            return (
              <MissionLeftAgentRow
                key={agent.id}
                agent={agent}
                state={state}
                isExpanded={isExpanded}
                isSelected={isSelected}
                tabIndex={rovingTabIndex(isExpanded, hasExpanded, idx === 0)}
                onToggle={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey) {
                    toggleMissionSelected(agent.id);
                  } else {
                    toggleExpand(agent.id);
                  }
                }}
                onReveal={() => requestMissionReveal(agent.id)}
                onOpen={() => navigate({ view: "agents-v2", agentId: agent.id })}
              />
            );
          })
        )}
      </div>
    </div>
  );
}
