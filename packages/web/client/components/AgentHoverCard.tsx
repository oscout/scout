import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { constructAgentIdentity, type AgentIdentity } from "@openscout/protocol";

import { api } from "../lib/api.ts";
import { normalizeAgentState, isAgentCallable, isAgentInTurn } from "../lib/agent-state.ts";
import { useScout } from "../scout/Provider.tsx";
import type { Agent } from "../lib/types.ts";
import { AgentDetailCard } from "./AgentDetailCard.tsx";

const HOVER_INTENT_MS = 280;
const HIDE_GRACE_MS = 120;
const CARD_WIDTH = 320;
const CARD_GUTTER = 8;

/** Cache fetches so re-hover doesn't re-fire the request. */
const agentCache = new Map<string, { agent: Agent | null; fetchedAt: number }>();
const CACHE_TTL_MS = 10_000;

function normalizedIdentityValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim().replace(/^@+/, "").toLowerCase();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function agentIdentityValues(agent: Agent): Set<string> {
  const values = new Set<string>();
  const add = (value: string | null | undefined) => {
    const normalized = normalizedIdentityValue(value);
    if (normalized) values.add(normalized);
  };

  add(agent.id);
  add(agent.handle);
  add(agent.name);
  add(agent.selector);
  add(agent.defaultSelector);
  add(agent.definitionId);

  if (agent.definitionId && agent.workspaceQualifier) {
    add(`${agent.definitionId}.${agent.workspaceQualifier}`);
  }
  if (agent.definitionId && agent.workspaceQualifier && agent.nodeQualifier) {
    add(`${agent.definitionId}.${agent.workspaceQualifier}.${agent.nodeQualifier}`);
    add(`${agent.definitionId}.${agent.workspaceQualifier}.node:${agent.nodeQualifier}`);
  }
  if (agent.definitionId && agent.nodeQualifier) {
    add(`${agent.definitionId}.node:${agent.nodeQualifier}`);
  }

  return values;
}

function agentMatchesIdentity(agent: Agent, identity: AgentIdentity): boolean {
  const label = normalizedIdentityValue(identity.label);
  const raw = normalizedIdentityValue(identity.raw);
  const values = agentIdentityValues(agent);
  if ((label && values.has(label)) || (raw && values.has(raw))) {
    return true;
  }

  if (identity.definitionId && normalizedIdentityValue(agent.definitionId) !== normalizedIdentityValue(identity.definitionId)) {
    return false;
  }
  if (identity.workspaceQualifier && normalizedIdentityValue(agent.workspaceQualifier) !== normalizedIdentityValue(identity.workspaceQualifier)) {
    return false;
  }
  if (identity.nodeQualifier && normalizedIdentityValue(agent.nodeQualifier) !== normalizedIdentityValue(identity.nodeQualifier)) {
    return false;
  }
  if (identity.harness && normalizedIdentityValue(agent.harness) !== normalizedIdentityValue(identity.harness)) {
    return false;
  }
  if (identity.model && normalizedIdentityValue(agent.model) !== normalizedIdentityValue(identity.model)) {
    return false;
  }

  return Boolean(identity.definitionId);
}

function agentIdentityRank(agent: Agent, identity: AgentIdentity): number {
  const label = normalizedIdentityValue(identity.label);
  const raw = normalizedIdentityValue(identity.raw);
  const values = agentIdentityValues(agent);
  const exact = (label && values.has(label)) || (raw && values.has(raw)) ? 1000 : 0;
  const specificity = [
    identity.workspaceQualifier,
    identity.nodeQualifier,
    identity.harness,
    identity.model,
    identity.profile,
  ].filter(Boolean).length * 100;
  const state = normalizeAgentState(agent.state);
  const stateRank = isAgentInTurn(agent.state, agent) ? 30 : isAgentCallable(agent.state, agent) ? 20 : 0;
  return exact + specificity + stateRank + Math.min(agent.updatedAt ?? 0, 9_999_999_999) / 1_000_000_000;
}

function candidateFetchId(identity: AgentIdentity): string | null {
  const raw = normalizedIdentityValue(identity.raw);
  if (raw && raw.split(".").length >= 3) {
    return raw;
  }
  return null;
}

function lookupAgent(identity: AgentIdentity, agents: Agent[]): Agent | null {
  const matches = agents
    .filter((agent) => agentMatchesIdentity(agent, identity))
    .sort((left, right) => agentIdentityRank(right, identity) - agentIdentityRank(left, identity));
  if (matches[0]) {
    return matches[0];
  }
  return null;
}

async function fetchAgent(identity: AgentIdentity, agents: Agent[]): Promise<Agent | null> {
  const seed = lookupAgent(identity, agents);
  const id = seed?.id ?? candidateFetchId(identity);
  const cacheKey = id ?? identity.label;
  const cached = agentCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.agent;
  }
  if (!id) {
    agentCache.set(cacheKey, { agent: seed, fetchedAt: Date.now() });
    return seed;
  }
  try {
    const fresh = await api<Agent>(`/api/agents/${encodeURIComponent(id)}`);
    agentCache.set(cacheKey, { agent: fresh, fetchedAt: Date.now() });
    return fresh;
  } catch {
    agentCache.set(cacheKey, { agent: seed, fetchedAt: Date.now() });
    return seed;
  }
}

/** Position so the card sits above (or below) the trigger and stays in viewport. */
function computePosition(rect: DOMRect): { top: number; left: number; placement: "above" | "below" } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = Math.max(
    CARD_GUTTER,
    Math.min(vw - CARD_WIDTH - CARD_GUTTER, rect.left + rect.width / 2 - CARD_WIDTH / 2),
  );
  // Prefer above; flip below if not enough room.
  const above = rect.top - CARD_GUTTER;
  if (above > 200 || rect.bottom > vh - 200) {
    return { top: above, left, placement: "above" };
  }
  return { top: rect.bottom + CARD_GUTTER, left, placement: "below" };
}

function findThemeRoot(node: Node | null): HTMLElement {
  let cur: Node | null = node;
  while (cur) {
    if (cur instanceof HTMLElement && cur.dataset.scoutTheme) {
      return cur;
    }
    cur = (cur as HTMLElement).parentElement ?? null;
  }
  return document.body;
}

function AgentHoverCardPopover({
  identity,
  agent: agentSeed,
  triggerEl,
  onRequestClose,
}: {
  identity: AgentIdentity;
  agent?: Agent | null;
  triggerEl: HTMLElement;
  onRequestClose: () => void;
}) {
  const { agents, navigate } = useScout();
  const [agent, setAgent] = useState<Agent | null>(() => agentSeed ?? lookupAgent(identity, agents));
  const [loading, setLoading] = useState(!agentSeed);
  const [position, setPosition] = useState(() => computePosition(triggerEl.getBoundingClientRect()));
  const cardRef = useRef<HTMLDivElement>(null);
  const themeRoot = findThemeRoot(triggerEl);

  useEffect(() => {
    if (agentSeed) {
      setAgent(agentSeed);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchAgent(identity, agents).then((next) => {
      if (cancelled) return;
      setAgent(next);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [identity, agents, agentSeed]);

  useEffect(() => {
    const onScrollOrResize = () => {
      setPosition(computePosition(triggerEl.getBoundingClientRect()));
    };
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [triggerEl]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onRequestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onRequestClose]);

  const openAgentPage = useCallback(() => {
    if (!agent) return;
    navigate({ view: "agents-v2", agentId: agent.id });
    onRequestClose();
  }, [agent, navigate, onRequestClose]);

  const transformOrigin = position.placement === "above" ? "bottom center" : "top center";
  const translate = position.placement === "above" ? "translateY(-100%)" : "";
  const cardStyle: CSSProperties = {
    position: "fixed",
    top: position.top,
    left: position.left,
    width: CARD_WIDTH,
    transform: translate,
    transformOrigin,
  };

  if (agent) {
    return createPortal(
      <div
        onMouseEnter={() => { /* keep open */ }}
        onMouseLeave={onRequestClose}
      >
        <AgentDetailCard
          ref={cardRef}
          agent={agent}
          pinned
          onOpen={openAgentPage}
          onClose={onRequestClose}
          onAction={onRequestClose}
          style={cardStyle}
          className="agent-card--mention"
        />
      </div>,
      themeRoot,
    );
  }

  return createPortal(
    <div
      ref={cardRef}
      className="agent-card agent-card--pinned agent-card--mention"
      role="dialog"
      aria-label={`${identity.label} snapshot`}
      style={cardStyle}
      onMouseEnter={() => { /* keep open */ }}
      onMouseLeave={onRequestClose}
    >
      <div style={{ fontSize: "12px", color: "var(--dim)", padding: "4px 2px" }}>
        {loading ? "loading…" : <>No agent registered as <code>{identity.label}</code>.</>}
      </div>
    </div>,
    themeRoot,
  );
}

/** Best-effort AgentIdentity from a known Agent record. */
export function identityFromAgent(agent: Agent): AgentIdentity | null {
  return constructAgentIdentity({
    definitionId: agent.definitionId,
    workspaceQualifier: agent.workspaceQualifier ?? undefined,
    nodeQualifier: agent.nodeQualifier ?? undefined,
    harness: agent.harness ?? undefined,
    model: agent.model ?? undefined,
  });
}

/**
 * Hover/click affordance shared by every agent mention surface: returns
 * trigger props (hover-intent, click-to-pin, keyboard) plus the portal
 * popover element. Spread `triggerProps` on any focusable element; render
 * `popover` alongside it.
 *
 * Pass `agent` when the resolved record is already in hand to skip the
 * lookup; the hook will derive an identity from it. Otherwise pass
 * `identity` directly (e.g. for inline @-mentions parsed from text).
 */
export function useAgentHovercard<T extends HTMLElement = HTMLElement>(input: {
  agent?: Agent | null;
  identity?: AgentIdentity | null;
}): {
  triggerProps: {
    ref: React.RefObject<T | null>;
    onMouseEnter?: () => void;
    onMouseLeave?: () => void;
    onFocus?: () => void;
    onBlur?: () => void;
    onClick?: (event: React.MouseEvent<HTMLElement>) => void;
    onKeyDown?: (event: React.KeyboardEvent<HTMLElement>) => void;
    "data-hover-open"?: "true";
    "aria-haspopup"?: "dialog";
    "aria-expanded"?: boolean;
  };
  popover: React.ReactNode;
  open: boolean;
  pinned: boolean;
} {
  const { agent: agentProp, identity: identityProp } = input;
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const triggerRef = useRef<T | null>(null);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);

  const clearTimers = useCallback(() => {
    if (openTimer.current !== null) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const requestOpen = useCallback(() => {
    if (open) return;
    clearTimers();
    openTimer.current = window.setTimeout(() => setOpen(true), HOVER_INTENT_MS);
  }, [open, clearTimers]);

  const requestClose = useCallback(() => {
    if (pinned) return;
    clearTimers();
    closeTimer.current = window.setTimeout(() => setOpen(false), HIDE_GRACE_MS);
  }, [pinned, clearTimers]);

  const forceClose = useCallback(() => {
    clearTimers();
    setOpen(false);
    setPinned(false);
  }, [clearTimers]);

  useEffect(() => () => clearTimers(), [clearTimers]);

  const identity = useMemo(
    () => identityProp ?? (agentProp ? identityFromAgent(agentProp) : null),
    [identityProp, agentProp],
  );
  const enabled = Boolean(identity);

  const onClick = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (open && pinned) {
        forceClose();
        return;
      }
      clearTimers();
      setPinned(true);
      setOpen(true);
    },
    [open, pinned, forceClose, clearTimers],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setPinned(true);
        setOpen(true);
      }
    },
    [],
  );

  const triggerProps = enabled
    ? {
        ref: triggerRef,
        onMouseEnter: requestOpen,
        onMouseLeave: requestClose,
        onFocus: requestOpen,
        onBlur: requestClose,
        onClick,
        onKeyDown,
        "data-hover-open": open ? ("true" as const) : undefined,
        "aria-haspopup": "dialog" as const,
        "aria-expanded": open,
      }
    : { ref: triggerRef };

  const popover =
    open && triggerRef.current && identity ? (
      <AgentHoverCardPopover
        identity={identity}
        agent={agentProp ?? null}
        triggerEl={triggerRef.current}
        onRequestClose={() => {
          if (pinned) forceClose();
          else requestClose();
        }}
      />
    ) : null;

  return { triggerProps, popover, open, pinned };
}

/** Mention text that opens an agent hovercard on hover, click pins it. */
export function AgentMention({
  identity,
  color,
}: {
  identity: AgentIdentity;
  color: string;
}) {
  const { triggerProps, popover } = useAgentHovercard<HTMLSpanElement>({ identity });
  return (
    <>
      <span
        {...triggerProps}
        className="s-mention"
        role="button"
        tabIndex={0}
        style={{ "--mention-color": color } as CSSProperties}
      >
        {identity.label}
      </span>
      {popover}
    </>
  );
}
