import { expect, test } from "bun:test";
import type { AgentLane } from "./agent-lanes-model.ts";
import type { ObserveEvent } from "../../lib/types.ts";
import { floorExchanges } from "./floor-exchanges.ts";
const now = 1_800_000_000_000;
const lane = (id: string, events: ObserveEvent[] = [], name = id) => ({ id, agent: { id, name, harnessSessionId: `session-${id}` }, observe: { events } }) as unknown as AgentLane;
const event = (id: string, to: string, at: number, text = "Hello"): ObserveEvent => ({ id, to, at, text, t: 0, kind: "message" });

test("groups both directions with actual sender identities and oldest-first chronology", () => {
  const result = floorExchanges([lane("b", [event("reply", "a", now - 50)]), lane("a", [event("first", "session-b", now - 90_000)])], now);
  expect(result).toHaveLength(1);
  expect(result[0].from).toBe("a"); expect(result[0].to).toBe("b");
  expect(result[0].messages.map((message) => [message.id, message.from, message.to])).toEqual([["a:first", "a", "b"], ["b:reply", "b", "a"]]);
  expect(result[0].lastAt).toBe(now - 50);
});
test("rejects ambiguous, unknown, self, old and future routes", () => {
  const events = [event("ambiguous", "same", now - 1), event("unknown", "other", now - 1), event("self", "a", now - 1), event("expired", "b", now - 900_000), event("future", "b", now + 1)];
  expect(floorExchanges([lane("a", events, "same"), lane("b", [], "same")], now)).toEqual([]);
});
test("cleans markup and keeps longer body text bounded at 2000 characters", () => {
  const events = [event("markup", "b", now - 2, '**Review** the `layout`. <image name="Image #1" path="/private/tmp/a.png"></image>'), event("long", "b", now - 1, "word ".repeat(600))];
  const messages = floorExchanges([lane("a", events), lane("b")], now)[0].messages;
  expect(messages[0].text).toBe("Review the layout.");
  expect(messages[1].text.length).toBe(2000);
});
test("retains latest 50 per pair, deduplicates IDs, and sorts exchanges by recency", () => {
  const events = Array.from({ length: 60 }, (_, i) => event(String(i), "b", now - 1000 + i));
  const result = floorExchanges([lane("a", [...events, events[59], event("other", "c", now - 1)]), lane("b"), lane("c")], now);
  expect(result.map((exchange) => exchange.to)).toEqual(["c", "b"]);
  expect(result[1].messages).toHaveLength(50);
  expect(result[1].messages[0].id).toBe("a:10");
  expect(result[1].messages[49].id).toBe("a:59");
});
