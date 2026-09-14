import { describe, expect, test } from "bun:test";
import { buildLaneFacts, nativeSessionAgent, buildAgentLanes } from "./agent-lanes-model.ts";
import type { TailDiscoveredTranscript, TailEvent } from "../../lib/types.ts";
const now = 1_800_000_000_000;
const transcript: TailDiscoveredTranscript = { source: "codex", sessionId: "child", transcriptPath: "/repo/child.jsonl", cwd: "/repo", project: "repo", harness: "unattributed", mtimeMs: now, size: 1000 };
function meta(payload: Record<string, unknown>): TailEvent {
  return { id: "meta", ts: now - 100, sessionId: "child", source: "codex", kind: "system", summary: "session metadata", raw: { type: "session_meta", payload } } as TailEvent;
}
function facts(events: TailEvent[], target = transcript) {
  return buildLaneFacts(target, events, nativeSessionAgent(target, now, true, events), []);
}
describe("Codex lane lineage", () => {
  test("uses explicit own-session parent metadata and observed nickname", () => {
    const events = [meta({ id: "child", parent_thread_id: "parent", agent_nickname: "Kant" })];
    expect(facts(events).parentSessionId).toBe("parent");
    expect(nativeSessionAgent(transcript, now, true, events)).toMatchObject({ role: "subagent", name: "Kant" });
  });
  test("discovery nickname and lineage work before session metadata is loaded", () => {
    const child = { ...transcript, parentSessionId: "parent", subagentId: "child", agentNickname: "Kant" };
    expect(facts([], child).parentSessionId).toBe("parent");
    expect(nativeSessionAgent(child, now, true)).toMatchObject({ role: "subagent", name: "Kant" });
  });
  test("supports legacy nested thread-spawn metadata", () => {
    const events = [meta({ id: "child", source: { sub_agent: { thread_spawn: { parent_thread_id: "parent", agent_nickname: "Ada" } } } })];
    expect(facts(events).parentSessionId).toBe("parent");
    expect(nativeSessionAgent(transcript, now, true, events).name).toBe("Ada");
  });
  test("does not mistake inherited metadata, ordinary forks, or self references for a parent", () => {
    for (const payload of [{ id: "ancestor", parent_thread_id: "other" }, { id: "child", forked_from_id: "parent" }, { id: "child", parent_thread_id: "child" }]) {
      expect(facts([meta(payload)]).parentSessionId).toBeUndefined();
    }
  });
  test("preserves explicit discovery lineage over metadata fallback", () => {
    expect(facts([meta({ id: "child", parent_thread_id: "metadata-parent" })], { ...transcript, parentSessionId: "discovery-parent" }).parentSessionId).toBe("discovery-parent");
  });
  test("actual roster construction keeps an active child and enriches its affiliation", () => {
    const events = [meta({ id: "child", parent_thread_id: "parent", agent_nickname: "Kant" }), { id: "work", ts: now - 10, sessionId: "child", source: "codex", kind: "assistant", summary: "Implementing the map", raw: { type: "event_msg", payload: { type: "agent_message", message: "Implementing the map" } } } as TailEvent];
    const { lanes } = buildAgentLanes({ transcripts: [transcript], tailEvents: events, now, horizon: "5m" });
    expect(lanes).toHaveLength(1);
    expect(lanes[0].facts?.parentSessionId).toBe("parent");
    expect(lanes[0].agent).toMatchObject({ role: "subagent", name: "Kant" });
  });
});
