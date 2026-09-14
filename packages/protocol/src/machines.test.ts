import { describe, expect, test } from "bun:test";

import {
  buildMachineRecord,
  compareMachines,
  deriveMachineCapabilities,
  deriveMachineName,
  deriveMachinePlatform,
  deriveMachineRoutes,
  groupMachineEvidence,
  isTailnetAddress,
  machineIdentityKeys,
  machineLabel,
  machinePresence,
  normalizeMachineHostName,
  normalizeMacAddress,
  stableMachineId,
  type LanMachineEvidence,
  type MachineEvidence,
  type ScoutMachineEvidence,
  type TailnetMachineEvidence,
} from "./machines.js";

const NOW = 1_800_000_000_000;

function scout(overrides: Partial<ScoutMachineEvidence> = {}): ScoutMachineEvidence {
  return {
    kind: "scout",
    observedAt: NOW,
    nodeId: "node-mini",
    nodeName: "mini",
    hostName: "mini.local",
    brokerUrl: "http://100.101.102.103:43117",
    ...overrides,
  };
}

function tailnet(overrides: Partial<TailnetMachineEvidence> = {}): TailnetMachineEvidence {
  return {
    kind: "tailnet",
    observedAt: NOW,
    peerId: "nQ8pXd1CNTRL",
    hostName: "mini",
    dnsName: "mini.tail1234.ts.net.",
    tailnetName: "tail1234.ts.net",
    addresses: ["100.101.102.103"],
    online: true,
    os: "macOS",
    ...overrides,
  };
}

function lan(overrides: Partial<LanMachineEvidence> = {}): LanMachineEvidence {
  return {
    kind: "lan",
    observedAt: NOW,
    method: "mdns",
    hostName: "mini.local",
    instanceName: "mini",
    serviceType: "_openscout._tcp",
    addresses: ["192.168.1.23"],
    port: 43117,
    ...overrides,
  };
}

describe("normalization", () => {
  test("reduces host labels to the short machine name", () => {
    expect(normalizeMachineHostName("mini.local.")).toBe("mini");
    expect(normalizeMachineHostName("mini.tail1234.ts.net")).toBe("mini");
    expect(normalizeMachineHostName("MINI")).toBe("mini");
  });

  test("folds Bonjour collision suffixes back onto one machine", () => {
    expect(normalizeMachineHostName("mini (2)")).toBe("mini");
    expect(normalizeMachineHostName("mini-2.local")).toBe("mini");
  });

  test("keeps a digit that is part of the real name", () => {
    // `node-1` is a machine, not a renamed `node`.
    expect(normalizeMachineHostName("node-1")).toBe("node-1");
    expect(normalizeMachineHostName("node-1.tail1234.ts.net")).toBe("node-1");
  });

  test("rejects MACs that identify nothing", () => {
    expect(normalizeMacAddress("3C:22:FB:01:02:03")).toBe("3c:22:fb:01:02:03");
    expect(normalizeMacAddress("3c-22-fb-01-02-03")).toBe("3c:22:fb:01:02:03");
    expect(normalizeMacAddress("ff:ff:ff:ff:ff:ff")).toBe("");
    expect(normalizeMacAddress("00:00:00:00:00:00")).toBe("");
    expect(normalizeMacAddress("(incomplete)")).toBe("");
    expect(normalizeMacAddress("3c:22:fb:01:02")).toBe("");
  });

  test("refuses host names every machine answers to", () => {
    // iOS reports `localhost` to Tailscale. Keying on it fused an iPhone and
    // an iPad into one record on a real tailnet.
    expect(normalizeMachineHostName("localhost")).toBe("");
    expect(normalizeMachineHostName("localhost.localdomain")).toBe("");
    expect(normalizeMachineHostName("unknown")).toBe("");
  });

  test("rejects group MACs, which are traffic destinations and not machines", () => {
    // Every real `arp -an` carries these: mDNS, SSDP, IPv6 multicast.
    expect(normalizeMacAddress("01:00:5e:00:00:fb")).toBe("");
    expect(normalizeMacAddress("01:00:5e:7f:ff:fa")).toBe("");
    expect(normalizeMacAddress("33:33:00:00:00:01")).toBe("");
    // The locally-administered bit (0x02) is a different bit and stays valid:
    // that is a QEMU NIC, a real machine.
    expect(normalizeMacAddress("52:54:00:12:34:56")).toBe("52:54:00:12:34:56");
  });

  test("pads the leading zeros BSD arp drops", () => {
    // `arp -an` on macOS prints `3c:22:fb:1:2:3` for the same NIC.
    expect(normalizeMacAddress("3c:22:fb:1:2:3")).toBe("3c:22:fb:01:02:03");
  });

  test("recognizes the Tailscale CGNAT range", () => {
    expect(isTailnetAddress("100.101.102.103")).toBe(true);
    expect(isTailnetAddress("100.63.0.1")).toBe(false);
    expect(isTailnetAddress("100.128.0.1")).toBe(false);
    expect(isTailnetAddress("192.168.1.23")).toBe(false);
    expect(isTailnetAddress("fd7a:115c:a1e0::1")).toBe(true);
  });
});

describe("identity keys", () => {
  test("two iOS devices reporting `localhost` stay two machines", () => {
    const ipad = tailnet({
      peerId: "IPAD",
      hostName: "localhost",
      dnsName: "ipad-air-5th-gen-wifi.tail1e8e67.ts.net.",
      addresses: ["100.89.196.79"],
    });
    const iphone = tailnet({
      peerId: "IPHONE",
      hostName: "localhost",
      dnsName: "iphone-13-mini.tail1e8e67.ts.net.",
      addresses: ["100.94.226.89"],
    });

    expect(groupMachineEvidence([ipad, iphone])).toHaveLength(2);
    expect(deriveMachineName([ipad])).toBe("ipad-air-5th-gen-wifi");
    expect(machineIdentityKeys(ipad).durable).toContain("host:ipad-air-5th-gen-wifi");
  });

  test("a LAN address is transient, a tailnet address is durable", () => {
    const keys = machineIdentityKeys(lan({
      addresses: ["192.168.1.23", "100.101.102.103"],
      macAddress: "3c:22:fb:01:02:03",
    }));
    expect(keys.durable).toContain("mac:3c:22:fb:01:02:03");
    expect(keys.durable).toContain("host:mini");
    expect(keys.durable).toContain("ip:100.101.102.103");
    // DHCP reassigns this one; persisting it would fuse two machines later.
    expect(keys.transient).toEqual(["ip:192.168.1.23"]);
  });

  test("scout evidence claims its node id and host", () => {
    expect(machineIdentityKeys(scout()).durable).toEqual(["node:node-mini", "host:mini"]);
  });
});

describe("groupMachineEvidence", () => {
  test("joins ARP and mDNS through the address they share right now", () => {
    const arp = lan({
      method: "arp",
      hostName: undefined,
      instanceName: undefined,
      serviceType: undefined,
      port: undefined,
      macAddress: "3c:22:fb:01:02:03",
    });
    const groups = groupMachineEvidence([arp, lan()]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.evidence).toHaveLength(2);
    // The pass ends with durable keys, so the next pass re-joins without the IP.
    expect(groups[0]!.identityKeys).toEqual(["host:mini", "mac:3c:22:fb:01:02:03"]);
  });

  test("chains three sources that share nothing pairwise", () => {
    // ARP knows only a MAC + LAN IP; mDNS knows that IP + a hostname; Tailscale
    // knows that hostname + a tailnet IP. Nothing links ARP to Tailscale
    // directly — only the chain does.
    const arp = lan({ method: "arp", hostName: undefined, instanceName: undefined, serviceType: undefined, macAddress: "3c:22:fb:01:02:03" });
    const groups = groupMachineEvidence([arp, lan(), tailnet()]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.evidence.map((item) => item.kind).sort()).toEqual(["lan", "lan", "tailnet"]);
  });

  test("keeps unrelated machines apart", () => {
    const other = tailnet({ peerId: "zzOTHER", hostName: "studio", dnsName: "studio.tail1234.ts.net", addresses: ["100.9.9.9"] });
    const groups = groupMachineEvidence([tailnet(), other]);
    expect(groups).toHaveLength(2);
  });

  test("a seed bridges passes that never overlap", () => {
    // Today only ARP saw it; a prior pass proved the MAC and the tailnet id
    // belong together. Without the seed these would be two machines.
    const seed = ["mac:3c:22:fb:01:02:03", "tailnet:nQ8pXd1CNTRL", "host:mini"];
    const arpOnly = lan({ method: "arp", hostName: undefined, instanceName: undefined, serviceType: undefined, macAddress: "3c:22:fb:01:02:03" });
    const tailnetOnly = tailnet({ hostName: undefined, dnsName: undefined });

    expect(groupMachineEvidence([arpOnly, tailnetOnly])).toHaveLength(2);

    const grouped = groupMachineEvidence([arpOnly, tailnetOnly], [seed]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]!.seedIndices).toEqual([0]);
  });

  test("a seed nothing saw this pass yields no group", () => {
    expect(groupMachineEvidence([], [["mac:3c:22:fb:01:02:03"]])).toEqual([]);
  });

  test("evidence that proves two records are one reports both seeds", () => {
    // One record was known by hostname, another by MAC. This advert carries
    // both, so they were always the same machine — the caller absorbs the
    // second into the first.
    const bridge = lan({ macAddress: "3c:22:fb:01:02:03" });
    const groups = groupMachineEvidence([bridge], [["host:mini"], ["mac:3c:22:fb:01:02:03"]]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.seedIndices).toEqual([0, 1]);
  });
});

describe("stableMachineId", () => {
  test("is deterministic and key-order independent", () => {
    const a = stableMachineId(["host:mini", "mac:3c:22:fb:01:02:03"]);
    const b = stableMachineId(["mac:3c:22:fb:01:02:03", "HOST:mini".toLowerCase()]);
    expect(a).toBe(b);
    expect(a).toStartWith("mach-");
  });

  test("different machines get different ids", () => {
    expect(stableMachineId(["host:mini"])).not.toBe(stableMachineId(["host:studio"]));
  });
});

describe("derivations", () => {
  test("Scout's own node name outranks the tailnet hostname", () => {
    expect(deriveMachineName([tailnet(), scout({ nodeName: "workshop" })])).toBe("workshop");
  });

  test("falls back through tailnet, then LAN, then terminal host, then MAC", () => {
    expect(deriveMachineName([tailnet()])).toBe("mini");
    expect(deriveMachineName([lan()])).toBe("mini");
    const arpOnly = lan({ method: "arp", hostName: undefined, instanceName: undefined, macAddress: "3c:22:fb:01:02:03" });
    expect(deriveMachineName([arpOnly])).toBe("3c:22:fb:01:02:03");

    // A box we run sessions on is never nameless just because Tailscale is
    // cold and it advertises nothing.
    const hostOnly: MachineEvidence = {
      kind: "host",
      observedAt: NOW,
      host: "herdr",
      hostName: "mini.local",
      sessionCount: 3,
    };
    expect(deriveMachineName([hostOnly])).toBe("mini");
    expect(deriveMachineName([hostOnly, arpOnly])).toBe("mini");
  });

  test("normalizes a node name, which is a host name with a collision suffix", () => {
    // 25 rows for one Mac in a live registry: `Arts-Mac-mini-534.local`,
    // `-476`, `-419`… Two-digit suffix stripping left all 25 as machines.
    expect(deriveMachineName([scout({ nodeName: "Arts-Mac-mini-534.local" })])).toBe("arts-mac-mini");
    expect(deriveMachineName([scout({ nodeName: "Mini-88.local" })])).toBe("mini");
    expect(machineIdentityKeys(scout({ nodeName: "Arts-Mac-mini-769.local" })).durable)
      .toEqual(machineIdentityKeys(scout({ nodeName: "Arts-Mac-mini-612.local" })).durable);
  });

  test("a peer's loopback broker URL is not a route to it", () => {
    // A dozen peers each advertise `http://127.0.0.1:43120`. That reaches this
    // machine, never them.
    const peer = scout({ brokerUrl: "http://127.0.0.1:43120" });
    expect(deriveMachineRoutes([peer], false)).toEqual([]);
    expect(deriveMachineRoutes([peer], true)).toEqual([
      { kind: "loopback", host: "127.0.0.1", port: 43120, url: "http://127.0.0.1:43120", lastSeenAt: NOW },
    ]);
  });

  test("ranks a reachable route above loopback for this machine", () => {
    const routes = deriveMachineRoutes([scout({ brokerUrl: "http://127.0.0.1:43120" }), lan()], true);
    expect(routes[0]!.kind).toBe("lan");
    expect(routes[routes.length - 1]!.kind).toBe("loopback");
  });

  test("platform comes from the tailnet OS when Tailscale reports one", () => {
    expect(deriveMachinePlatform([tailnet({ os: "linux" })])).toBe("linux");
    expect(deriveMachinePlatform([lan()])).toBe("unknown");
    expect(deriveMachinePlatform([lan({ txt: { model: "MacBookPro18,3" } })])).toBe("macos");
  });

  test("capabilities are observed, not assumed", () => {
    const evidence: MachineEvidence[] = [
      scout({ webUrl: "http://mini:43120" }),
      lan({ serviceType: "_ssh._tcp" }),
      { kind: "host", observedAt: NOW, host: "herdr", hostName: "mini", sessionCount: 3 },
    ];
    expect(deriveMachineCapabilities(evidence)).toEqual(["herdr", "scout-broker", "scout-web", "ssh"]);
  });

  test("routes are ordered loopback, LAN, tailnet, mesh", () => {
    const routes = deriveMachineRoutes([
      scout({ brokerUrl: "http://mini.example.com:43117" }),
      lan(),
      tailnet(),
    ]);
    expect(routes.map((route) => route.kind)).toEqual(["lan", "tailnet", "tailnet", "mesh"]);
    expect(routes[0]).toMatchObject({ kind: "lan", host: "192.168.1.23", port: 43117 });
  });

  test("a malformed advertised URL does not drop the other routes", () => {
    const routes = deriveMachineRoutes([scout({ brokerUrl: "not a url" }), lan()]);
    expect(routes.map((route) => route.kind)).toEqual(["lan"]);
  });
});

describe("buildMachineRecord", () => {
  test("assembles the record from a group", () => {
    const group = groupMachineEvidence([scout(), tailnet(), lan()])[0]!;
    const record = buildMachineRecord(group);

    expect(record.name).toBe("mini");
    expect(record.isSelf).toBe(false);
    expect(record.scoutNodeId).toBe("node-mini");
    expect(record.tailnetId).toBe("nQ8pXd1CNTRL");
    expect(record.tailnetName).toBe("tail1234.ts.net");
    expect(record.hostNames).toEqual(["mini"]);
    expect(record.addresses).toContain("192.168.1.23");
    expect(record.addresses).toContain("100.101.102.103");
    expect(record.capabilities).toContain("scout-broker");
    expect(record.lastSeenAt).toBe(NOW);
    expect(record.firstSeenAt).toBe(NOW);
  });

  test("operator-owned fields survive a rebuild", () => {
    const group = groupMachineEvidence([scout()])[0]!;
    const record = buildMachineRecord(group, {
      id: "mach-fixed",
      displayName: "the workshop mac",
      notes: "lives in the closet",
      pinned: true,
      firstSeenAt: NOW - 90_000,
      lastSeenAt: NOW - 90_000,
    });

    expect(record.id).toBe("mach-fixed");
    expect(record.displayName).toBe("the workshop mac");
    expect(record.notes).toBe("lives in the closet");
    expect(record.pinned).toBe(true);
    expect(record.firstSeenAt).toBe(NOW - 90_000);
    // Fresh evidence still moves last-seen forward.
    expect(record.lastSeenAt).toBe(NOW);
    expect(machineLabel(record)).toBe("the workshop mac");
  });

  test("last-seen never moves backwards on a stale pass", () => {
    const group = groupMachineEvidence([scout({ observedAt: NOW - 500_000 })])[0]!;
    const record = buildMachineRecord(group, { lastSeenAt: NOW });
    expect(record.lastSeenAt).toBe(NOW);
  });

  test("self is carried through from whichever channel reported it", () => {
    const group = groupMachineEvidence([tailnet({ isSelf: true }), lan()])[0]!;
    expect(buildMachineRecord(group).isSelf).toBe(true);
  });
});

describe("presence and ordering", () => {
  test("buckets by age", () => {
    expect(machinePresence({ lastSeenAt: NOW - 1_000 }, NOW)).toBe("online");
    expect(machinePresence({ lastSeenAt: NOW - 10 * 60_000 }, NOW)).toBe("recent");
    expect(machinePresence({ lastSeenAt: NOW - 26 * 60 * 60_000 }, NOW)).toBe("offline");
  });

  test("this machine sorts first, then most recently seen", () => {
    const base = buildMachineRecord(groupMachineEvidence([scout()])[0]!);
    const self = { ...base, id: "mach-self", isSelf: true };
    const stale = { ...base, id: "mach-stale", lastSeenAt: NOW - 500_000 };
    const fresh = { ...base, id: "mach-fresh", lastSeenAt: NOW };
    expect([stale, fresh, self].sort(compareMachines).map((machine) => machine.id))
      .toEqual(["mach-self", "mach-fresh", "mach-stale"]);
  });
});
