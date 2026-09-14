/** Portable remote entrypoint: the normal native installer, with node/activity gates. */
import { readScoutBrokerHealth, readScoutBrokerSnapshot } from "../../../apps/desktop/src/core/broker/service.ts";
import { createScoutCommandContext } from "../../../apps/desktop/src/cli/context.ts";
import { runInstallCommand } from "../../../apps/desktop/src/cli/commands/install.ts";

const terminal = new Set(["completed", "failed", "cancelled", "canceled", "expired"]);

export function checkUpdateActivity(snapshot: { flights?: Record<string, { id?: string; state?: string }> } | null, expectedNodeIds: string[], health: { nodeId?: string | null; ok?: boolean; reachable?: boolean }) {
  if (!health.ok || !health.reachable || !health.nodeId || !expectedNodeIds.includes(health.nodeId)) {
    throw new Error("Remote Scout node identity was not confirmed; no installation performed");
  }
  if (!snapshot?.flights || typeof snapshot.flights !== "object") {
    throw new Error("Remote Scout activity is unavailable; no installation performed");
  }
  const active = Object.values(snapshot.flights).filter((flight) => !terminal.has(flight.state ?? ""));
  if (active.length) throw new Error(`Remote Scout has active flights (${active.map((flight) => flight.id ?? "unknown").join(", ")}); retry after they finish`);
  return health.nodeId;
}

if (import.meta.main) {
  try {
    const [expectedJson, receipt, dmg] = process.argv.slice(2);
    const expected: unknown = JSON.parse(expectedJson ?? "null");
    const inspect = receipt === "--inspect" && dmg === undefined;
    if (!Array.isArray(expected) || !expected.length || !expected.every((id) => typeof id === "string") || !receipt || (!inspect && !dmg)) {
      throw new Error("Expected Scout node IDs, candidate receipt, and DMG are required");
    }
    // Registry snapshots do not carry nodeId. Identity belongs to health;
    // activity belongs to the snapshot, both read through the broker client.
    const health = await readScoutBrokerHealth();
    const nodeId = checkUpdateActivity(await readScoutBrokerSnapshot(), expected, health);
    if (inspect) {
      console.log(JSON.stringify({ schema: "openscout.remote-update-preflight.v1", nodeId, activeFlights: 0, mutated: false }));
    } else {
      const records: string[] = [];
      await runInstallCommand(createScoutCommandContext({ outputMode: "json", stdout: (line) => records.push(line) }), ["--candidate", receipt, "--dmg", dmg!]);
      console.log(JSON.stringify({ schema: "openscout.remote-native-update.v1", nodeId, native: records.map((line) => JSON.parse(line)), wholeSuiteVerified: false }));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
