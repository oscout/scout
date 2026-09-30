import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MeshRelayServerTransport,
  meshBridgeTokenFilePath,
  parseBridgeBoundEnvelope,
  readKeychainSecret,
  readMode0600TokenFile,
  resolveBridgeTokenFromConfig,
  resolveBridgeWebSocketUrl,
  type McpWorkerBoundEnvelope,
} from "./mesh-bridge.ts";

function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const previous = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { configurable: true, enumerable: true, value: platform });
  const restore = () => {
    if (previous) Object.defineProperty(process, "platform", previous);
  };
  try {
    const result = run();
    if (result instanceof Promise) return result.finally(restore) as T;
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

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

test("bridge websocket url derives from the relay url and never carries the token", () => {
  expect(resolveBridgeWebSocketUrl("https://mesh.oscout.net/v1/mcp"))
    .toBe("wss://mesh.oscout.net/v1/mcp/bridge");
  expect(resolveBridgeWebSocketUrl("http://localhost:8787/v1/mcp?node=mini"))
    .toBe("ws://localhost:8787/v1/mcp/bridge?node=mini");
  expect(resolveBridgeWebSocketUrl("wss://mesh.oscout.net/v1/mcp/bridge?access_token=leak"))
    .toBe("wss://mesh.oscout.net/v1/mcp/bridge");
});

test("readMode0600TokenFile reads a mode-0600 file and rejects a loose file or symlink", () => {
  const root = mkdtempSync(join(tmpdir(), "openscout-mesh-token-mode-"));
  const tokenPath = join(root, "owned.token");
  writeFileSync(tokenPath, "file-token\n", { mode: 0o600 });
  chmodSync(tokenPath, 0o600);
  const loosePath = join(root, "loose.token");
  writeFileSync(loosePath, "loose-token\n", { mode: 0o644 });
  chmodSync(loosePath, 0o644);
  symlinkSync(tokenPath, join(root, "linked.token"));
  try {
    expect(readMode0600TokenFile(tokenPath)).toBe("file-token");
    expect(readMode0600TokenFile(loosePath)).toBeNull();
    expect(readMode0600TokenFile(join(root, "linked.token"))).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("linux reads a mode-0600 mesh-bridge token file and does not call security", () => {
  const root = mkdtempSync(join(tmpdir(), "openscout-mesh-token-"));
  const tokenPath = meshBridgeTokenFilePath(root);
  writeFileSync(tokenPath, "file-token\n", { mode: 0o600 });
  chmodSync(tokenPath, 0o600);
  const loosePath = join(root, "loose.token");
  writeFileSync(loosePath, "loose-token\n", { mode: 0o644 });
  chmodSync(loosePath, 0o644);
  symlinkSync(tokenPath, join(root, "linked.token"));
  try {
    withPlatform("linux", () => {
      let spawned = false;
      expect(readKeychainSecret("OPENSCOUT_MCP_BRIDGE_TOKEN", () => {
        spawned = true;
        throw new Error("security spawned");
      })).toBeNull();
      expect(spawned).toBe(false);
      expect(resolveBridgeTokenFromConfig(
        { relayUrl: "https://mcp.oscout.net", tokenKeychainService: "OPENSCOUT_MCP_BRIDGE_TOKEN" },
        { supportDirectory: root },
      )).toBe("file-token");
      expect(resolveBridgeTokenFromConfig(
        { relayUrl: "https://mcp.oscout.net", tokenFile: loosePath },
      )).toBeNull();
      expect(readMode0600TokenFile(join(root, "linked.token"))).toBeNull();
      expect(resolveBridgeTokenFromConfig({
        relayUrl: "https://mcp.oscout.net",
        token: " inline ",
        tokenFile: tokenPath,
      })).toBe("inline");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("darwin keychain lookup keeps the security command and ignores the token file", () => {
  const root = mkdtempSync(join(tmpdir(), "openscout-mesh-token-darwin-"));
  const tokenPath = meshBridgeTokenFilePath(root);
  writeFileSync(tokenPath, "file-token\n", { mode: 0o600 });
  chmodSync(tokenPath, 0o600);
  try {
    withPlatform("darwin", () => {
      const commands: string[][] = [];
      expect(readKeychainSecret("OPENSCOUT_MCP_BRIDGE_TOKEN", (command) => {
        commands.push(command);
        return { exitCode: 0, stdout: Buffer.from("keychain-token\n") };
      })).toBe("keychain-token");
      expect(commands).toEqual([[
        "security",
        "find-generic-password",
        "-s",
        "OPENSCOUT_MCP_BRIDGE_TOKEN",
        "-w",
      ]]);
      expect(resolveBridgeTokenFromConfig({
        relayUrl: "https://mcp.oscout.net",
        token: " inline ",
        tokenKeychainService: "OPENSCOUT_MCP_BRIDGE_TOKEN",
        tokenFile: tokenPath,
      })).toBe("inline");
      expect(resolveBridgeTokenFromConfig({
        relayUrl: "https://mcp.oscout.net",
        tokenFile: tokenPath,
      }, { supportDirectory: root })).toBeNull();
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
