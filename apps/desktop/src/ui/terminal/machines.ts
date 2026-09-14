// Terminal rendering for `scout machines` (docs/eng/sco-104-machines.md).
//
// The list answers "what boxes do I have and can I reach them"; the detail
// answers "how do I know". Evidence is shown by source because a machine Scout
// only ever saw in an ARP table is a very different claim from one running a
// broker, and collapsing the two into one confident row would be a lie.

import {
  machineLabel,
  machinePresence,
  type MachineEvidence,
  type MachineRecord,
} from "@openscout/protocol";

import type { MachinesReport } from "../../core/machines/service.ts";

function presenceDot(machine: MachineRecord, now: number): string {
  switch (machinePresence(machine, now)) {
    case "online":
      return "●";
    case "recent":
      return "◐";
    default:
      return "○";
  }
}

function ago(timestamp: number | undefined, now: number): string {
  if (!timestamp) return "never";
  const seconds = Math.floor((now - timestamp) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

/** The address an operator would actually type, i.e. the best route we know. */
function primaryAddress(machine: MachineRecord): string {
  const route = machine.routes[0];
  if (!route) return "—";
  return route.port ? `${route.host}:${route.port}` : route.host;
}

function sourceSummary(report: MachinesReport): string[] {
  const lines: string[] = [];
  const { tailscale, lan } = report.sources;

  if (!tailscale.available) {
    lines.push("  Tailscale: not installed — tailnet peers are invisible");
  } else if (!tailscale.running) {
    lines.push(`  Tailscale: stopped (${tailscale.backendState ?? "unknown"})`);
  } else {
    lines.push(`  Tailscale: ${tailscale.peerCount} peer${tailscale.peerCount === 1 ? "" : "s"}`);
  }

  if (lan.scannedAt === null) {
    lines.push("  LAN: never scanned — run `scout machines scan`");
  } else {
    const mdns = lan.mdnsEnabled
      ? `${lan.serviceCount} advert${lan.serviceCount === 1 ? "" : "s"}`
      : "mDNS disabled";
    lines.push(`  LAN: ${mdns}, ${lan.neighborCount} ARP neighbour${lan.neighborCount === 1 ? "" : "s"}`);
  }

  return lines;
}

export function renderMachines(report: MachinesReport): string {
  const now = Date.now();
  const lines: string[] = [];

  if (report.machines.length === 0) {
    lines.push("No machines on record.");
    lines.push("");
    lines.push("Sources:");
    lines.push(...sourceSummary(report));
    lines.push("");
    lines.push("Run `scout machines scan` to look again.");
    return lines.join("\n");
  }

  const rows = report.machines.map((machine) => ({
    machine,
    label: machineLabel(machine) + (machine.isSelf ? " (this machine)" : ""),
    address: primaryAddress(machine),
  }));
  const labelWidth = Math.max(...rows.map((row) => row.label.length));
  const addressWidth = Math.max(...rows.map((row) => row.address.length));

  lines.push(`${report.machines.length} machine${report.machines.length === 1 ? "" : "s"}`);
  lines.push("");

  for (const row of rows) {
    const { machine } = row;
    const capabilities = machine.capabilities.length > 0 ? machine.capabilities.join(" ") : "—";
    const pin = machine.pinned ? " 📌" : "";
    lines.push(
      `  ${presenceDot(machine, now)} ${pad(row.label, labelWidth)}  ` +
      `${pad(row.address, addressWidth)}  ${pad(machine.platform, 7)}  ${capabilities}${pin}`,
    );
  }

  lines.push("");
  lines.push("Sources:");
  lines.push(...sourceSummary(report));
  lines.push("");
  lines.push(`Scanned ${ago(report.generatedAt, now)}. \`scout machines show <name>\` for detail.`);

  return lines.join("\n");
}

function describeEvidence(evidence: MachineEvidence, now: number): string {
  const seen = ago(evidence.observedAt, now);
  switch (evidence.kind) {
    case "scout":
      return `scout    ${evidence.nodeName ?? evidence.nodeId} — broker node, ${seen}`;
    case "tailnet": {
      const state = evidence.online ? "online" : "offline";
      return `tailnet  ${evidence.dnsName ?? evidence.hostName ?? evidence.peerId} — ${state}, ${seen}`;
    }
    case "lan": {
      const via = evidence.method === "mdns"
        ? `mDNS ${evidence.serviceType ?? ""}`.trim()
        : "ARP table";
      const who = evidence.hostName ?? evidence.addresses[0] ?? evidence.macAddress ?? "?";
      const vendor = evidence.vendor ? ` (${evidence.vendor})` : "";
      return `lan      ${who}${vendor} — ${via}, ${seen}`;
    }
    case "host":
      return `host     ${evidence.host} — ${evidence.sessionCount} session${evidence.sessionCount === 1 ? "" : "s"}, ${seen}`;
  }
}

export function renderMachineDetail(machine: MachineRecord): string {
  const now = Date.now();
  const lines: string[] = [];

  lines.push(`${presenceDot(machine, now)} ${machineLabel(machine)}${machine.isSelf ? "  (this machine)" : ""}`);
  lines.push(`  ID: ${machine.id}`);
  if (machine.displayName) lines.push(`  Detected name: ${machine.name}`);
  lines.push(`  Platform: ${machine.platform}`);
  lines.push(`  Presence: ${machinePresence(machine, now)} (last seen ${ago(machine.lastSeenAt, now)})`);
  lines.push(`  First seen: ${ago(machine.firstSeenAt, now)}`);
  if (machine.pinned) lines.push("  Pinned: yes (never pruned)");
  if (machine.notes) lines.push(`  Notes: ${machine.notes}`);

  if (machine.scoutNodeId) lines.push(`  Scout node: ${machine.scoutNodeId}${machine.meshId ? ` (mesh ${machine.meshId})` : ""}`);
  if (machine.tailnetId) lines.push(`  Tailnet: ${machine.tailnetName ?? "?"} (${machine.tailnetId})`);

  if (machine.hostNames.length > 0) lines.push(`  Host names: ${machine.hostNames.join(", ")}`);
  if (machine.macAddresses.length > 0) lines.push(`  MAC: ${machine.macAddresses.join(", ")}`);
  lines.push(`  Capabilities: ${machine.capabilities.length > 0 ? machine.capabilities.join(", ") : "none observed"}`);

  if (machine.routes.length > 0) {
    lines.push("");
    lines.push("Routes (most preferred first):");
    for (const route of machine.routes) {
      const target = route.url ?? (route.port ? `${route.host}:${route.port}` : route.host);
      lines.push(`  ${pad(route.kind, 8)} ${target}`);
    }
  }

  lines.push("");
  lines.push("Evidence:");
  for (const evidence of [...machine.evidence].sort((a, b) => b.observedAt - a.observedAt)) {
    lines.push(`  ${describeEvidence(evidence, now)}`);
  }

  return lines.join("\n");
}

export function renderMachineForget(result: { reference: string; forgotten: boolean }): string {
  return result.forgotten
    ? `Forgot ${result.reference}. It returns on the next scan if it is still out there.`
    : `Nothing to forget for ${result.reference}.`;
}
