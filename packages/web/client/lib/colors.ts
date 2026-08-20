import { normalizeAgentState } from "./agent-state.ts";

/* ── Kind labels and color helpers ── */

const KIND_LABELS: Record<string, string> = {
  ask_sent: "sent a request",
  ask_replied: "replied",
  ask_failed: "failed",
  ask_working: "working",
  flight_created: "task started",
  flight_updated: "task updated",
  message_sent: "sent",
  message_received: "received",
  agent_online: "online",
  agent_offline: "offline",
};

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind.replace(/_/g, " ");
}

export function kindColor(kind: string): string {
  if (kind.includes("fail") || kind.includes("offline")) return "var(--red)";
  if (kind.includes("repli") || kind.includes("online")) return "var(--green)";
  if (kind.includes("working") || kind.includes("sent")) return "var(--accent)";
  return "var(--muted)";
}

/** Stable color per name — same name always gets the same hue. */
const PALETTE = [
  "#6366f1", "#8b5cf6", "#0ea5e9", "#14b8a6",
  "#f59e0b", "#ef4444", "#ec4899", "#10b981",
];

export function actorColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

/** State dot color from agent endpoint state. */
export function stateColor(state: string | null): string {
  switch (normalizeAgentState(state)) {
    case "in_turn":
      return "var(--green)";
    case "in_flight":
      return "var(--accent)";
    case "needs_attention":
      return "var(--amber)";
    case "callable":
      return "color-mix(in srgb, var(--accent) 65%, var(--dim))";
    case "blocked":
      return "var(--dim)";
  }
}
