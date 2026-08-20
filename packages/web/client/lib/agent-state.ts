import type { Agent } from "./types.ts";

/** User-facing agent posture: callable by default; busy states only when work is moving. */
export type AgentDisplayState = "callable" | "in_flight" | "in_turn" | "needs_attention" | "blocked";

/** CSS / sprite tone bucket — keeps existing available/offline/working styling hooks. */
export type AgentVisualState = "offline" | "available" | "working";

type AgentStateInput = Partial<Pick<Agent, "retiredFromFleet" | "staleLocalRegistration">> | null | undefined;

const BLOCKED_STATE_VALUES = new Set([
  "blocked",
  "unavailable",
  "error",
  "missing",
  "not_ready",
  "unready",
  "retired",
]);

const IN_TURN_STATE_VALUES = new Set(["working", "active", "running", "in_turn"]);
const IN_FLIGHT_STATE_VALUES = new Set(["in_flight", "queued", "waking", "dispatching"]);
const NEEDS_ATTENTION_STATE_VALUES = new Set(["needs_attention", "needs-attention"]);

export function isAgentBlocked(agent: AgentStateInput): boolean {
  return Boolean(agent?.retiredFromFleet || agent?.staleLocalRegistration);
}

export function normalizeAgentState(
  state: string | null,
  agent?: AgentStateInput,
): AgentDisplayState {
  if (isAgentBlocked(agent)) {
    return "blocked";
  }

  const value = state?.trim().toLowerCase();
  if (!value) {
    return "callable";
  }
  if (IN_TURN_STATE_VALUES.has(value)) {
    return "in_turn";
  }
  if (IN_FLIGHT_STATE_VALUES.has(value)) {
    return "in_flight";
  }
  if (NEEDS_ATTENTION_STATE_VALUES.has(value)) {
    return "needs_attention";
  }
  if (BLOCKED_STATE_VALUES.has(value)) {
    return "blocked";
  }

  // offline, waiting, idle, available, dormant, ready, discovered — all callable.
  return "callable";
}

export function agentStateCssToken(state: string | null, agent?: AgentStateInput): AgentVisualState {
  switch (normalizeAgentState(state, agent)) {
    case "in_turn":
    case "in_flight":
      return "working";
    case "needs_attention":
      return "working";
    case "callable":
      return "available";
    case "blocked":
      return "offline";
  }
}

export function isAgentInTurn(state: string | null, agent?: AgentStateInput): boolean {
  return normalizeAgentState(state, agent) === "in_turn";
}

export function isAgentInFlight(state: string | null, agent?: AgentStateInput): boolean {
  return normalizeAgentState(state, agent) === "in_flight";
}

export function isAgentBusy(state: string | null, agent?: AgentStateInput): boolean {
  const normalized = normalizeAgentState(state, agent);
  return normalized === "in_turn" || normalized === "in_flight";
}

export function isAgentCallable(state: string | null, agent?: AgentStateInput): boolean {
  return normalizeAgentState(state, agent) === "callable";
}

export function isAgentOnline(state: string | null, agent?: AgentStateInput): boolean {
  return normalizeAgentState(state, agent) !== "blocked";
}

export function agentStateLabel(state: string | null, agent?: AgentStateInput): string {
  switch (normalizeAgentState(state, agent)) {
    case "in_turn":
      return "In turn";
    case "in_flight":
      return "In flight";
    case "needs_attention":
      return "Needs attention";
    case "callable":
      return "Callable";
    case "blocked":
      return "Blocked";
  }
}

/** Sort rank for fleet lists — busy agents bubble up; blocked sink. */
export function agentStateRank(state: string | null, agent?: AgentStateInput): number {
  switch (normalizeAgentState(state, agent)) {
    case "needs_attention":
      return 0;
    case "in_turn":
      return 1;
    case "in_flight":
      return 2;
    case "callable":
      return 3;
    case "blocked":
      return 4;
  }
}

/** @deprecated Prefer AgentDisplayState — legacy alias for incremental migration. */
export type AgentInventoryStatus = AgentDisplayState;
