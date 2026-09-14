import { describe, expect, test } from "bun:test";

import type { MachineEvidence, MachineRecord, NodeDefinition } from "@openscout/protocol";
import { buildMachineRecord, groupMachineEvidence } from "@openscout/protocol";

import {
  buildMachineEvidence,
  MACHINE_RETENTION_MS,
  reconcileMachines,
  resolveMachineReference,
} from "./machine-inventory.js";
import type { LanScanSnapshot } from "./system-probes/lan-scan.js";
import type { TailscaleStatusSummary } from "./system-probes/tailscale-status.js";

const NOW = 1_800_000_000_000;

const node: NodeDefinition = {
  id: "node-mini",
  meshId: "mesh-1",
  name: "mini",
  hostName: "mini.local",
  advertiseScope: "mesh",
  brokerUrl: "http://100.101.102.103:43117",
  registeredAt: NOW - 10_000,
  lastSeenAt: NOW,
};

const tailscale: TailscaleStatusSummary = {
  backendState: "Running",
  running: true,
  health: [],
  self: {
    id: "SELF1",
    name: "mini",
    hostName: "mini",
    dnsName: "mini.tail1234.ts.net.",
    tailnetName: "tail1234.ts.net",
    addresses: ["100.101.102.103"],
    online: true,
    os: "macOS",
  },
  peers: [{
    id: "PEER1",
    name: "studio",
    hostName: "studio",
    dnsName: "studio.tail1234.ts.net.",
    addresses: ["100.9.9.9"],
    online: true,
    os: "linux",
    tags: ["tag:server"],
  }],
};

const lan: LanScanSnapshot = {
  services: [{
    serviceType: "_openscout._tcp",
    instanceName: "mini",
    host: "mini.local",
    addresses: ["192.168.1.23"],
    port: 43117,
    txt: { v: "1" },
  }],
  neighbors: [
    { address: "192.168.1.23", macAddress: "3c:22:fb:01:02:03", interfaceName: "en0", vendor: "Apple" },
    { address: "192.168.1.77", macAddress: "b8:27:eb:11:22:33", interfaceName: "en0", vendor: "Raspberry Pi" },
  ],
  browsedTypes: ["_openscout._tcp"],
  mdnsEnabled: true,
  scannedAt: NOW,
};

function recordFrom(evidence: MachineEvidence[], previous?: Partial<MachineRecord>): MachineRecord {
  return buildMachineRecord(groupMachineEvidence(evidence)[0]!, previous);
}

describe("buildMachineEvidence", () => {
  test("shapes all four sources into one evidence list", () => {
    const evidence = buildMachineEvidence({
      nodes: { [node.id]: node },
      localNodeId: node.id,
      tailscale,
      lan,
      terminalHosts: [{ kind: "host", observedAt: NOW, host: "herdr", hostName: "mini", sessionCount: 2 }],
      observedAt: NOW,
    });

    const kinds = evidence.map((item) => item.kind);
    expect(kinds.filter((kind) => kind === "scout")).toHaveLength(1);
    expect(kinds.filter((kind) => kind === "tailnet")).toHaveLength(2);
    expect(kinds.filter((kind) => kind === "lan")).toHaveLength(3);
    expect(kinds.filter((kind) => kind === "host")).toHaveLength(1);
  });

  test("marks the local node and the tailnet self as this machine", () => {
    const evidence = buildMachineEvidence({ nodes: [node], localNodeId: node.id, tailscale, observedAt: NOW });
    const selfCount = evidence.filter((item) => (
      (item.kind === "scout" || item.kind === "tailnet") && item.isSelf
    ));
    expect(selfCount).toHaveLength(2);
  });

  test("stamps peers with the tailnet the local node belongs to", () => {
    const evidence = buildMachineEvidence({ tailscale, observedAt: NOW });
    const peer = evidence.find((item) => item.kind === "tailnet" && item.peerId === "PEER1");
    expect(peer).toMatchObject({ tailnetName: "tail1234.ts.net" });
  });

  test("tolerates every source being absent", () => {
    expect(buildMachineEvidence({})).toEqual([]);
  });
});

describe("reconcileMachines: first pass", () => {
  test("collapses the whole picture into one machine per box", () => {
    const evidence = buildMachineEvidence({
      nodes: [node],
      localNodeId: node.id,
      tailscale,
      lan,
      observedAt: NOW,
    });
    const { machines } = reconcileMachines([], evidence, { now: NOW });

    // mini (node + tailnet self + mDNS + its ARP row), studio (tailnet peer),
    // and the unnamed Raspberry Pi that only ARP saw.
    expect(machines).toHaveLength(3);

    const mini = machines.find((machine) => machine.name === "mini")!;
    expect(mini.isSelf).toBe(true);
    expect(mini.scoutNodeId).toBe("node-mini");
    expect(mini.tailnetId).toBe("SELF1");
    expect(mini.macAddresses).toEqual(["3c:22:fb:01:02:03"]);
    expect(mini.capabilities).toContain("scout-broker");

    const pi = machines.find((machine) => machine.name === "b8:27:eb:11:22:33")!;
    expect(pi.capabilities).toEqual([]);
    expect(pi.routes).toEqual([
      { kind: "lan", host: "192.168.1.77", lastSeenAt: NOW },
    ]);
  });
});

describe("reconcileMachines: across passes", () => {
  test("keeps a machine that nothing saw this pass", () => {
    const first = reconcileMachines([], buildMachineEvidence({ tailscale, observedAt: NOW }), { now: NOW });
    expect(first.machines).toHaveLength(2);

    // Tailscale is now down; the fleet is not.
    const second = reconcileMachines(first.machines, [], { now: NOW + 60_000 });
    expect(second.machines).toHaveLength(2);
    expect(second.updated).toEqual([]);
    expect(second.removed).toEqual([]);
  });

  test("re-joins a machine seen through a different channel next time", () => {
    const first = reconcileMachines([], buildMachineEvidence({ lan, observedAt: NOW }), { now: NOW });
    const mini = first.machines.find((machine) => machine.name === "mini")!;

    // Next pass: off the LAN entirely, only Tailscale can see it. The stored
    // hostname key is the bridge.
    const second = reconcileMachines(
      first.machines,
      buildMachineEvidence({ tailscale, observedAt: NOW + 60_000 }),
      { now: NOW + 60_000 },
    );

    const rejoined = second.machines.find((machine) => machine.id === mini.id)!;
    expect(rejoined).toBeDefined();
    expect(rejoined.tailnetId).toBe("SELF1");
    // The MAC learned on the LAN survives a pass that could not see it.
    expect(rejoined.macAddresses).toEqual(["3c:22:fb:01:02:03"]);
  });

  test("a DHCP reassignment does not fuse two machines", () => {
    const before: LanScanSnapshot = {
      ...lan,
      services: [],
      neighbors: [{ address: "192.168.1.50", macAddress: "3c:22:fb:01:02:03", interfaceName: "en0", vendor: "Apple" }],
    };
    const first = reconcileMachines([], buildMachineEvidence({ lan: before, observedAt: NOW }), { now: NOW });
    expect(first.machines).toHaveLength(1);

    // A week later that address belongs to a different NIC entirely.
    const after: LanScanSnapshot = {
      ...lan,
      scannedAt: NOW + 86_400_000,
      services: [],
      neighbors: [{ address: "192.168.1.50", macAddress: "b8:27:eb:11:22:33", interfaceName: "en0", vendor: "Raspberry Pi" }],
    };
    const second = reconcileMachines(
      first.machines,
      buildMachineEvidence({ lan: after, observedAt: NOW + 86_400_000 }),
      { now: NOW + 86_400_000 },
    );

    expect(second.machines).toHaveLength(2);
    expect(second.removed).toEqual([]);
  });

  test("absorbs a duplicate once evidence proves two records are one machine", () => {
    // Two records grew apart: one from mDNS, one from a tailnet peer that never
    // shared a key with it.
    const byLan = recordFrom(buildMachineEvidence({ lan: { ...lan, neighbors: [] }, observedAt: NOW }));
    const byTailnet = recordFrom([{
      kind: "tailnet",
      observedAt: NOW,
      peerId: "SELF1",
      addresses: ["100.101.102.103"],
      online: true,
    }]);
    expect(byLan.id).not.toBe(byTailnet.id);

    // Now Scout's own node card names both the host and that node.
    const proof = buildMachineEvidence({
      nodes: [{ ...node, brokerUrl: "http://100.101.102.103:43117" }],
      tailscale,
      observedAt: NOW + 1_000,
    });
    const result = reconcileMachines([byLan, byTailnet], proof, { now: NOW + 1_000 });

    const survivors = result.machines.filter((machine) => machine.name === "mini");
    expect(survivors).toHaveLength(1);
    expect(survivors[0]!.id).toBe(byLan.id);
    expect(result.removed).toContain(byTailnet.id);
  });

  test("a merge inherits the operator's name, note and pin", () => {
    const byLan = {
      ...recordFrom(buildMachineEvidence({ lan: { ...lan, neighbors: [] }, observedAt: NOW })),
      displayName: null,
      firstSeenAt: NOW - 500_000,
    };
    const byTailnet = {
      ...recordFrom([{ kind: "tailnet" as const, observedAt: NOW, peerId: "SELF1", addresses: ["100.101.102.103"], online: true }]),
      displayName: "the workshop mac",
      notes: "closet, top shelf",
      pinned: true,
    };

    const result = reconcileMachines(
      [byLan, byTailnet],
      buildMachineEvidence({ nodes: [node], tailscale, observedAt: NOW + 1_000 }),
      { now: NOW + 1_000 },
    );

    const survivor = result.machines.find((machine) => machine.id === byLan.id)!;
    expect(survivor.displayName).toBe("the workshop mac");
    expect(survivor.notes).toBe("closet, top shelf");
    expect(survivor.pinned).toBe(true);
    expect(survivor.firstSeenAt).toBe(NOW - 500_000);
  });
});

describe("reconcileMachines: retention", () => {
  test("prunes a machine nobody has seen past the window", () => {
    const stale = { ...recordFrom(buildMachineEvidence({ tailscale, observedAt: NOW })), lastSeenAt: NOW };
    const later = NOW + MACHINE_RETENTION_MS + 1;

    const result = reconcileMachines([stale], [], { now: later });
    expect(result.machines).toEqual([]);
    expect(result.removed).toEqual([stale.id]);
  });

  test("never prunes a pinned machine", () => {
    const pinned = { ...recordFrom(buildMachineEvidence({ tailscale, observedAt: NOW })), lastSeenAt: NOW, pinned: true };
    const result = reconcileMachines([pinned], [], { now: NOW + MACHINE_RETENTION_MS * 10 });
    expect(result.machines).toHaveLength(1);
    expect(result.removed).toEqual([]);
  });
});

describe("resolveMachineReference", () => {
  const machines = [
    { ...recordFrom(buildMachineEvidence({ nodes: [node], lan, observedAt: NOW })), displayName: "workshop" },
    recordFrom([{
      kind: "tailnet",
      observedAt: NOW,
      peerId: "PEER1",
      hostName: "studio",
      addresses: ["100.9.9.9"],
      online: true,
    }]),
  ];

  test("resolves by id, name, display name, hostname and address", () => {
    for (const reference of [machines[0]!.id, "mini", "workshop", "mini.local", "192.168.1.23", "node-mini"]) {
      const resolved = resolveMachineReference(machines, reference);
      expect(resolved).toEqual({ machine: machines[0]! });
    }
  });

  test("reports ambiguity instead of guessing", () => {
    const twins = [
      { ...machines[0]!, id: "mach-a", displayName: null },
      { ...machines[0]!, id: "mach-b", displayName: null },
    ];
    const resolved = resolveMachineReference(twins, "mini");
    expect(resolved).toEqual({ ambiguous: twins });
  });

  test("returns null for an unknown or empty reference", () => {
    expect(resolveMachineReference(machines, "nope")).toBeNull();
    expect(resolveMachineReference(machines, "   ")).toBeNull();
  });
});
