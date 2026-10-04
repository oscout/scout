import { expect, test } from "bun:test";
import { createListeningSessionObserver } from "./broker-chat-listening-binding.js";
import type { ListeningBinding } from "./broker-chat-listening.js";
const binding: ListeningBinding = { mode: "session", facing: "operator", sessionId: "native", herdrSession: "scout", pane: "w1:p1", harness: "claude", terminalId: "terminal-1" };
function topology(panes: unknown[], running = true): any { return { running, session: "scout", workspaces: [{ tabs: [{ panes }] }] }; }
const pane = { paneId: "w1:p1", terminalId: "terminal-1", agentSession: { value: "native", kind: "id", agent: "claude", source: "herdr:claude" } };
test("exact live Herdr identity derives operator-facing, not pane title or cwd", async () => {
  const observe = createListeningSessionObserver({ nodeId: "n", endpoints: () => [], herdr: async () => topology([pane]) });
  expect(await observe(binding)).toEqual({ availability: "available", facing: "operator", terminalId: "terminal-1" });
});
test("successful topology disappearance/replacement confirms unavailable; outages are unknown", async () => {
  let view = topology([]);
  const observe = createListeningSessionObserver({ nodeId: "n", endpoints: () => [], herdr: async () => view });
  expect((await observe(binding)).availability).toBe("unavailable");
  view = topology([{ ...pane, terminalId: "replacement" }]); expect((await observe(binding)).availability).toBe("unavailable");
  view = topology([{ ...pane, agentSession: { ...pane.agentSession, value: "different" } }]); expect((await observe(binding)).availability).toBe("unavailable");
  view = topology([pane, pane]); expect((await observe(binding)).availability).toBe("unknown");
  view = topology([{ ...pane, terminalId: null }]); expect((await observe(binding)).availability).toBe("unknown");
  view = topology([], false); expect((await observe(binding)).availability).toBe("unknown");
  view = topology([{ ...pane, agentSession: null }]); expect((await observe(binding)).availability).toBe("unknown");
});
test("background endpoint uses exact native identity, explicit stopped not heartbeat disappearance", async () => {
  let endpoint: any = { id: "endpoint", nodeId: "n", sessionId: "native", state: "idle", transport: "process", metadata: { placement: "background" } };
  const observe = createListeningSessionObserver({ nodeId: "n", endpoints: () => [endpoint], herdr: async () => { throw Error("not a pane"); } });
  const background: ListeningBinding = { mode: "session", facing: "background", sessionId: "native" };
  expect(await observe(background)).toMatchObject({ availability: "available", facing: "background", endpointId: "endpoint" });
  endpoint.state = "offline"; expect((await observe(background)).availability).toBe("unknown");
  endpoint.state = "stopped"; expect((await observe(background)).availability).toBe("unavailable");
  endpoint.sessionId = "another"; expect((await observe(background)).availability).toBe("unknown");
});

test("broker replacement metadata alone confirms retirement, not a transient offline observation", async () => {
  const endpoint: any = { id: "e", nodeId: "n", sessionId: "native", state: "offline", metadata: { replacedByAgentId: "replacement" } };
  const observe = createListeningSessionObserver({ nodeId: "n", endpoints: () => [endpoint], herdr: async () => { throw Error(); } });
  expect((await observe({ mode: "session", facing: "background", sessionId: "native" })).availability).toBe("unavailable");
});

test("pinned endpoint replacement is terminal while missing identity proof remains unknown", async () => {
  let endpoints: any[] = [{ id: "pinned", nodeId: "n", sessionId: "native", state: "idle", harness: "claude" }];
  const observe = createListeningSessionObserver({ nodeId: "n", endpoints: () => endpoints, herdr: async () => { throw Error(); } });
  const saved: ListeningBinding = { mode: "session", facing: "background", sessionId: "native", endpointId: "pinned", harness: "claude" };
  expect((await observe(saved)).availability).toBe("available");
  endpoints[0].sessionId = "replacement";
  expect((await observe(saved)).availability).toBe("unavailable");
  endpoints[0].state = "stopped";
  expect((await observe(saved)).availability).toBe("unavailable");
  endpoints[0].state = "idle"; delete endpoints[0].sessionId;
  expect((await observe(saved)).availability).toBe("unknown");
  endpoints = [];
  expect((await observe(saved)).availability).toBe("unknown");
});
