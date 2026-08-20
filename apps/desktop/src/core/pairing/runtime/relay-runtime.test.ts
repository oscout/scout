import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveRelayEndpointForTailscaleStatus } from "./relay-runtime";

describe("resolveRelayEndpointForTailscaleStatus", () => {
  const tls = { cert: "/tmp/scout-test.crt", key: "/tmp/scout-test.key" };

  test("uses the tailscale hostname when trusted TLS is available", () => {
    const endpoint = resolveRelayEndpointForTailscaleStatus(43131, {
      backendState: "Running",
      dnsName: "relay.example.ts.net",
      online: true,
      health: [],
    }, {
      localAddress: "192.168.1.25",
      tls,
    });

    expect(endpoint.relayUrl).toBe("wss://relay.example.ts.net:43131");
    expect(endpoint.connectUrl).toBe("wss://127.0.0.1:43131");
    expect(endpoint.fallbackRelayUrls).toEqual([]);
    expect(endpoint.options).toEqual({ tls });
  });

  test("uses tailscale hostname when no local address is available", () => {
    const endpoint = resolveRelayEndpointForTailscaleStatus(43131, {
      backendState: "Running",
      dnsName: "relay.example.ts.net",
      online: true,
      health: [],
    }, {
      localAddress: null,
      tls,
    });

    expect(endpoint.relayUrl).toBe("wss://relay.example.ts.net:43131");
    expect(endpoint.connectUrl).toBe("wss://127.0.0.1:43131");
    expect(endpoint.fallbackRelayUrls).toEqual([]);
  });

  test("uses insecure websocket tailnet fallback when tailscale TLS is unavailable", () => {
    const endpoint = resolveRelayEndpointForTailscaleStatus(43131, {
      backendState: "Running",
      dnsName: "relay.example.ts.net",
      online: true,
      health: [],
    }, {
      localAddress: "192.168.1.25",
      tls: null,
    });

    expect(endpoint.relayUrl).toBe("ws://192.168.1.25:43131");
    expect(endpoint.connectUrl).toBe("ws://127.0.0.1:43131");
    expect(endpoint.fallbackRelayUrls).toEqual(["ws://relay.example.ts.net:43131"]);
    expect(endpoint.options).toEqual({});
  });

  test("uses local network address when tailscale is stopped", () => {
    const endpoint = resolveRelayEndpointForTailscaleStatus(43131, {
      backendState: "Stopped",
      dnsName: "relay.example.ts.net",
      online: false,
      health: ["Tailscale is stopped."],
    }, {
      localAddress: "10.0.0.42",
    });

    expect(endpoint.relayUrl).toBe("ws://10.0.0.42:43131");
    expect(endpoint.connectUrl).toBe("ws://127.0.0.1:43131");
    expect(endpoint.fallbackRelayUrls).toEqual([]);
  });

  test("falls back to loopback when no reachable network address is available", () => {
    const endpoint = resolveRelayEndpointForTailscaleStatus(43131, null, {
      localAddress: null,
    });

    expect(endpoint.relayUrl).toBe("ws://127.0.0.1:43131");
    expect(endpoint.connectUrl).toBe("ws://127.0.0.1:43131");
    expect(endpoint.fallbackRelayUrls).toEqual([]);
  });

  test("captures noisy tailscale status stderr", () => {
    const directory = mkdtempSync(join(tmpdir(), "openscout-tailscale-stderr-"));
    const tailscale = join(directory, "tailscale");
    writeFileSync(tailscale, `#!/bin/sh
if [ "$1" = "status" ]; then
  echo 'Warning: client version "1.96.4-t41cb72f27" != tailscaled server version "1.94.1-t62c6f1cd7-g09fea6572"' >&2
  cat <<'JSON'
{"BackendState":"Stopped","Health":[],"Self":{"Online":false},"Peer":{}}
JSON
  exit 0
fi
exit 1
`);
    chmodSync(tailscale, 0o755);

    try {
      const moduleUrl = pathToFileURL(
        resolve(dirname(fileURLToPath(import.meta.url)), "relay-runtime.ts"),
      ).href;
      const result = spawnSync(
        "bun",
        ["--silent", "-e", `const mod = await import(${JSON.stringify(moduleUrl)}); await mod.suggestedRelayUrl(43131);`],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH ?? ""}`,
          },
        },
      );

      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain("client version");
      expect(result.stderr).not.toContain("tailscaled server version");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
