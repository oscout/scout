import type { ScoutCommandContext } from "../context.ts";
import {
  loadMeshStatus,
  loadMeshDoctorReport,
  runMeshDiscover,
  runMeshPing,
  loadMeshNodes,
} from "../../core/mesh/service.ts";
import {
  renderMeshStatus,
  renderMeshDoctor,
  renderMeshDiscover,
  renderMeshPing,
  renderMeshNodes,
} from "../../ui/terminal/mesh.ts";
import {
  runMeshCardCommand,
  runMeshEnrollCommand,
  runMeshGrantCommand,
  runMeshPeersCommand,
  runMeshRevokeCommand,
  runMeshTrustCommand,
} from "./mesh-trust.ts";

const MESH_HELP = `scout mesh — Mesh status and diagnostics

Subcommands:
  scout mesh              Show mesh status (default)
  scout mesh doctor       Full mesh diagnostics
  scout mesh nodes        List known mesh nodes
  scout mesh discover     Probe for remote mesh nodes
  scout mesh ping <node>  Ping a specific node by ID, name, or URL

Presence (docs/proposals/mesh-trust-cone.md §11.5):
  scout mesh announce     Open mesh TLS + mDNS (restart-free bind flip)
  scout mesh bind mesh    Same as announce
  scout mesh bind local   Withdraw mesh announcement (TLS/mDNS stand down)

MCP gateway (docs/eng/sco-095-remote-mcp-gateway.md):
  scout mesh bridge       Hold the outbound MCP relay connection (spike harness)

Trust cone (docs/proposals/mesh-trust-cone.md):
  scout mesh peers        List trusted peers
  scout mesh grant        Adjust a peer's tier
  scout mesh revoke       Revoke a trusted peer
  scout mesh card         Print this node's signed node card (--json)
  scout mesh enroll       SAS enrollment, or ssh://… for SSH bootstrap (§3c)
  scout mesh trust        install-grant (machine-local SSH half)
`;

export async function runMeshCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  const subcommand = args[0] ?? "";

  switch (subcommand) {
    case "":
    case "status": {
      const report = await loadMeshStatus();
      context.output.writeValue(report, renderMeshStatus);
      return;
    }

    case "doctor": {
      const report = await loadMeshDoctorReport();
      context.output.writeValue(report, renderMeshDoctor);
      return;
    }

    case "nodes": {
      const result = await loadMeshNodes();
      context.output.writeValue(result, renderMeshNodes);
      return;
    }

    case "discover": {
      const report = await runMeshDiscover();
      context.output.writeValue(report, renderMeshDiscover);
      return;
    }

    case "ping": {
      const target = args[1]?.trim();
      if (!target) {
        context.stderr("Usage: scout mesh ping <node-id|name|url>");
        return;
      }
      const report = await runMeshPing(target);
      context.output.writeValue(report, renderMeshPing);
      return;
    }

    case "announce": {
      const { requestScoutBrokerJson } = await import("@openscout/runtime/broker-api");
      const { resolveScoutBrokerControlUrl } = await import("@openscout/runtime/broker-process-manager");
      const controlUrl = resolveScoutBrokerControlUrl();
      const result = await requestScoutBrokerJson<{ bind: unknown }>(controlUrl, "/v1/mesh/bind", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        // requestScoutBrokerJson serializes `body` itself — stringifying here
        // sends a JSON *string*, so the broker reads `scope` as undefined.
        body: { scope: "mesh" },
      });
      context.output.writeValue(result, (value) => {
        const bind = (value as { bind?: { scope?: string; brokerUrl?: string; tlsAddresses?: string[] } }).bind;
        return [
          "Mesh announced (restart-free).",
          `  Scope: ${bind?.scope ?? "mesh"}`,
          `  Broker URL: ${bind?.brokerUrl ?? "—"}`,
          `  TLS addresses: ${(bind?.tlsAddresses ?? []).join(", ") || "(none — no LAN/Tailscale IPv4)"}`,
        ].join("\n");
      });
      return;
    }

    case "bind": {
      const scope = args[1]?.trim().toLowerCase();
      if (scope !== "mesh" && scope !== "local") {
        context.stderr("Usage: scout mesh bind <mesh|local>");
        return;
      }
      const { requestScoutBrokerJson } = await import("@openscout/runtime/broker-api");
      const { resolveScoutBrokerControlUrl } = await import("@openscout/runtime/broker-process-manager");
      const controlUrl = resolveScoutBrokerControlUrl();
      const result = await requestScoutBrokerJson<{ bind: unknown }>(controlUrl, "/v1/mesh/bind", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: { scope },
      });
      context.output.writeValue(result, (value) => {
        const bind = (value as { bind?: { scope?: string; brokerUrl?: string } }).bind;
        return scope === "mesh"
          ? `Mesh bind applied. Scope=${bind?.scope ?? scope} url=${bind?.brokerUrl ?? "—"}`
          : `Mesh bind withdrawn. Scope=${bind?.scope ?? scope}`;
      });
      return;
    }

    case "bridge": {
      const { runMeshBridgeCommand } = await import("./mesh-bridge.ts");
      await runMeshBridgeCommand(context, args.slice(1));
      return;
    }

    case "peers":
      await runMeshPeersCommand(context, args.slice(1));
      return;

    case "grant":
      await runMeshGrantCommand(context, args.slice(1));
      return;

    case "revoke":
      await runMeshRevokeCommand(context, args.slice(1));
      return;

    case "card":
      await runMeshCardCommand(context, args.slice(1));
      return;

    case "enroll":
      await runMeshEnrollCommand(context, args.slice(1));
      return;

    case "trust":
      await runMeshTrustCommand(context, args.slice(1));
      return;

    case "help":
    case "--help":
    case "-h": {
      context.output.writeText(MESH_HELP);
      return;
    }

    default: {
      context.stderr(`Unknown mesh subcommand: ${subcommand}`);
      context.output.writeText(MESH_HELP);
    }
  }
}
