/**
 * Comms · Flow, the graph drawing.
 *
 * A rail per branch of work: it opens where someone is first addressed, carries
 * their messages as commits, and closes when the answer merges back. Time runs
 * down, oldest first — `git log` is newest-first, but a chain of work is read
 * forward, the way the thread beside it is.
 *
 * Two rules the drawing never breaks: hue is direction (accent for what is
 * addressed to you, dim dotted for broker status, neutral for the rest) and
 * weight is selection. Nothing changes colour to say "current".
 */

import "./comms-flow.css";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Message } from "../../lib/types.ts";
import { buildCommsFlow, flowDuration, type FlowSourceMessage } from "../../lib/comms-flow.ts";
import type { FlowFlight, FlowPass } from "../../lib/comms-flow.ts";
import { CommsCanvas } from "./CommsCanvas.tsx";
import { CommsFlowMap, mapIdentities } from "./CommsFlowMap.tsx";
import { CommsSelection, type BesideControl } from "./CommsSelection.tsx";
import { flowTasks, type MapIdentity } from "./comms-flow-map.ts";
import { deckFocus, deckToken, type DeckCard } from "./comms-deck.ts";
import {
  GRAPH_METRICS,
  commsFlowGraphLayout,
  railX,
  type GraphRow,
} from "./comms-flow-graph.ts";

const DOT = 4.5;
/** Left edge of the message text: clear of the rails, and stable while they come and go. */
const TEXT_MIN = 128;

function clock(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}


function passLineClass(pass: FlowPass, selected: boolean): string {
  return [
    "cf-line",
    pass.kind === "status" ? "cf-line--status" : "",
    pass.kind === "channel" ? "cf-line--channel" : "",
    pass.inbound ? "cf-line--in" : "",
    selected ? "cf-line--on" : "",
  ].filter(Boolean).join(" ");
}

function PassTags({ pass }: { pass: FlowPass }) {
  return (
    <>
      {pass.askId ? <span className="cf-tag">answer</span> : null}
      {pass.count > 1 ? <span className="cf-tag">×{pass.count}</span> : null}
      {pass.kind === "channel" ? <span className="cf-tag">to the conversation</span> : null}
    </>
  );
}

export function CommsFlowGraph({
  passes,
  flights,
  selectedId,
  onSelect,
}: {
  passes: readonly FlowPass[];
  flights: readonly FlowFlight[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
}) {
  const layout = useMemo(() => commsFlowGraphLayout(passes, flights), [passes, flights]);
  const textX = Math.max(TEXT_MIN, railX(layout.columns - 1) + 22);

  if (layout.rows.length === 0) {
    return (
      <div className="cf-graph-empty">
        <p>Nothing has passed between anyone in this window yet.</p>
      </div>
    );
  }

  // The svg covers the rail gutter only, so the rows are free to take whatever
  // width the pane has. Sizing the svg to the pane instead would either stretch
  // the rails when it resized, or cap the text at a width that is not the pane's.
  return (
    <div className="cf-graph" style={{ height: layout.height }}>
      <svg
        className="cf-graph-svg"
        width={textX}
        height={layout.height}
        viewBox={`0 0 ${textX} ${layout.height}`}
        aria-hidden="true"
      >
        {layout.spans.map((span) => (
          <g key={span.key}>
            <rect
              className="cf-wait"
              x={railX(span.column) - 5}
              y={span.y0}
              width={10}
              height={Math.max(2, span.y1 - span.y0)}
              rx={5}
            />
            {span.timeoutY !== null ? (
              <line
                className="cf-timeout"
                x1={railX(span.column) - 7}
                x2={railX(span.column) + 7}
                y1={span.timeoutY}
                y2={span.timeoutY}
              />
            ) : null}
          </g>
        ))}
        {layout.rails.map((rail) => (
          <line
            key={rail.key}
            className={rail.actor.kind === "broker" ? "cf-rail cf-rail--dim" : "cf-rail"}
            x1={railX(rail.column)}
            x2={railX(rail.column)}
            y1={rail.y0}
            y2={rail.y1}
          />
        ))}
        {layout.edges.map((edge) => (
          <path
            key={edge.key}
            className={`cf-edge ${passLineClass(edge.pass, edge.pass.id === selectedId)}`}
            d={edge.d}
          />
        ))}
        {layout.rows.map((row) =>
          row.kind === "pass" ? (
            <circle
              key={`dot-${row.pass.id}`}
              className={
                row.pass.kind === "status"
                  ? "cf-dot cf-dot--status"
                  : row.pass.inbound
                    ? "cf-dot cf-dot--in"
                    : row.pass.kind === "channel"
                      ? "cf-dot cf-dot--channel"
                      : "cf-dot"
              }
              cx={railX(row.column)}
              cy={row.y}
              r={row.pass.id === selectedId ? DOT + 1.5 : DOT}
            />
          ) : null,
        )}
      </svg>

      {layout.rows.map((row: GraphRow) =>
        row.kind === "quiet" ? (
          <div key={`quiet-${row.y}`} className="cf-quiet" style={{ top: row.y - 8, left: textX }}>
            {flowDuration(row.ms)} quiet
          </div>
        ) : (
          <button
            key={row.pass.id}
            type="button"
            className={`cf-row${row.pass.id === selectedId ? " cf-row--on" : ""}`}
            style={{
              top: row.y - GRAPH_METRICS.row / 2 + 3,
              height: GRAPH_METRICS.row - 6,
              paddingLeft: textX,
            }}
            onClick={() => onSelect?.(row.pass.id)}
            aria-pressed={row.pass.id === selectedId}
            title={row.pass.message.body}
          >
            <span className="cf-time">{clock(row.pass.at)}</span>
            <span className="cf-route">
              {row.pass.from.short}
              <span className="cf-dim"> to </span>
              {row.pass.kind === "channel" ? "the conversation" : row.pass.audience.map((a) => a.short).join(", ")}
            </span>
            <span className={`cf-body${row.pass.kind === "status" ? " cf-body--status" : ""}`}>
              {row.pass.message.body}
            </span>
            <PassTags pass={row.pass} />
          </button>
        ),
      )}

      {/* How long a branch was out, sat by its merge. Kept to the duration alone
          so it stays inside the rail gutter and never crosses the rows. */}
      {layout.spans.map((span) => (
        <div
          key={`merge-${span.key}`}
          className="cf-merge-label"
          style={{ top: span.y1 + GRAPH_METRICS.merge - 7, left: railX(span.column) + 9 }}
        >
          {flowDuration(span.flight.answer.at - span.flight.opener.at)}
        </div>
      ))}
    </div>
  );
}

/**
 * One drawing, with the selection docked beside it.
 *
 * Kept separate from the pane below so the agent surface can mount the same
 * drawing, and the same panel, against a selection it holds itself.
 */
export function CommsFlowView({
  passes,
  flights,
  identities,
  view,
  rootId,
  selected,
  onSelect,
  onStage,
  beside,
}: {
  passes: readonly FlowPass[];
  flights: readonly FlowFlight[];
  identities: ReadonlyMap<string, MapIdentity>;
  view: "flow" | "map" | "canvas";
  /** Whose surface this is, so the canvas can draw that agent's branch of it. */
  rootId?: string | null;
  /** The one thing selected in the drawing, if anything. */
  selected: DeckCard | null;
  onSelect: (card: DeckCard | null) => void;
  /** The selection leads to conversations; this puts one on the stage. */
  onStage: (conversationId: string) => void;
  /** Or keeps it beside. A page with no columns offers no such thing. */
  beside?: BesideControl;
}) {
  const tasks = useMemo(() => flowTasks(passes, flights), [passes, flights]);
  const focus = useMemo(() => deckFocus(selected, tasks), [selected, tasks]);
  const selectedId = selected ? deckToken(selected) : null;
  const clear = useCallback(() => onSelect(null), [onSelect]);

  let drawing: ReactNode;
  if (view === "canvas") {
    drawing = (
      <CommsCanvas
        passes={passes}
        flights={flights}
        identities={identities}
        rootId={rootId}
        focus={focus}
        selectedId={selectedId}
        onOpen={onSelect}
      />
    );
  } else if (view === "map") {
    drawing = (
      <CommsFlowMap
        passes={passes}
        flights={flights}
        identities={identities}
        focus={focus}
        selectedId={selectedId}
        onOpen={onSelect}
      />
    );
  } else {
    drawing = (
      <>
        <CommsFlowGraph
          passes={passes}
          flights={flights}
          selectedId={selected?.kind === "message" ? selected.passId : null}
          onSelect={(id) => onSelect({ kind: "message", passId: id })}
        />
        {passes.length > 0 && (
          <div className="cf-legend">
            <span><i className="cf-swatch" /> message</span>
            <span><i className="cf-swatch cf-swatch--in" /> addressed to you</span>
            <span><i className="cf-swatch cf-swatch--status" /> broker status</span>
            <span><i className="cf-swatch cf-swatch--wait" /> waiting on an answer</span>
            <span><i className="cf-swatch cf-swatch--fork" /> work forks and merges back</span>
            {flights.length > 0 && (
              <span className="cf-dim">
                {flights.length} ask{flights.length === 1 ? "" : "s"} answered in this window
              </span>
            )}
          </div>
        )}
      </>
    );
  }

  return (
    <div className="cf-surface">
      <div className="cf-pane">{drawing}</div>
      {selected ? (
        <CommsSelection
          card={selected}
          passes={passes}
          tasks={tasks}
          onClear={clear}
          onStage={onStage}
          beside={beside}
        />
      ) : null}
    </div>
  );
}

/**
 * The Flow pane: a window of a conversation's messages, drawn as branches.
 *
 * Takes the transcript the thread already has, so opening this costs no fetch
 * and shows exactly what the thread shows — the same messages, arranged by who
 * was waiting on whom instead of by when they arrived. What is clicked in the
 * drawing is selected, and shown beside it.
 */
export function CommsFlowPane({
  messages,
  view,
  participants,
  onStage,
  beside,
}: {
  messages: readonly Message[];
  view: "flow" | "map" | "canvas";
  participants?: readonly { actorId: string; model?: string | null; harness?: string | null }[];
  onStage: (conversationId: string) => void;
  beside?: BesideControl;
}) {
  const [selected, setSelected] = useState<DeckCard | null>(null);
  // Another drawing is another set of things to click; what was selected in
  // the last one is not on it.
  useEffect(() => setSelected(null), [view]);
  const identities = useMemo(() => mapIdentities(participants), [participants]);

  const { passes, flights } = useMemo(() => {
    const source: FlowSourceMessage[] = messages
      // A message with no actor has no sender to draw it from.
      .filter((message): message is Message & { actorId: string } => Boolean(message.actorId))
      .map((message) => ({
        id: message.id,
        conversationId: message.conversationId,
        actorId: message.actorId,
        actorName: message.actorName,
        body: message.body,
        createdAt: message.createdAt,
        class: message.class,
        metadata: message.metadata ?? null,
        replyToMessageId: message.replyToMessageId ?? null,
      }));
    return buildCommsFlow(source);
  }, [messages]);

  return (
    <CommsFlowView
      passes={passes}
      flights={flights}
      identities={identities}
      view={view}
      selected={selected}
      onSelect={setSelected}
      onStage={onStage}
      beside={beside}
    />
  );
}
