import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  readTailscalePeers,
  readTailscaleSelf,
  readTailscaleSelfWebHostsSync,
  readTailscaleStatusSummary,
  tailscaleStatusProbe,
} from "./tailscale";
import { resetScoutdProbeClientForTests } from "./system-probes";

const originalFixturePath = process.env.OPENSCOUT_TAILSCALE_STATUS_JSON;
const originalProbesSocket = process.env.OPENSCOUT_PROBES_SOCKET;
const tempDirectories = new Set<string>();
const tailscaleModuleUrl = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), "tailscale.ts")).href;

beforeEach(() => {
  const directory = mkdtempSync(join(tmpdir(), "openscout-tailscale-probes-disabled-"));
  tempDirectories.add(directory);
  process.env.OPENSCOUT_PROBES_SOCKET = join(directory, "missing.sock");
  resetScoutdProbeClientForTests();
  tailscaleStatusProbe.invalidate("test.reset");
});

afterEach(() => {
  tailscaleStatusProbe.invalidate("test.reset");
  if (originalFixturePath === undefined) {
    delete process.env.OPENSCOUT_TAILSCALE_STATUS_JSON;
  } else {
    process.env.OPENSCOUT_TAILSCALE_STATUS_JSON = originalFixturePath;
  }
  if (originalProbesSocket === undefined) {
    delete process.env.OPENSCOUT_PROBES_SOCKET;
  } else {
    process.env.OPENSCOUT_PROBES_SOCKET = originalProbesSocket;
  }
  resetScoutdProbeClientForTests();

  for (const directory of tempDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  tempDirectories.clear();
});

function writeFixture(body: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), "openscout-tailscale-"));
  tempDirectories.add(directory);
  const filePath = join(directory, "status.json");
  writeFileSync(filePath, JSON.stringify(body, null, 2), "utf8");
  return filePath;
}

function writeRawFixture(body: string): string {
  const directory = mkdtempSync(join(tmpdir(), "openscout-tailscale-"));
  tempDirectories.add(directory);
  const filePath = join(directory, "status.json");
  writeFileSync(filePath, body, "utf8");
  return filePath;
}

function writeExecutable(name: string, body: string): string {
  const directory = mkdtempSync(join(tmpdir(), "openscout-tailscale-"));
  tempDirectories.add(directory);
  const filePath = join(directory, name);
  writeFileSync(filePath, body, "utf8");
  chmodSync(filePath, 0o755);
  return filePath;
}

describe("tailscale status readers", () => {
  test("reads peer candidates and self identity from a status fixture", async () => {
    process.env.OPENSCOUT_TAILSCALE_STATUS_JSON = writeFixture({
      BackendState: "Stopped",
      Health: ["Tailscale is stopped."],
      Self: {
        ID: "self-node",
        HostName: "workstation",
        DNSName: "workstation.tailnet.ts.net.",
        TailscaleIPs: ["100.64.0.10"],
        Online: true,
        OS: "macOS",
      },
      CurrentTailnet: {
        Name: "example.tailnet",
        MagicDNSSuffix: "tailnet.ts.net",
      },
      Peer: {
        peerA: {
          ID: "peer-a",
          HostName: "laptop",
          DNSName: "laptop.tailnet.ts.net.",
          TailscaleIPs: ["100.64.0.11"],
          Online: true,
          OS: "macOS",
          Tags: ["tag:dev"],
        },
      },
    });

    const [peers, self, summary] = await Promise.all([
      readTailscalePeers(),
      readTailscaleSelf(),
      readTailscaleStatusSummary(),
    ]);

    expect(peers).toEqual([
      {
        id: "peer-a",
        name: "laptop",
        dnsName: "laptop.tailnet.ts.net.",
        addresses: ["100.64.0.11"],
        online: true,
        hostName: "laptop",
        os: "macOS",
        tags: ["tag:dev"],
      },
    ]);

    expect(self).toEqual({
      id: "self-node",
      name: "workstation",
      dnsName: "workstation.tailnet.ts.net.",
      addresses: ["100.64.0.10"],
      online: true,
      hostName: "workstation",
      os: "macOS",
      tailnetName: "example.tailnet",
      magicDnsSuffix: "tailnet.ts.net",
    });

    expect(summary).toEqual({
      backendState: "Stopped",
      running: false,
      health: ["Tailscale is stopped."],
      peers,
      self,
    });

    expect(readTailscaleSelfWebHostsSync()).toEqual([]);
  });

  test("reads tailnet web hosts from a running self identity", () => {
    process.env.OPENSCOUT_TAILSCALE_STATUS_JSON = writeFixture({
      BackendState: "Running",
      Self: {
        ID: "self-node",
        HostName: "workstation",
        DNSName: "workstation.tailnet.ts.net.",
        TailscaleIPs: ["100.64.0.10"],
        Online: true,
        OS: "macOS",
      },
      CurrentTailnet: {
        Name: "example.tailnet",
        MagicDNSSuffix: "tailnet.ts.net",
      },
    });

    expect(readTailscaleSelfWebHostsSync()).toEqual([
      "workstation.tailnet.ts.net",
      "100.64.0.10",
    ]);
  });

  test("captures noisy sync tailscale status stderr", () => {
    const tailscale = writeExecutable("tailscale", `#!/bin/sh
if [ "$1" = "status" ]; then
  echo 'Warning: client version "1.96.4-t41cb72f27" != tailscaled server version "1.94.1-t62c6f1cd7-g09fea6572"' >&2
  cat <<'JSON'
{"BackendState":"Running","Self":{"ID":"self-node","HostName":"workstation","DNSName":"workstation.tailnet.ts.net.","TailscaleIPs":["100.64.0.10"],"Online":true}}
JSON
  exit 0
fi
exit 64
`);
    const env = {
      ...process.env,
      OPENSCOUT_TAILSCALE_BIN: tailscale,
    };
    delete env.OPENSCOUT_TAILSCALE_STATUS_JSON;

    const result = spawnSync("bun", [
      "--silent",
      "-e",
      `import { readTailscaleSelfWebHostsSync } from ${JSON.stringify(tailscaleModuleUrl)};
const hosts = readTailscaleSelfWebHostsSync();
const expected = ${JSON.stringify(JSON.stringify([
        "workstation.tailnet.ts.net",
        "100.64.0.10",
      ]))};
if (JSON.stringify(hosts) !== expected) {
  console.error(\`unexpected hosts: \${JSON.stringify(hosts)}\`);
  process.exit(3);
}`,
    ], {
      encoding: "utf8",
      env,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("client version");
    expect(result.stderr).not.toContain("tailscaled server version");
  });

  test("treats malformed status fixtures as unavailable", async () => {
    process.env.OPENSCOUT_TAILSCALE_STATUS_JSON = writeRawFixture("not valid json");

    await expect(readTailscaleStatusSummary()).resolves.toBeNull();
    await expect(readTailscalePeers()).resolves.toEqual([]);
    await expect(readTailscaleSelf()).resolves.toBeNull();
  });
});
