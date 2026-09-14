import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { flowDuration, type FlowFlight, type FlowPass } from "../../lib/comms-flow.ts";
import {
  CANVAS_METRICS,
  canvasStep,
  commsCanvasInputs,
  commsCanvasLayout,
  commsCanvasScope,
  type CanvasMode,
  type CanvasNode,
  type CanvasOrder,
  type CanvasStep,
} from "./comms-canvas.ts";
import type { MapIdentity } from "./comms-flow-map.ts";
import { deckToken, type DeckCard } from "./comms-deck.ts";
import { hit, press } from "./comms-gesture.ts";
import "./comms-canvas.css";

const MODES: { id: CanvasMode; label: string; hint: string }[] = [
  { id: "shelf", label: "Shelf", hint: "Wrap the last lane into as many columns as fit, and bundle its edges" },
  { id: "ladder", label: "Ladder", hint: "One card per row, every edge drawn on its own" },
];

const ORDERS: { id: CanvasOrder; label: string }[] = [
  { id: "duration", label: "Longest first" },
  { id: "outcome", label: "Never came back" },
  { id: "volume", label: "Most said" },
  { id: "name", label: "By name" },
];

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

/** The card is a fixed width, so a name that will not fit has to say so. */
function fit(label: string, max: number): string {
  return label.length <= max ? label : `${label.slice(0, max - 1).trimEnd()}…`;
}

/** Which key means which move across the drawing. */
const STEPS: Record<string, CanvasStep | undefined> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Home: "first",
  End: "last",
};

function NodeCard({
  node,
  dim,
  on,
  cursor,
  bind,
  onHover,
  onOpen,
  onNav,
  onFocus,
}: {
  node: CanvasNode;
  dim: boolean;
  /** Selected, or one end of what is selected. */
  on: boolean;
  /** The one card that holds the tab stop, so Tab crosses the drawing once. */
  cursor: boolean;
  bind: (element: SVGGElement | null) => void;
  onHover: (id: string | null) => void;
  onOpen: () => void;
  onNav: (step: CanvasStep) => void;
  onFocus: () => void;
}) {
  // One tab stop for the whole drawing; the arrows move inside it. Thirty tab
  // presses to cross a canvas is not navigation.
  const gesture = hit(onOpen);
  const ran = ranOn(node);
  const msgs = `${node.sent + node.received} msgs`;
  // What this participant did, if the record says anything beyond how much it
  // spoke: work handed out, or the longest thing it held.
  const did = node.asked > 0 ? `${node.asked} handed out` : node.ms > 0 ? flowDuration(node.ms) : null;
  const meta = did ? `${did} · ${msgs}` : msgs;
  // The card is 178px and the harness sits on the same line, so both facts do
  // not fit beside it. The message count is the one the drawing states
  // elsewhere — on the trunk, in the asks below — so it is the one that goes.
  const onCard = ran ? did ?? msgs : meta;
  const label = node.disputed
    ? `${node.short} — ${meta} — attribution disputed`
    : `${node.short} — ${meta}`;
  return (
    <g
      className={[
        "cvs-node",
        node.asked > 0 ? "cvs-node--hub" : "",
        dim ? "cvs-node--dim" : "",
        on ? "cvs-node--on" : "",
        node.disputed ? "cvs-node--disputed" : "",
      ].filter(Boolean).join(" ")}
      transform={`translate(${node.x} ${node.y})`}
      onMouseEnter={() => onHover(node.id)}
      onMouseLeave={() => onHover(null)}
      aria-label={label}
      aria-current={on ? "true" : undefined}
      ref={bind}
      {...gesture}
      tabIndex={cursor ? 0 : -1}
      onFocus={onFocus}
      onKeyDown={(event: KeyboardEvent) => {
        const step = STEPS[event.key];
        if (!step) {
          gesture.onKeyDown(event);
          return;
        }
        event.preventDefault();
        onNav(step);
      }}
    >
      <title>
        {node.disputed
          ? `${node.short} — ${meta} — every message under this name is classed as an agent's, so the name is the record's, not a person's`
          : label}
      </title>
      <rect className="cvs-box" x={0} y={0} width={node.w} height={node.h} rx={5} />
      {node.abandoned > 0 ? <rect className="cvs-late-mark" x={0} y={0} width={2} height={node.h} /> : null}
      <text className="cvs-name" x={11} y={17}>{fit(node.short, 24)}</text>
      <text className="cvs-meta" x={11} y={31}>{fit(onCard, ran ? 17 : 30)}</text>
      {ran ? (
        <text className="cvs-meta cvs-ran" x={node.w - 11} y={31} textAnchor="end">{fit(ran, 11)}</text>
      ) : null}
      {node.inferred ? <circle className="cvs-inferred" cx={node.w - 10} cy={11} r={2.5} /> : null}
    </g>
  );
}

/**
 * The same window as the Map, laid out as a flow diagram.
 *
 * Where the Map is a ring capped at a dozen with everyone else folded into
 * "N others", the canvas lays the ask chain out left to right — who opened the
 * work, who passed it on, who did it — and hides nobody. See `comms-canvas.ts`
 * for why that is the right drawing for the shape this data has.
 */
export function CommsCanvas({
  passes,
  flights,
  identities,
  rootId,
  focus,
  selectedId,
  onOpen,
}: {
  passes: readonly FlowPass[];
  flights: readonly FlowFlight[];
  identities: ReadonlyMap<string, MapIdentity>;
  /**
   * Whose branch this surface is about. An agent's window is its whole
   * neighbourhood; the branch is the part of it that is this agent's work.
   */
  rootId?: string | null;
  /** Who the selection is about. Null is "nothing selected", not "dim everything". */
  focus?: ReadonlySet<string> | null;
  /** The token of the one thing selected, so its card can say so. */
  selectedId?: string | null;
  /** Select: one thing at a time, shown beside the drawing. */
  onOpen?: (card: DeckCard) => void;
}) {
  const [hover, setHover] = useState<string | null>(null);
  // Where the keyboard is standing. One card holds the tab stop; the arrows
  // move it, and whatever is focused adopts it so a click and a Tab agree.
  const [cursor, setCursor] = useState<string | null>(null);
  const cards = useRef(new Map<string, SVGGElement>());
  const [mode, setMode] = useState<CanvasMode>("shelf");
  const [whole, setWhole] = useState(false);
  const [order, setOrder] = useState<CanvasOrder>("duration");
  const stage = useRef<HTMLDivElement | null>(null);
  const [stageH, setStageH] = useState(0);

  // How tall the stage actually is, because where a lane wraps is a question
  // only the room can answer.
  useEffect(() => {
    const el = stage.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(([entry]) => setStageH(entry?.contentRect.height ?? 0));
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  const window_ = useMemo(() => commsCanvasInputs(passes, flights, identities), [passes, flights, identities]);

  // The surface is about one agent, so the drawing is too: the branch is the
  // ask tree this agent sits in, not everyone its machine happened to talk to.
  // Scoped whether or not it is showing, because how many it sets aside is what
  // decides there is a choice here at all.
  const branch = useMemo(
    () => (rootId ? commsCanvasScope(window_.actors, window_.tasks, window_.pairs, rootId) : null),
    [window_, rootId],
  );
  const setAside = branch?.setAside ?? 0;
  const input = useMemo(
    () => (branch && !whole ? { ...window_, ...branch } : window_),
    [window_, branch, whole],
  );

  // A lane wraps at whatever fills the stage's height, and the canvas grows to
  // the right from there. Reading order for a flow diagram is left to right, so
  // that is the axis it is allowed to spend — a canvas may be bigger than its
  // window, but downward is where a drawing gets lost.
  const layout = useMemo(() => {
    const M = CANVAS_METRICS;
    const rows = stageH > 0
      ? Math.max(2, Math.floor((stageH - M.padY * 2 + M.rowGap) / (M.nodeH + M.rowGap)))
      : undefined;
    return commsCanvasLayout(input.actors, input.tasks, input.pairs, { mode, order, shelfRows: rows });
  }, [input, mode, order, stageH]);

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
  const isSelected = (card: DeckCard) => selectedId === deckToken(card);

  // Moving the cursor has to move the view with it, or an arrow press walks the
  // focus off the edge of a canvas that is wider than its stage.
  const step = (from: string, direction: CanvasStep) => {
    const next = canvasStep(layout.nodes, from, direction);
    if (!next || next === from) return;
    setCursor(next);
    const element = cards.current.get(next);
    element?.focus();
    element?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };

  // The cursor names a card, and a card can leave when the layout or the scope
  // changes. Falling back to the first one keeps a tab stop in the drawing.
  const tabStop = layout.nodes.some((node) => node.id === cursor) ? cursor : layout.nodes[0]?.id ?? null;
  const unnamed = layout.nodes.length - layout.modelsKnown;
  const abandoned = input.tasks.filter((task) => task.abandoned).length;

  return (
    <div className="cvs">
      <div className="cvs-controls">
        <span className="cvs-ctl-label">Layout</span>
        <div className="cvs-seg" role="group" aria-label="Layout">
          {MODES.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`cvs-seg-btn${mode === option.id ? " is-active" : ""}`}
              onClick={() => setMode(option.id)}
              aria-pressed={mode === option.id}
              title={option.hint}
            >
              {option.label}
            </button>
          ))}
        </div>
        {setAside > 0 ? (
          <>
            <span className="cvs-ctl-label">Show</span>
            <div className="cvs-seg" role="group" aria-label="Scope">
              <button
                type="button"
                className={`cvs-seg-btn${whole ? "" : " is-active"}`}
                onClick={() => setWhole(false)}
                aria-pressed={!whole}
                title="Who asked this agent, and everyone it asked, all the way down"
              >
                This branch
              </button>
              <button
                type="button"
                className={`cvs-seg-btn${whole ? " is-active" : ""}`}
                onClick={() => setWhole(true)}
                aria-pressed={whole}
                title="Every participant in this agent's window, whoever they were working for"
              >
                Everything
              </button>
            </div>
          </>
        ) : null}
        <span className="cvs-ctl-label">Down the lane</span>
        <div className="cvs-seg" role="group" aria-label="Order">
          {ORDERS.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`cvs-seg-btn${order === option.id ? " is-active" : ""}`}
              onClick={() => setOrder(option.id)}
              aria-pressed={order === option.id}
            >
              {option.label}
            </button>
          ))}
        </div>
        {onOpen ? (
          <p className="cvs-hint">
            Click to select · arrows to move · Esc to clear
          </p>
        ) : null}
      </div>

      <div className="cvs-stage" ref={stage}>
        <svg
          className="cvs-svg"
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          role="img"
          aria-label="Who asked whom, laid out from who opened the work to who did it"
        >
          {layout.lanes.map((lane) => (
            <g key={lane.index}>
              <text className="cvs-lane-label" x={lane.x} y={20}>{lane.label.toUpperCase()}</text>
              <text className="cvs-lane-count" x={lane.x} y={34}>{lane.count}</text>
            </g>
          ))}

          {layout.edges.map((edge) => (
            <g
              key={edge.key}
              className={`cvs-edge${litEdge(edge.from, edge.to) ? "" : " cvs-edge--dim"}`}
            >
              <path className="cvs-edge-line" d={edge.d} strokeWidth={edge.weight} />
              <path
                className="cvs-edge-tip"
                d="M 0 0 L -7 -3.2 L -7 3.2 Z"
                transform={`translate(${edge.tip.x} ${edge.tip.y}) rotate(${edge.tip.angle})`}
              />
              {edge.abandoned > 0 ? <path className="cvs-edge-late" d={edge.d} strokeWidth={edge.weight} /> : null}
              {onOpen ? (
                // A fat transparent stroke, so a 1px arrow is still a target.
                <path
                  className="cvs-edge-hit"
                  d={edge.d}
                  aria-label={`${edge.count} message${edge.count === 1 ? "" : "s"} — open`}
                  {...hit(() => onOpen({ kind: "pair", from: edge.from, to: edge.to }))}
                >
                  <title>{`${edge.count} message${edge.count === 1 ? "" : "s"} — open`}</title>
                </path>
              ) : null}
            </g>
          ))}

          {/* A trunk stands for many pairs at once, so there is no one card it
              could open. It is drawn, labelled, and deliberately not clickable. */}
          {layout.trunks.map((trunk) => (
            <g key={trunk.key} className={`cvs-trunk${litNode(trunk.from) ? "" : " cvs-edge--dim"}`}>
              <title>
                {`${trunk.tasks} ask${trunk.tasks === 1 ? "" : "s"} · ${trunk.count} message${trunk.count === 1 ? "" : "s"}`}
                {trunk.abandoned > 0 ? ` · ${trunk.abandoned} never came back` : ""}
              </title>
              <path className="cvs-edge-line" d={trunk.d} strokeWidth={2} />
              {trunk.abandoned > 0 ? <path className="cvs-edge-late" d={trunk.d} strokeWidth={2} /> : null}
              <path className="cvs-bracket" d={`M ${trunk.bar.x} ${trunk.bar.y1} L ${trunk.bar.x} ${trunk.bar.y2}`} />
              <text className="cvs-trunk-label" x={trunk.label.x} y={trunk.label.y}>
                {trunk.tasks} ask{trunk.tasks === 1 ? "" : "s"}
              </text>
            </g>
          ))}

          {layout.nodes.map((node) => (
            <NodeCard
              key={node.id}
              node={node}
              dim={!litNode(node.id)}
              on={chosen(node.id)}
              cursor={node.id === tabStop}
              bind={(element) => {
                if (element) cards.current.set(node.id, element);
                else cards.current.delete(node.id);
              }}
              onHover={setHover}
              onOpen={() => onOpen?.({ kind: "actor", actorId: node.id })}
              onNav={(direction) => step(node.id, direction)}
              onFocus={() => setCursor(node.id)}
            />
          ))}
        </svg>
      </div>

      <div className="cf-legend">
        <span><i className="cf-swatch" /> exchange, thicker with volume</span>
        {abandoned > 0 && (
          <span><i className="cf-swatch cf-swatch--late" /> {abandoned} ask{abandoned === 1 ? "" : "s"} never came back</span>
        )}
        {input.broadcasts > 0 && (
          <span className="cf-dim">
            {input.broadcasts} to the whole conversation, which is not a pair
          </span>
        )}
        {!whole && setAside > 0 && (
          <span className="cf-dim">
            {setAside} more in this window, on work this agent is not part of
          </span>
        )}
        {layout.disputedCount > 0 && (
          <span className="cf-dim">
            {input.misattributed} message{input.misattributed === 1 ? "" : "s"} name an operator but are recorded as an
            agent&rsquo;s — drawn with a dashed edge, because the name is the record&rsquo;s and not a person&rsquo;s
          </span>
        )}
        <span className="cf-dim">
          {unnamed === 0
            ? `all ${layout.nodes.length} name a model`
            : `${layout.modelsKnown} of ${layout.nodes.length} name a model; the rest show the harness that ran them`}
        </span>
      </div>
      {input.tasks.length > 0 && (
        <ol className="cvs-tasks">
          {input.tasks.map((task) => {
            const card: DeckCard = { kind: "task", askId: task.id };
            const worker = layout.nodes.find((node) => node.id === task.workerId);
            return (
              <li key={task.id}>
                <button
                  type="button"
                  className={`cvs-task${isSelected(card) ? " cvs-task--on" : ""}`}
                  {...press(() => onOpen?.(card))}
                  aria-current={isSelected(card) ? "true" : undefined}
                  title={task.title}
                  onMouseEnter={() => setHover(task.workerId)}
                  onMouseLeave={() => setHover(null)}
                >
                  <span className="cvs-task-title">{task.title}</span>
                  <span className="cvs-task-who">
                    {layout.nodes.find((node) => node.id === task.waiterId)?.short ?? task.waiterId}
                    <i className="cvs-arrow">→</i>
                    {worker?.short ?? task.workerId}
                    {worker && ranOn(worker) ? <i className="cvs-task-ran">{ranOn(worker)}</i> : null}
                  </span>
                  <span className={`cvs-task-ms${task.abandoned ? " cvs-task-ms--late" : ""}`}>
                    {flowDuration(task.ms)}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}

    </div>
  );
}
