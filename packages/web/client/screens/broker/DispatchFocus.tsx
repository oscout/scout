import { ChevronDown, Crosshair, Plus, Search, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { DispatchWindow } from "../../lib/types.ts";
import {
  DISPATCH_WINDOWS,
  type DispatchGraph,
  type DispatchGraphNode,
  type DispatchNode,
} from "./dispatch-focus.ts";

const KIND_LABELS: Record<DispatchNode["kind"], string> = {
  operator: "Operator",
  agent: "Agent",
  session: "Session",
  channel: "Channel",
  unresolved: "Unresolved address",
};

export function dispatchNodeKindLabel(node: DispatchNode): string {
  return KIND_LABELS[node.kind];
}

/**
 * Searchable multi-node focus picker. Picking a node focuses it; the chip's ×
 * removes it. Both change this view only.
 */
function DispatchNodePicker({
  catalog,
  focused,
  onAdd,
}: {
  catalog: DispatchNode[];
  focused: readonly string[];
  onAdd: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const options = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return catalog
      .filter((node) => !focused.includes(node.key))
      .filter((node) => !needle
        || node.label.toLowerCase().includes(needle)
        || node.address?.toLowerCase().includes(needle)
        || node.machine?.toLowerCase().includes(needle))
      .slice(0, 40);
  }, [catalog, focused, query]);

  useEffect(() => {
    if (!open) return;
    setActive(0);
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    return () => window.removeEventListener("pointerdown", onPointer);
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  const choose = (node: DispatchNode | undefined) => {
    if (!node) return;
    onAdd(node.key);
    setQuery("");
    setOpen(false);
  };

  return (
    <div className="dsp-picker" ref={rootRef}>
      <button
        type="button"
        className="dsp-btn dsp-btn--quiet"
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => {
          setOpen((value) => !value);
          window.requestAnimationFrame(() => inputRef.current?.focus());
        }}
      >
        <Plus size={12} aria-hidden="true" />
        Add node
      </button>
      {open && (
        <div className="dsp-picker-pop" role="dialog" aria-label="Focus on a node">
          <div className="dsp-picker-search">
            <Search size={12} aria-hidden="true" />
            <input
              ref={inputRef}
              value={query}
              placeholder="Find an agent, session or person…"
              aria-label="Find a node"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={options[active] ? `${listId}-${active}` : undefined}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setActive((index) => Math.min(options.length - 1, index + 1));
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setActive((index) => Math.max(0, index - 1));
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  choose(options[active]);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setOpen(false);
                }
              }}
            />
          </div>
          <ul className="dsp-picker-list" role="listbox" id={listId} aria-label="Nodes">
            {options.length === 0 ? (
              <li className="dsp-picker-empty">No matching nodes</li>
            ) : options.map((node, index) => (
              <li
                key={node.key}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === active}
                className={`dsp-picker-option${index === active ? " dsp-picker-option--active" : ""}`}
                onPointerEnter={() => setActive(index)}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => choose(node)}
              >
                <span className="dsp-picker-name">{node.label}</span>
                <span className="dsp-picker-kind">
                  {dispatchNodeKindLabel(node)}
                  {node.machine ? ` · ${node.machine}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function DispatchFocusBar({
  catalog,
  focused,
  between,
  window: timeWindow,
  query,
  graphHidden,
  canReset,
  onAddNode,
  onRemoveNode,
  onBetween,
  onWindow,
  onQuery,
  onToggleGraph,
  onReset,
}: {
  catalog: ReadonlyMap<string, DispatchNode>;
  focused: readonly string[];
  between: boolean;
  window: DispatchWindow;
  query: string;
  graphHidden: boolean;
  canReset: boolean;
  onAddNode: (key: string) => void;
  onRemoveNode: (key: string) => void;
  onBetween: (between: boolean) => void;
  onWindow: (window: DispatchWindow) => void;
  onQuery: (query: string) => void;
  onToggleGraph: () => void;
  onReset: () => void;
}) {
  const nodes = useMemo(
    () => [...catalog.values()].sort((left, right) => left.label.localeCompare(right.label)),
    [catalog],
  );
  return (
    <div className="dsp-focus" aria-label="Dispatch focus and filters">
      <div className="dsp-focus-row">
        <span className="dsp-focus-label" id="dsp-focus-label">Focus</span>
        <div className="dsp-chips" aria-labelledby="dsp-focus-label">
          {focused.length === 0 && <span className="dsp-focus-none">Everyone</span>}
          {focused.map((key) => {
            const node = catalog.get(key);
            const label = node?.label ?? key;
            return (
              <span key={key} className="dsp-chip">
                <span title={node?.address ?? label}>{label}</span>
                <button
                  type="button"
                  aria-label={`Remove ${label} from focus`}
                  title="Remove from focus (view only)"
                  onClick={() => onRemoveNode(key)}
                >
                  <X size={11} aria-hidden="true" />
                </button>
              </span>
            );
          })}
          <DispatchNodePicker catalog={nodes} focused={focused} onAdd={onAddNode} />
        </div>
        {focused.length >= 2 && (
          <div className="dsp-segment" role="radiogroup" aria-label="Which dispatches to show">
            <button type="button" role="radio" aria-checked={!between} className={!between ? "is-on" : ""} onClick={() => onBetween(false)}>
              Involving any
            </button>
            <button type="button" role="radio" aria-checked={between} className={between ? "is-on" : ""} onClick={() => onBetween(true)}>
              Between them
            </button>
          </div>
        )}
        {canReset && (
          <button type="button" className="dsp-btn dsp-btn--quiet dsp-reset" onClick={onReset}>
            Reset
          </button>
        )}
      </div>
      <div className="dsp-filter-row">
        <label className="dsp-search">
          <Search size={13} aria-hidden="true" />
          <input
            value={query}
            placeholder="Find a request, agent or id…"
            aria-label="Search dispatches"
            onChange={(event) => onQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.preventDefault();
                event.stopPropagation();
                onQuery("");
              }
            }}
          />
        </label>
        <label className="dsp-select">
          <span className="dsp-visually-hidden">Time range</span>
          <select value={timeWindow} onChange={(event) => onWindow(event.target.value as DispatchWindow)}>
            {DISPATCH_WINDOWS.map((entry) => (
              <option key={entry.value} value={entry.value}>{entry.label}</option>
            ))}
          </select>
          <ChevronDown size={12} aria-hidden="true" />
        </label>
        <button type="button" className="dsp-btn" aria-expanded={!graphHidden} aria-controls="dsp-graph" onClick={onToggleGraph}>
          {graphHidden ? "Show graph" : "Hide graph"}
        </button>
      </div>
    </div>
  );
}

// ── Graph ───────────────────────────────────────────────────────────────────

const SLOT = 40;

function slotY(index: number, count: number, height: number): number {
  const top = (height - count * SLOT) / 2;
  return top + index * SLOT + SLOT / 2;
}

function GraphNodeButton({
  entry,
  side,
  inspected,
  onInspect,
}: {
  entry: DispatchGraphNode;
  side: "from" | "to";
  inspected: boolean;
  onInspect: (key: string) => void;
}) {
  const { node } = entry;
  return (
    <button
      type="button"
      className={[
        "dsp-node",
        `dsp-node--${side}`,
        entry.focused ? "dsp-node--focused" : "dsp-node--context",
        inspected ? "dsp-node--inspected" : "",
      ].filter(Boolean).join(" ")}
      aria-pressed={inspected}
      title={`${node.label} · ${dispatchNodeKindLabel(node)}${node.machine ? ` on ${node.machine}` : ""}`}
      onClick={() => onInspect(node.key)}
    >
      <span className={`dsp-node-mark dsp-node-mark--${node.kind}`} aria-hidden="true" />
      <span className="dsp-node-name">{node.label}</span>
      <span className="dsp-node-count" aria-label={`${entry.count} ${side === "from" ? "sent" : "received"}`}>
        {entry.count}
        {entry.attention > 0 && <span className="dsp-node-attn" aria-label={`${entry.attention} need attention`}>!</span>}
      </span>
    </button>
  );
}

/**
 * Senders on the left, destinations on the right, one curve per route. The
 * nodes are HTML so text never scales; only the curves live in the SVG, which
 * stretches to whatever width the column has.
 */
export function DispatchRouteGraph({
  graph,
  inspectedKey,
  onInspect,
  title,
  meta,
}: {
  graph: DispatchGraph;
  inspectedKey: string | null;
  onInspect: (key: string) => void;
  title: string;
  meta: string;
}) {
  const rows = Math.max(graph.senders.length, graph.destinations.length, 1);
  const height = Math.max(rows * SLOT + 16, 92);
  const senderIndex = new Map(graph.senders.map((entry, index) => [entry.node.key, index]));
  const destinationIndex = new Map(graph.destinations.map((entry, index) => [entry.node.key, index]));
  const maxCount = Math.max(1, ...graph.edges.map((edge) => edge.count));

  return (
    <section className="dsp-graph" id="dsp-graph" aria-label="Dispatch routes">
      <header className="dsp-graph-head">
        <span>{title}</span>
        <span>{meta}</span>
      </header>
      {graph.edges.length === 0 ? (
        <div className="dsp-graph-empty">No routes match this focus.</div>
      ) : (
        <div className="dsp-graph-canvas" style={{ height }}>
          <div className="dsp-graph-col dsp-graph-col--from">
            {graph.senders.map((entry, index) => (
              <div key={entry.node.key} className="dsp-graph-slot" style={{ top: slotY(index, graph.senders.length, height) }}>
                <GraphNodeButton entry={entry} side="from" inspected={inspectedKey === entry.node.key} onInspect={onInspect} />
              </div>
            ))}
          </div>
          <svg className="dsp-graph-edges" viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" style={{ height }} aria-hidden="true">
            {graph.edges.map((edge) => {
              const from = senderIndex.get(edge.from);
              const to = destinationIndex.get(edge.to);
              if (from === undefined || to === undefined) return null;
              const y1 = slotY(from, graph.senders.length, height);
              const y2 = slotY(to, graph.destinations.length, height);
              const involved = inspectedKey === edge.from || inspectedKey === edge.to;
              return (
                <path
                  key={`${edge.from}->${edge.to}`}
                  className={[
                    "dsp-edge",
                    edge.attention > 0 ? "dsp-edge--attention" : "",
                    involved ? "dsp-edge--inspected" : "",
                    inspectedKey && !involved ? "dsp-edge--dim" : "",
                  ].filter(Boolean).join(" ")}
                  d={`M0 ${y1} C 50 ${y1}, 50 ${y2}, 100 ${y2}`}
                  style={{ strokeWidth: 1 + (edge.count / maxCount) * 0.8 }}
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}
          </svg>
          <div className="dsp-graph-col dsp-graph-col--to">
            {graph.destinations.map((entry, index) => (
              <div key={entry.node.key} className="dsp-graph-slot" style={{ top: slotY(index, graph.destinations.length, height) }}>
                <GraphNodeButton entry={entry} side="to" inspected={inspectedKey === entry.node.key} onInspect={onInspect} />
              </div>
            ))}
          </div>
        </div>
      )}
      {(graph.quiet.length > 0 || graph.hiddenRoutes > 0) && (
        <footer className="dsp-graph-foot">
          {graph.quiet.map((node) => (
            <button key={node.key} type="button" className="dsp-quiet" onClick={() => onInspect(node.key)}>
              <span className={`dsp-node-mark dsp-node-mark--${node.kind}`} aria-hidden="true" />
              {node.label}
              <span>no matching dispatches</span>
            </button>
          ))}
          {graph.hiddenRoutes > 0 && (
            <span className="dsp-graph-more">
              +{graph.hiddenRoutes} more {graph.hiddenRoutes === 1 ? "route" : "routes"} · focus a node to see them
            </span>
          )}
        </footer>
      )}
    </section>
  );
}

/**
 * Clicking a node inspects it; focusing is a separate, explicit action so a
 * stray click never rewrites the view.
 */
export function DispatchNodeCard({
  node,
  sent,
  received,
  focused,
  onFocus,
  onUnfocus,
  onClose,
  copyButton,
}: {
  node: DispatchNode;
  sent: number;
  received: number;
  focused: boolean;
  onFocus: () => void;
  onUnfocus: () => void;
  onClose: () => void;
  copyButton: (value: string, subject: string) => ReactNode;
}) {
  return (
    <div className="dsp-node-card" role="group" aria-label={`${node.label} details`}>
      <div className="dsp-node-card-main">
        <span className={`dsp-node-mark dsp-node-mark--${node.kind}`} aria-hidden="true" />
        <div className="dsp-node-card-copy">
          <strong>{node.label}</strong>
          <span>
            {dispatchNodeKindLabel(node)}
            {node.machine ? ` · on ${node.machine}` : ""}
            {` · ${sent} sent · ${received} received in view`}
          </span>
          {node.address && node.address !== node.label && (
            <span className="dsp-node-card-address">
              <code title={node.address}>{node.address}</code>
              {copyButton(node.address, "address")}
            </span>
          )}
        </div>
      </div>
      <div className="dsp-node-card-actions">
        {focused ? (
          <button type="button" className="dsp-btn" onClick={onUnfocus}>Remove focus</button>
        ) : (
          <button type="button" className="dsp-btn dsp-btn--accent" onClick={onFocus}>
            <Crosshair size={12} aria-hidden="true" />
            Focus
          </button>
        )}
        <button type="button" className="dsp-icon-btn" aria-label="Close node details" onClick={onClose}>
          <X size={13} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
