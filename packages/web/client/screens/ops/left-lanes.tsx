import { useMemo } from "react";
import "../../scout/slots/ctx-panel.css";
import { timeAgo } from "../../lib/time.ts";
import { useScout } from "../../scout/Provider.tsx";
import { RailRow } from "../../scout/slots/RailRow.tsx";
import { SpriteAvatar } from "../../components/SpriteAvatar.tsx";
import { focusDeckLane } from "./lane-focus.ts";
import { buildFallbackLaneRoster } from "./lane-roster-fallback.ts";
import {
  getFloorLedgerHandlers,
  useLaneFocusId,
  useLaneRoster,
  type LaneRosterEntry,
} from "./lane-roster-store.ts";

/** Lanes-mode left rail: a 1:1 mirror of the deck's rendered columns so the
 *  count and order always match the strip on screen, and off-viewport lanes
 *  (the deck h-scrolls) get a jump target. The deck publishes the roster it
 *  rendered; until it does (the rail can mount a beat early), we show an interim
 *  fleet-derived list so the rail isn't blank. When the FLOOR layout publishes,
 *  entries carry a rich ledger projection (action line, activity strip, counts)
 *  and rows hover-link to the floor's lanes through the store. */
export function OpsLanesLeft() {
  const { agents, navigate } = useScout();
  const published = useLaneRoster();
  const focusedLaneId = useLaneFocusId();

  // Interim roster while the deck hasn't published yet: the same fleet agents
  // that seed the deck's scout lanes (live transport / provider session, minus
  // idle codex relays), read from the already-loaded fleet without the deck's
  // tail/observe polling. Ignored the moment `published` (the real mirror) lands.
  const fallback = useMemo<LaneRosterEntry[]>(
    () => buildFallbackLaneRoster(agents),
    [agents],
  );

  const lanes = published ?? fallback;
  const floorMode = lanes.some((entry) => entry.floor);

  return (
    <div className="ctx-panel ctx-panel--ops">
      <section className="ctx-panel-section">
        <div className="ctx-panel-section-label">
          {floorMode ? "Fleet" : "Lanes"}
          {lanes.length > 0 && <span className="ctx-panel-count">{lanes.length}</span>}
        </div>
        {lanes.length === 0 ? (
          <div className="ctx-panel-empty">No active lanes</div>
        ) : (
          lanes.map((entry) => entry.floor ? (
            <button
              key={entry.id}
              type="button"
              className={`agent-floor__ledger-row is-rail${focusedLaneId === entry.id ? " is-focus" : ""}`}
              onClick={() => {
                const handlers = getFloorLedgerHandlers();
                if (handlers) handlers.onSelect(entry.id);
                else focusDeckLane(entry.id, entry.agentId, navigate);
              }}
              onPointerEnter={() => getFloorLedgerHandlers()?.onHover(entry.id)}
              onPointerLeave={() => getFloorLedgerHandlers()?.onHover(null)}
            >
              <span className="agent-floor__ledger-id">
                <SpriteAvatar name={entry.label} size={16} tile />
                <span className="agent-floor__ledger-name">{entry.label}</span>
                <span className={`agent-floor__card-dot${entry.floor.live ? " is-live" : ""}`} />
              </span>
              <span className="agent-floor__ledger-strip">
                {entry.floor.strip.slice(-6).map((kind, blockIndex) => (
                  <span key={blockIndex} className={`agent-floor__ledger-cell is-${kind}`} />
                ))}
              </span>
            </button>
          ) : (
            <RailRow
              key={entry.id}
              name={entry.label}
              // SCO-085: two-line rows — project/machine + harness under the name;
              // status semantics via tone dot (running/waiting/failed/idle).
              sub={entry.statusLabel || undefined}
              meta={entry.updatedAt ? timeAgo(entry.updatedAt) : undefined}
              tone={entry.tone}
              title={entry.statusLabel}
              onClick={() => focusDeckLane(entry.id, entry.agentId, navigate)}
            />
          ))
        )}
      </section>
    </div>
  );
}
