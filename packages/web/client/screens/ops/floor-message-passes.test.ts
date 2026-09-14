import { expect, test } from "bun:test";
import { floorMessagePasses } from "./floor-message-passes.ts";
import type { AgentLane } from "./agent-lanes-model.ts";
import type { ObserveEvent } from "../../lib/types.ts";
const now = 1_800_000_000_000;
const lane = (id: string, events: ObserveEvent[] = [], name = id) => ({ id, agent: { id, name, harnessSessionId: `session-${id}` }, observe: { events } }) as unknown as AgentLane;
const event = (extra: Partial<ObserveEvent> = {}): ObserveEvent => ({ id: "e1", t: 0, at: now - 500, kind: "message", text: "Please review", to: "session-b", ...extra });
test("resolves explicit session recipient and collapses duplicate events", () => {
  expect(floorMessagePasses([lane("a", [event(), event()]), lane("b")], now)).toEqual([{ id: "a:e1", from: "a", to: "b", at: now - 500, label: "Please review" }]);
});
test("rejects ambiguous, unknown, self, old and future routes", () => {
  for (const e of [event({ to: "unknown" }), event({ to: "a" }), event({ at: now - 12_000 }), event({ at: now + 1 }), event({ to: "same" })]) {
    expect(floorMessagePasses([lane("a", [e], "same"), lane("b", [], "same")], now)).toEqual([]);
  }
});
test("recognizes structured collaboration sends but never infers links from prose or other tools", () => {
  const send = event({ kind: "tool", to: undefined, tool: "collaboration.send_message", arg: JSON.stringify({ target: "b", message: "Review ready" }) });
  expect(floorMessagePasses([lane("a", [send]), lane("b")], now)[0]?.label).toBe("Review ready");
  for (const e of [{ ...send, tool: "read_file" }, { ...send, arg: "tell b about changes" }]) expect(floorMessagePasses([lane("a", [e]), lane("b")], now)).toEqual([]);
});
test('broker routes resolve canonical session aliases, never operator or ambiguous identities', () => {
 const m={id:'broker:m:b',from:['registered-a','session-a'],to:['registered-b','session-b'],at:now-10,body:'review ready'};
 expect(floorMessagePasses([lane('a'),lane('b')],now,[m])[0]?.from).toBe('a');
 expect(floorMessagePasses([lane('a'),lane('b')],now,[{...m,from:['operator']}])).toEqual([]);
 expect(floorMessagePasses([lane('a'),lane('b')],now,[{...m,from:['a','b']}])).toEqual([]);
});
