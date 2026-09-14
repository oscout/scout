import { describe, expect, test } from "bun:test";

import type { MachineRecord } from "@openscout/protocol";

import type { MachinesReport } from "../../core/machines/service.ts";
import { renderMachineDetail, renderMachineForget, renderMachines } from "./machines.ts";

const NOW = Date.now();

function machine(overrides: Partial<MachineRecord> = {}): MachineRecord {
  return {
    id: "mach-aaaa",
    displayName: null,
    name: "mini",
    platform: "macos",
    identityKeys: ["host:mini"],
    isSelf: false,
    hostNames: ["mini.local"],
    addresses: ["192.168.1.23"],
    macAddresses: [],
    capabilities: [],
    routes: [{ kind: "lan", host: "192.168.1.23", port: 43117, lastSeenAt: NOW }],
    evidence: [],
    pinned: false,
    firstSeenAt: NOW - 600_000,
    lastSeenAt: NOW,
    ...overrides,
  };
}

function report(overrides: Partial<MachinesReport> = {}): MachinesReport {
  return {
    brokerUrl: "http://127.0.0.1:43117",
    machines: [machine()],
    generatedAt: NOW,
    sources: {
      tailscale: { available: true, running: true, backendState: "Running", peerCount: 2 },
      lan: { scannedAt: NOW, mdnsEnabled: true, serviceCount: 1, neighborCount: 4 },
    },
    ...overrides,
  };
}

describe("renderMachines", () => {
  test("says why the roster is empty rather than just showing nothing", () => {
    const output = renderMachines(report({
      machines: [],
      sources: {
        tailscale: { available: false, running: false, backendState: null, peerCount: 0 },
        lan: { scannedAt: null, mdnsEnabled: false, serviceCount: 0, neighborCount: 0 },
      },
    }));

    expect(output).toContain("No machines on record");
    expect(output).toContain("Tailscale: not installed");
    expect(output).toContain("LAN: never scanned");
  });

  test("lists a machine with its best route, platform and capabilities", () => {
    const output = renderMachines(report({
      machines: [machine({ isSelf: true, capabilities: ["scout-broker", "herdr"] })],
    }));

    expect(output).toContain("1 machine");
    expect(output).toContain("mini (this machine)");
    expect(output).toContain("192.168.1.23:43117");
    expect(output).toContain("scout-broker herdr");
  });

  test("marks presence by age, not by claim", () => {
    const output = renderMachines(report({
      machines: [
        machine({ id: "mach-online", name: "here", lastSeenAt: NOW }),
        machine({ id: "mach-gone", name: "gone", lastSeenAt: NOW - 86_400_000 }),
      ],
    }));

    expect(output).toMatch(/● here/);
    expect(output).toMatch(/○ gone/);
  });
});

describe("renderMachineDetail", () => {
  test("attributes every claim to the source that made it", () => {
    const output = renderMachineDetail(machine({
      displayName: "the workshop mac",
      macAddresses: ["3c:22:fb:01:02:03"],
      capabilities: ["scout-broker"],
      scoutNodeId: "node-mini",
      tailnetId: "SELF1",
      tailnetName: "tail1234.ts.net",
      evidence: [
        { kind: "scout", observedAt: NOW, nodeId: "node-mini", nodeName: "mini" },
        {
          kind: "lan",
          observedAt: NOW - 5_000,
          method: "arp",
          addresses: ["192.168.1.23"],
          macAddress: "3c:22:fb:01:02:03",
          vendor: "Apple",
        },
      ],
    }));

    expect(output).toContain("the workshop mac");
    expect(output).toContain("Detected name: mini");
    expect(output).toContain("scout    mini — broker node");
    expect(output).toContain("lan      192.168.1.23 (Apple) — ARP table");
  });

  test("says capabilities are unobserved rather than absent", () => {
    expect(renderMachineDetail(machine())).toContain("Capabilities: none observed");
  });
});

describe("renderMachineForget", () => {
  test("is clear that forgetting is not blocking", () => {
    expect(renderMachineForget({ reference: "mini", forgotten: true }))
      .toContain("returns on the next scan");
    expect(renderMachineForget({ reference: "nope", forgotten: false }))
      .toContain("Nothing to forget");
  });
});
