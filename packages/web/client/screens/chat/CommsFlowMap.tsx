import { useMemo, useState, type KeyboardEvent } from "react";
import { flowCanonicalId, flowDuration, type FlowFlight, type FlowPass } from "../../lib/comms-flow.ts";
import {
  commsFlowMapLayout,
  commsFlowMapPairs,
  flowTasks,
  type MapIdentity,
  type MapNode,
} from "./comms-flow-map.ts";
import { deckToken, type DeckCard } from "./comms-deck.ts";
import { hit, press } from "./comms-gesture.ts";

/** A model id is long and mostly prefix; the tail is what tells two apart. */
function shortModel(model: string): string {
  const tail = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  return tail.replace(/^(claude|openai|anthropic)-/i, "");
}

/**
 * What ran this participant. The model is the better answer and wins wherever
 * the roster states one, but it is recorded for only about half of all actors,
 * so the harness stands in rather than leaving the question blank.
 */
function ranOn(node: { model?: string | null; harness?: string | null }): string | null {
  if (node.model?.trim()) return shortModel(node.model.trim());
  return node.harness?.trim() || null;
}

/** The box is a fixed width, so a name that will not fit has to say so. */
function fit(label: string, max: number): string {
  return label.length <= max ? label : `${label.slice(0, max - 1).trimEnd()}…`;
}

/**
 * A clickable `<g>` is not a control: it takes no focus, answers no keyboard
 * and tells assistive tech nothing. Anything the map opens has to be one.
 */
function NodeBox({
  node,
  dim,
  on,
  onHover,
  onOpen,
}: {
  node: MapNode;
  dim: boolean;
  on: boolean;
  onHover: (id: string | null) => void;
  onOpen: () => void;
}) {
  const ran = ranOn(node);
  return (
    <g
      className={[
        "cfm-node",
        node.hub ? "cfm-node--hub" : "",
        dim ? "cfm-node--dim" : "",
        on ? "cfm-node--on" : "",
      ].filter(Boolean).join(" ")}
      transform={`translate(${node.x} ${node.y})`}
      onMouseEnter={() => onHover(node.id)}
      onMouseLeave={() => onHover(null)}
      aria-label={`${node.actor.short} — ${node.sent} sent, ${node.received} received`}
      {...hit(onOpen)}
    >
      <title>{`${node.actor.short} — ${node.sent} sent, ${node.received} received`}</title>
      <rect className="cfm-box" x={-62} y={-21} width={124} height={42} rx={6} />
      <text className="cfm-name" x={0} y={ran ? -3 : 5}>{fit(node.actor.short, 17)}</text>
      {ran ? (
        <text className={`cfm-model${node.model ? "" : " cfm-model--harness"}`} x={0} y={12}>
          {fit(ran, 20)}
        </text>
      ) : null}
    </g>
  );
}

export function CommsFlowMap({
  passes,
  flights,
  identities,
  focus,
  selectedId,
  onOpen,
}: {
  passes: readonly FlowPass[];
  flights: readonly FlowFlight[];
  identities: ReadonlyMap<string, MapIdentity>;
  /** Who the selection is about. Null is "nothing selected", not "dim everything". */
  focus?: ReadonlySet<string> | null;
  /** The token of the one thing selected, so its row can say so. */
  selectedId?: string | null;
  /** Select: one thing at a time, shown beside the drawing. */
  onOpen?: (card: DeckCard) => void;
}) {
  const [hover, setHover] = useState<string | null>(null);

  const tasks = useMemo(() => flowTasks(passes, flights), [passes, flights]);
  // The map is always the whole window. Redrawing it for one task puts two
  // boxes in a canvas built for twelve and points at something you then cannot
  // read; selection is weight and dimming, never geometry.
  const layout = useMemo(() => commsFlowMapLayout(passes, identities), [passes, identities]);
  const pairs = useMemo(() => commsFlowMapPairs(layout), [layout]);
  const ranOf = (id: string) => ranOn(identities.get(id) ?? { model: null, harness: null });

  if (layout.nodes.length === 0) {
    return <p className="cf-graph-empty">Nothing has been exchanged in this window yet.</p>;
  }

  // Hovering asks about one node; a selection asks about one or two. Either
  // way the rest steps back rather than disappearing.
  const chosen = (id: string) => (focus ? focus.has(id) : false);
  const litNode = (id: string) => {
    if (hover !== null) return hover === id;
    return focus ? focus.has(id) : true;
  };
  const litEdge = (from: string, to: string) => {
    if (hover !== null) return hover === from || hover === to;
    return focus ? focus.has(from) && focus.has(to) : true;
  };
  const unnamed = layout.nodes.length - layout.modelsKnown;
  const isSelected = (card: DeckCard) => selectedId === deckToken(card);

  return (
    <div className="cfm">
      <svg
        className="cfm-svg"
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Who exchanged work with whom in this window"
      >
        {layout.edges.map((edge) => (
          <g
            key={edge.key}
            className={`cfm-edge${edge.inbound ? " cfm-edge--in" : ""}${litEdge(edge.from, edge.to) ? "" : " cfm-edge--dim"}`}
          >
            <path className="cfm-edge-line" d={edge.d} strokeWidth={edge.weight} />
            <path
              className="cfm-edge-tip"
              d="M 0 0 L -7 -3.2 L -7 3.2 Z"
              transform={`translate(${edge.tip.x} ${edge.tip.y}) rotate(${edge.tip.angle})`}
            />
            {onOpen ? (
              // A fat transparent stroke, so a 1px arrow is still a target.
              <path
                className="cfm-edge-hit"
                d={edge.d}
                aria-label={`${edge.count} message${edge.count === 1 ? "" : "s"} — open`}
                {...hit(() => onOpen({ kind: "pair", from: edge.from, to: edge.to }))}
              >
                <title>{`${edge.count} message${edge.count === 1 ? "" : "s"} — open`}</title>
              </path>
            ) : null}
          </g>
        ))}
        {layout.nodes.map((node) => (
          <NodeBox
            key={node.id}
            node={node}
            dim={!litNode(node.id)}
            on={chosen(node.id)}
            onHover={setHover}
            onOpen={() => onOpen?.({ kind: "actor", actorId: node.id })}
          />
        ))}
      </svg>

      {tasks.length > 0 && (
        <ol className="cfm-tasks">
          {tasks.map((entry) => {
            const card: DeckCard = { kind: "task", askId: entry.id };
            return (
              <li key={entry.id}>
                <button
                  type="button"
                  className={`cfm-task${isSelected(card) ? " cfm-task--on" : ""}`}
                  {...press(() => onOpen?.(card))}
                  aria-current={isSelected(card) ? "true" : undefined}
                  title={entry.title}
                >
                  <span className="cfm-task-title">{entry.title}</span>
                  <span className="cfm-task-who">
                    {entry.waiter.short}
                    <i className="cfm-arrow">→</i>
                    {entry.worker.short}
                    {ranOf(entry.worker.id) ? <i className="cfm-task-ran">{ranOf(entry.worker.id)}</i> : null}
                  </span>
                  <span className={`cfm-task-ms${entry.abandoned ? " cfm-task-ms--late" : ""}`}>
                    {flowDuration(entry.ms)}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}

      <ol className="cfm-pairs">
        {pairs.map((pair) => {
          const card: DeckCard = { kind: "pair", from: pair.from.id, to: pair.to.id };
          return (
            <li key={pair.key} className={litEdge(pair.from.id, pair.to.id) ? "" : "cfm-pair--dim"}>
              <button
                type="button"
                className={`cfm-pair${isSelected(card) ? " cfm-pair--on" : ""}`}
                {...press(() => onOpen?.(card))}
                aria-current={isSelected(card) ? "true" : undefined}
                onMouseEnter={() => setHover(pair.from.id)}
                onMouseLeave={() => setHover(null)}
              >
                <span className="cfm-pair-who">
                  {pair.from.actor.short}
                  <i className="cfm-arrow">→</i>
                  {pair.to.actor.short}
                </span>
                <span className="cfm-pair-models">
                  {ranOn(pair.from) ?? "not stated"}
                  <i className="cfm-arrow">→</i>
                  {ranOn(pair.to) ?? "not stated"}
                </span>
                <span className="cfm-pair-count">{pair.count}</span>
              </button>
            </li>
          );
        })}
      </ol>

      <div className="cf-legend">
        <span><i className="cf-swatch" /> exchange, thicker with volume</span>
        <span><i className="cf-swatch cf-swatch--in" /> addressed to you</span>
        {layout.broadcasts > 0 && (
          <span className="cf-dim">
            {layout.broadcasts} to the whole conversation, which is not a pair
          </span>
        )}
        <span className="cf-dim">
          {unnamed === 0
            ? `all ${layout.nodes.length} name a model`
            : `${layout.modelsKnown} of ${layout.nodes.length} name a model; the rest show the harness that ran them`}
        </span>
      </div>
    </div>
  );
}

/** Roster facts keyed the way the flow model names an actor. */
export function mapIdentities(
  participants: readonly { actorId: string; model?: string | null; harness?: string | null }[] | undefined,
): Map<string, MapIdentity> {
  const identities = new Map<string, MapIdentity>();
  for (const participant of participants ?? []) {
    if (!participant.model && !participant.harness) continue;
    const id = flowCanonicalId(participant.actorId);
    const held = identities.get(id);
    // First writer wins, but never let a blank overwrite a stated fact.
    identities.set(id, {
      model: held?.model ?? participant.model ?? null,
      harness: held?.harness ?? participant.harness ?? null,
    });
  }
  return identities;
}
