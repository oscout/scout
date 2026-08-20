import { afterEach, describe, expect, mock, test } from "bun:test";
import { createServer, type Server } from "node:http";

import {
  isLegacyOrphanTerminalRelay,
  isRelayCommandIdentity,
  isTerminalRelayHealthy,
  readTerminalRelayHealth,
  startManagedTerminalRelay,
} from "./managed-terminal-relay.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("isTerminalRelayHealthy", () => {
  test("accepts the terminal relay health payload", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ ok: true, surface: "openscout-terminal-relay", pid: 123, sessions: 2 })
    ) as typeof fetch;

    await expect(isTerminalRelayHealthy("http://127.0.0.1:3201")).resolves.toBe(true);
    await expect(readTerminalRelayHealth("http://127.0.0.1:3201")).resolves.toEqual({
      ok: true,
      surface: "openscout-terminal-relay",
      pid: 123,
      sessions: 2,
    });
  });

  test("rejects a generic 200 response from another service", async () => {
    globalThis.fetch = mock(async () =>
      new Response("<!doctype html><title>Vite</title>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })
    ) as typeof fetch;

    await expect(isTerminalRelayHealthy("http://127.0.0.1:3201")).resolves.toBe(false);
  });

  test("rejects JSON that does not identify the terminal relay", async () => {
    globalThis.fetch = mock(async () => Response.json({ ok: true })) as typeof fetch;

    await expect(isTerminalRelayHealthy("http://127.0.0.1:3201")).resolves.toBe(false);
  });
});

describe("isLegacyOrphanTerminalRelay", () => {
  const health = {
    ok: true as const,
    surface: "openscout-terminal-relay" as const,
    pid: 24241,
    sessions: 0,
    attachedSessions: 0,
  };

  test("matches only an idle reparented relay whose health pid owns the listener", () => {
    expect(isLegacyOrphanTerminalRelay({
      health,
      listenerPid: 24241,
      parentPid: 1,
      command: "scout-relay",
    })).toBe(true);
    expect(isLegacyOrphanTerminalRelay({
      health: { ...health, sessions: 1 },
      listenerPid: 24241,
      parentPid: 1,
      command: "scout-relay",
    })).toBe(false);
    expect(isLegacyOrphanTerminalRelay({
      health: { ok: true, surface: "openscout-terminal-relay", pid: 24241 },
      listenerPid: 24241,
      parentPid: 1,
      command: "scout-relay",
    })).toBe(false);
    expect(isLegacyOrphanTerminalRelay({
      health,
      listenerPid: 99999,
      parentPid: 1,
      command: "scout-relay",
    })).toBe(false);
    expect(isLegacyOrphanTerminalRelay({
      health,
      listenerPid: 24241,
      parentPid: process.pid,
      command: "scout-relay",
    })).toBe(false);
    expect(isLegacyOrphanTerminalRelay({
      health,
      listenerPid: 24241,
      parentPid: 1,
      command: "not-scout-relay-wrapper",
    })).toBe(false);
  });
});

describe("isRelayCommandIdentity", () => {
  test("matches exact relay executable tokens and rejects near matches", () => {
    expect(isRelayCommandIdentity("scout-relay")).toBe(true);
    expect(isRelayCommandIdentity("node /opt/openscout/openscout-terminal-relay.mjs")).toBe(true);
    expect(isRelayCommandIdentity("bun /src/terminal-relay-node.ts")).toBe(true);
    expect(isRelayCommandIdentity("node /src/terminal-relay-node.ts --watch-parent 123")).toBe(true);
    expect(isRelayCommandIdentity("not-scout-relay-wrapper")).toBe(false);
    expect(isRelayCommandIdentity("node /tmp/openscout-terminal-relay.mjs.backup")).toBe(false);
  });
});

function listen(server: Server, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      server.off("error", onError);
      server.off("listening", onListening);
      resolve(ok);
    };
    const onError = () => done(false);
    const onListening = () => done(true);
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function startRelayAdoptionFixture(): Promise<{
  basePort: number;
  genericServer: Server;
  relayServer: Server;
}> {
  for (let basePort = 42100; basePort < 43000; basePort += 10) {
    const genericServer = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    if (!await listen(genericServer, basePort + 1)) {
      continue;
    }

    const relayServer = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        surface: "openscout-terminal-relay",
        pid: process.pid,
        sessions: 0,
      }));
    });
    if (await listen(relayServer, basePort + 2)) {
      return { basePort, genericServer, relayServer };
    }

    await closeServer(genericServer);
  }

  throw new Error("Could not reserve relay adoption test ports");
}

describe("startManagedTerminalRelay", () => {
  test("adopts an existing healthy relay in the automatic port band", async () => {
    const fixture = await startRelayAdoptionFixture();
    try {
      const relay = await startManagedTerminalRelay({
        hostname: "127.0.0.1",
        webPort: fixture.basePort,
      });

      expect(relay.targetHttpUrl).toBe(`http://127.0.0.1:${fixture.basePort + 2}`);
      expect(relay.targetWebSocketUrl).toBe(`ws://127.0.0.1:${fixture.basePort + 2}`);
      await expect(relay.healthcheck()).resolves.toBe(true);
      relay.shutdown();
    } finally {
      await closeServer(fixture.genericServer);
      await closeServer(fixture.relayServer);
    }
  });
});
