import { useId, useState } from "react";
import type { HerdrSessionTopology } from "@openscout/protocol";
import { compactTerminalPath } from "../../lib/terminal-sessions.ts";
import { AgentStatusDot, herdrTabSummary } from "./HerdrSession.tsx";

/** A read-only map and directory of the same observed session. */
export function HerdrSessionPreview({ topology, stale = false }: { topology: HerdrSessionTopology; stale?: boolean }) {
  const [view, setView] = useState<"layout" | "list">("layout");
  const [selected, setSelected] = useState<string | null>(null);
  const id = useId();
  const entries = topology.workspaces.flatMap((workspace) => workspace.tabs.map((tab) => ({
    workspace, tab, key: `${workspace.workspaceId}:${tab.tabId}`,
  })));
  const active = entries.find((entry) => entry.key === selected)
    ?? entries.find(({ workspace, tab }) => workspace.focused && tab.tabId === workspace.activeTabId)
    ?? entries[0];
  const live = topology.running && !stale;
  const layout = active?.tab.layout;
  const area = layout?.area;
  const hasGeometry = layout && area && area.width > 0 && area.height > 0 && layout.panes.length > 0;
  return (
    <div className="s-herdr-preview">
      <div className="s-herdr-preview-controls" role="group" aria-label="Herdr preview view">
        {(["layout", "list"] as const).map((mode) => (
          <button key={mode} type="button" aria-pressed={view === mode} onClick={() => setView(mode)}>{mode === "layout" ? "Layout" : "List"}</button>
        ))}
      </div>
      {view === "layout" && active ? <>
        <div className="s-herdr-tabs" role="tablist" aria-label="Herdr session tabs">
          {entries.map(({ workspace, tab, key }, index) => (
            <button key={key} type="button" role="tab" id={`${id}-tab-${index}`}
              aria-selected={key === active.key} aria-controls={`${id}-layout`} tabIndex={key === active.key ? 0 : -1}
              className={`s-herdr-tab ${key === active.key ? "s-herdr-tab--active" : ""}`}
              onClick={() => setSelected(key)} onKeyDown={(event) => {
                const next = event.key === "ArrowRight" ? (index + 1) % entries.length
                  : event.key === "ArrowLeft" ? (index + entries.length - 1) % entries.length
                  : event.key === "Home" ? 0 : event.key === "End" ? entries.length - 1 : null;
                if (next === null) return;
                event.preventDefault(); setSelected(entries[next]!.key);
                document.getElementById(`${id}-tab-${next}`)?.focus();
              }}>
              <AgentStatusDot status={live ? tab.agentStatus : "unknown"} />
              <span>{herdrTabSummary(workspace, tab).label}</span>
              <span className="s-herdr-tab-count">{tab.panes.length}</span>
            </button>
          ))}
        </div>
        <div id={`${id}-layout`} role="tabpanel" aria-labelledby={`${id}-tab-${entries.indexOf(active)}`}>
          {hasGeometry ? <div className="s-herdr-layout-window">
            <div className="s-herdr-layout-titlebar">
              <span className="s-herdr-layout-lights" aria-hidden="true"><i /><i /><i /></span>
              <span>{active.tab.panes.length} panes · {live ? "Live layout" : "Last known layout"}</span>
            </div>
            <div className="s-herdr-layout" style={{ aspectRatio: `${area.width} / ${Math.max(area.height * 2, 1)}` }}>
              {layout.panes.map(({ paneId, rect, focused }) => {
                const pane = active.tab.panes.find((entry) => entry.paneId === paneId);
                return <div key={paneId} className={`s-herdr-layout-pane ${focused ? "s-herdr-layout-pane--focused" : ""}`}
                  style={{ left: `${(rect.x - area.x) / area.width * 100}%`, top: `${(rect.y - area.y) / area.height * 100}%`, width: `${rect.width / area.width * 100}%`, height: `${rect.height / area.height * 100}%` }}
                  title={[pane?.name, pane?.label, pane?.foregroundCwd ?? pane?.cwd].filter(Boolean).join(" · ")}>
                  <span className="s-herdr-layout-pane-head"><AgentStatusDot status={live ? pane?.agentStatus ?? "unknown" : "unknown"} /><strong className="s-herdr-pane-label">{pane?.name ?? pane?.label ?? paneId}</strong></span>
                  <span className="s-herdr-preview-pane-kind">{pane?.agent ?? "shell"} · {live ? pane?.agentStatus ?? "unknown" : "last known"}</span>
                  <span className="s-herdr-cwd">{compactTerminalPath(pane?.foregroundCwd ?? pane?.cwd)}</span>
                </div>;
              })}
            </div>
          </div> : <div className="s-term-picker-empty">No pane geometry was reported for this tab. The List view still has its pane details.</div>}
        </div>
      </> : view === "layout" ? <div className="s-term-picker-empty">No tabs reported for this session.</div> : null}
      {view === "list" && <div className="s-term-picker-list s-term-herdr-preview-list" aria-label={`${topology.session} panes`}>
        {entries.flatMap(({ workspace, tab, key }) => tab.panes.map((pane) => (
          <div className="s-term-picker-item" key={`${key}:${pane.paneId}`}>
            <div className="s-term-picker-item-summary">
              <div className="s-term-picker-item-main"><strong title={pane.label ?? undefined}>{pane.name ?? pane.label ?? pane.paneId}</strong><span>{compactTerminalPath(pane.foregroundCwd ?? pane.cwd) || "Directory unknown"}</span></div>
              <div className="s-term-picker-item-meta"><span>{pane.agent ?? "shell"}</span><span>{live ? pane.agentStatus : "last known"}</span><span>{herdrTabSummary(workspace, tab).label}</span></div>
            </div>
          </div>
        )))}
      </div>}
    </div>
  );
}
