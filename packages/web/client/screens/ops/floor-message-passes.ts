import type { WorldBrokerMessage } from "../../../shared/world-broker-messages.ts";
import { observeEventWallMs } from "../../lib/lane-observe.ts";
import type { ObserveEvent } from "../../lib/types.ts";
import type { AgentLane } from "./agent-lanes-model.ts";

export const FLOOR_PASS_LIFETIME = 12_000;
export type FloorMessagePass = { id: string; from: string; to: string; at: number; label: string; bodyAvailable?: boolean };

function route(event: ObserveEvent): { target: string; label: string } | null {
  if ((event.kind === "message" || event.kind === "ask") && event.to?.trim()) {
    return { target: event.to.trim(), label: event.text };
  }
  // Only communication calls count. A file reference, parent relationship, or
  // arbitrary mention of another actor is never evidence of a message.
  if (event.kind !== "tool" || !/(?:^|[._])(?:send_message|send_input|followup_task|SendMessage)$/.test(event.tool ?? "")) return null;
  for (const raw of [event.arg, event.detail]) {
    if (!raw) continue;
    try {
      const data = JSON.parse(raw);
      if (!data || typeof data !== "object") continue;
      const target = data.target ?? data.recipient ?? data.id ?? data.agent_id;
      const label = data.message ?? data.prompt ?? data.content;
      if (typeof label === "string" && /^gAAAAA[A-Za-z0-9_-]+={0,2}$/.test(label)) return null;
      if (typeof target === "string" && target.trim()) return {
        target: target.trim(), label: typeof label === "string" ? label : "Message sent",
      };
    } catch { /* Truncated or prose arguments cannot establish a route. */ }
  }
  return null;
}

/** Shared exact-route extraction; callers choose horizon and presentation bounds. */
export function floorRoutedMessages(lanes: AgentLane[], now: number, windowMs: number, broker: WorldBrokerMessage[] = []): FloorMessagePass[] {
  const identities = new Map<string, Set<string>>();
  for (const lane of lanes) for (const identity of [lane.id, lane.agent.id, lane.agent.harnessSessionId, lane.agent.name]) {
    if (!identity) continue;
    const matches = identities.get(identity) ?? new Set<string>();
    matches.add(lane.id); identities.set(identity, matches);
  }
  // A received envelope binds its explicit recipient handle to this lane.
  // Duplicate handles across sessions stay ambiguous and fail closed.
  for (const lane of lanes) for (const event of lane.observe?.events ?? []) {
    const recipient = event.communication?.received ? event.communication.to : null;
    if (!recipient) continue;
    const matches = identities.get(recipient) ?? new Set<string>();
    matches.add(lane.id); identities.set(recipient, matches);
  }
  const seen = new Set<string>();
  const observed = lanes.flatMap((lane) => (lane.observe?.events ?? []).flatMap((event) => {
    const at = observeEventWallMs(event, lane.observe?.metadata?.session?.sessionStart);
    if (at === null || at > now || now - at >= windowMs) return [];
    if (event.communication?.received) {
      const senders = identities.get(event.communication.from);
      const recipients = identities.get(event.communication.to);
      if (senders?.size !== 1 || recipients?.size !== 1 || !recipients.has(lane.id)) return [];
      const from = [...senders][0];
      if (from === lane.id || seen.has(event.id)) return [];
      seen.add(event.id);
      return [{ id: event.id, from, to: lane.id, at, label: event.text, bodyAvailable: event.communication.bodyAvailable }];
    }
    const message = route(event);
    if (!message) return [];
    const matches = identities.get(message.target);
    if (matches?.size !== 1) return [];
    const to = [...matches][0];
    if (to === lane.id) return [];
    const id = `${lane.id}:${event.id}`;
    if (seen.has(id)) return [];
    seen.add(id);
    return [{ id, from: lane.id, to, at, label: message.label }];
  }));
  const resolve = (ids: string[]) => {
    const matches = new Set(ids.flatMap(id => [...(identities.get(id) ?? [])]));
    return matches.size === 1 ? [...matches][0] : null;
  };
  const recorded = broker.flatMap(message => {
    const from = resolve(message.from), to = resolve(message.to);
    if (!from || !to || from === to || message.at > now || now - message.at >= windowMs) return [];
    return [{id:message.id,from,to,at:message.at,label:message.body,bodyAvailable:true}];
  });
  return [...observed, ...recorded].sort((a,b)=>b.at-a.at || a.id.localeCompare(b.id));
}

export function floorMessagePasses(lanes: AgentLane[], now: number, broker: WorldBrokerMessage[] = []): FloorMessagePass[] {
  return floorRoutedMessages(lanes, now, FLOOR_PASS_LIFETIME, broker).slice(0, 5).map((message) => ({
    ...message, label: message.label.replace(/\s+/g, " ").trim().slice(0, 180) || "Message sent",
  }));
}
