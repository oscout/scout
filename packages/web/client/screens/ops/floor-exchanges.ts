import type { WorldBrokerMessage } from "../../../shared/world-broker-messages.ts";
import type { AgentLane } from "./agent-lanes-model.ts";
import { floorRoutedMessages } from "./floor-message-passes.ts";
import { floorPreviewText } from "./floor-preview-text.ts";

export type FloorExchangeMessage = { id: string; from: string; to: string; at: number; text: string; bodyAvailable?: boolean };
export type FloorExchange = {
  id: string;
  /** Canonical unordered pair; individual messages retain their actual direction. */
  from: string;
  to: string;
  messages: FloorExchangeMessage[];
  lastAt: number;
};

/** Observed directed communications only, grouped for a persistent recent exchange. */
export function floorExchanges(lanes: AgentLane[], now: number, broker: WorldBrokerMessage[] = []): FloorExchange[] {
  const pairs = new Map<string, FloorExchange>();
  // Input is newest-first, so bounding each pair retains its latest 50 messages.
  for (const message of floorRoutedMessages(lanes, now, 15 * 60_000, broker)) {
    const [from, to] = [message.from, message.to].sort();
    const id = JSON.stringify([from, to]);
    let exchange = pairs.get(id);
    if (!exchange) {
      exchange = { id, from, to, messages: [], lastAt: message.at };
      pairs.set(id, exchange);
    }
    if (exchange.messages.length >= 50) continue;
    exchange.messages.push({
      id: message.id, from: message.from, to: message.to, at: message.at,
      bodyAvailable: message.bodyAvailable,
      text: floorPreviewText(message.label, 2000) || "Message sent",
    });
  }
  return [...pairs.values()].map((exchange) => ({
    ...exchange, messages: exchange.messages.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)),
  })).sort((a, b) => b.lastAt - a.lastAt || a.id.localeCompare(b.id));
}
