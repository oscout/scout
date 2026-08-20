import { expect, test } from "bun:test";

import {
  MeshRelayServerTransport,
  parseBridgeBoundEnvelope,
  resolveBridgeWebSocketUrl,
  type McpWorkerBoundEnvelope,
} from "./mesh-bridge.ts";

function collectingTransport(): { transport: MeshRelayServerTransport; emitted: McpWorkerBoundEnvelope[] } {
  const transport = new MeshRelayServerTransport();
  const emitted: McpWorkerBoundEnvelope[] = [];
  transport.bindEmitter((envelope) => emitted.push(envelope));
  return { transport, emitted };
}

test("bridge envelope parser rejects foreign frames", () => {
  expect(parseBridgeBoundEnvelope("not json")).toBeNull();
  expect(parseBridgeBoundEnvelope(JSON.stringify({ v: 2, kind: "mcp_request", id: "a" }))).toBeNull();
  expect(parseBridgeBoundEnvelope(JSON.stringify({ v: 1, kind: "mcp_response", id: "a" }))).toBeNull();
  expect(parseBridgeBoundEnvelope(JSON.stringify({ v: 1, kind: "mcp_request", id: "a", payload: "{}" })))
    .toEqual({ v: 1, kind: "mcp_request", id: "a", payload: "{}" });
});

test("requests are correlated back to their relay envelope id", async () => {
  const { transport, emitted } = collectingTransport();
  const seen: unknown[] = [];
  transport.onmessage = (message) => seen.push(message);

  transport.deliver({
    v: 1,
    kind: "mcp_request",
    id: "env-1",
    payload: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "whoami" } }),
  });
  expect(seen).toHaveLength(1);
  expect(emitted).toHaveLength(0);

  await transport.send({ jsonrpc: "2.0", id: 7, result: { ok: true } });
  expect(emitted).toEqual([
    {
      v: 1,
      kind: "mcp_response",
      id: "env-1",
      payload: JSON.stringify({ jsonrpc: "2.0", id: 7, result: { ok: true } }),
    },
  ]);
});

test("notifications are accepted immediately", () => {
  const { transport, emitted } = collectingTransport();
  transport.onmessage = () => {};

  transport.deliver({
    v: 1,
    kind: "mcp_request",
    id: "env-2",
    payload: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  expect(emitted).toEqual([{ v: 1, kind: "mcp_accepted", id: "env-2" }]);
});

test("invalid payloads produce mcp_error envelopes", () => {
  const { transport, emitted } = collectingTransport();
  transport.deliver({ v: 1, kind: "mcp_request", id: "env-3", payload: "{broken" });
  expect(emitted).toEqual([
    { v: 1, kind: "mcp_error", id: "env-3", status: 400, message: "invalid JSON-RPC payload" },
  ]);
});

test("cancel drops the correlation so a late response is not emitted", async () => {
  const { transport, emitted } = collectingTransport();
  transport.onmessage = () => {};

  transport.deliver({
    v: 1,
    kind: "mcp_request",
    id: "env-4",
    payload: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "whoami" } }),
  });
  transport.deliver({ v: 1, kind: "mcp_cancel", id: "env-4" });

  await transport.send({ jsonrpc: "2.0", id: 9, result: {} });
  expect(emitted).toEqual([]);
});

test("server-initiated notifications are forwarded as mcp_notify envelopes", async () => {
  const { transport, emitted } = collectingTransport();
  await transport.send({ jsonrpc: "2.0", method: "notifications/scout/reply", params: { status: "completed" } });
  expect(emitted).toHaveLength(1);
  expect(emitted[0]?.kind).toBe("mcp_notify");
  expect(JSON.parse(emitted[0]?.payload ?? "{}")).toEqual({
    jsonrpc: "2.0",
    method: "notifications/scout/reply",
    params: { status: "completed" },
  });
});

test("bridge websocket url derives from the relay url and carries the token", () => {
  expect(resolveBridgeWebSocketUrl("https://mesh.oscout.net/v1/mcp", "tok"))
    .toBe("wss://mesh.oscout.net/v1/mcp/bridge?access_token=tok");
  expect(resolveBridgeWebSocketUrl("http://localhost:8787/v1/mcp?node=mini", "tok"))
    .toBe("ws://localhost:8787/v1/mcp/bridge?node=mini&access_token=tok");
  expect(resolveBridgeWebSocketUrl("wss://mesh.oscout.net/v1/mcp/bridge", "tok"))
    .toBe("wss://mesh.oscout.net/v1/mcp/bridge?access_token=tok");
});
