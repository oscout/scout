// Broker-side machine inventory: the one process allowed to run the scan and
// own the roster.
//
// Everything else — CLI, web, native — reads `/v1/machines`. That is not
// ceremony: the scan spawns `arp` and holds a multicast socket, and the roster
// is a durable table. N surfaces each doing their own would reproduce exactly
// the probe stampede SCO-077 was written to end, and would give every surface
// a different answer about which machines exist.

import {
  machineLabel,
  type MachineRecord,
} from "@openscout/protocol";
import type { NodeDefinition } from "@openscout/protocol";

import {
  collectMachineEvidence,
  reconcileMachines,
  resolveMachineReference,
  type MachineReconcileResult,
} from "./machine-inventory.js";
import { lanScanProbe, type LanScanSnapshot } from "./system-probes/lan-scan.js";
import { tailscaleStatusProbe } from "./system-probes/tailscale-status.js";

/** The slice of the control-plane store this service needs. */
export type MachineStore = {
  listMachines: () => MachineRecord[];
  machine: (id: string) => MachineRecord | undefined;
  upsertMachine: (machine: MachineRecord) => void;
  deleteMachine: (id: string) => boolean;
  updateMachineAnnotations: (
    id: string,
    input: { displayName?: string | null; notes?: string | null; pinned?: boolean },
  ) => MachineRecord | undefined;
};

export type MachineSourceStatus = {
  tailscale: { available: boolean; running: boolean; backendState: string | null; peerCount: number };
  lan: { scannedAt: number | null; mdnsEnabled: boolean; serviceCount: number; neighborCount: number };
};

export type MachineInventoryReport = {
  machines: MachineRecord[];
  generatedAt: number;
  /** Which observers actually contributed — an empty fleet has a reason. */
  sources: MachineSourceStatus;
};

export type BrokerMachineServiceOptions = {
  store: MachineStore | null;
  nodes: () => Record<string, NodeDefinition>;
  localNodeId: string;
  localHostName?: string | null;
  /**
   * How long a report is reused before another pass runs. The roster changes
   * on the order of minutes; a page that polls every 15s must not mean a scan
   * every 15s.
   */
  cacheTtlMs?: number;
};

const DEFAULT_CACHE_TTL_MS = 30_000;

export class MachineInventoryUnavailableError extends Error {
  constructor() {
    super("machine inventory requires broker SQLite persistence, which is disabled");
    this.name = "MachineInventoryUnavailableError";
  }
}

export class BrokerMachineService {
  private cached: MachineInventoryReport | null = null;
  private inFlight: Promise<MachineInventoryReport> | null = null;

  constructor(private readonly options: BrokerMachineServiceOptions) {}

  get available(): boolean {
    return this.options.store !== null;
  }

  private requireStore(): MachineStore {
    const store = this.options.store;
    if (!store) throw new MachineInventoryUnavailableError();
    return store;
  }

  private sourceStatus(lan: LanScanSnapshot | null): MachineSourceStatus {
    const tailscale = tailscaleStatusProbe.read().value;
    return {
      tailscale: {
        available: tailscale !== null,
        running: tailscale?.running ?? false,
        backendState: tailscale?.backendState ?? null,
        peerCount: tailscale?.peers.length ?? 0,
      },
      lan: {
        scannedAt: lan?.scannedAt || null,
        mdnsEnabled: lan?.mdnsEnabled ?? false,
        serviceCount: lan?.services.length ?? 0,
        neighborCount: lan?.neighbors.length ?? 0,
      },
    };
  }

  /**
   * Run a pass and persist it. `refresh` forces the probes to re-run rather
   * than serving whatever they last cached.
   */
  async scan(options: { refresh?: boolean } = {}): Promise<MachineInventoryReport> {
    const store = this.requireStore();

    const evidence = await collectMachineEvidence({
      nodes: this.options.nodes(),
      localNodeId: this.options.localNodeId,
      localHostName: this.options.localHostName ?? null,
      refresh: options.refresh === true,
    });

    const result: MachineReconcileResult = reconcileMachines(store.listMachines(), evidence);
    for (const machine of result.updated) store.upsertMachine(machine);
    for (const id of result.removed) store.deleteMachine(id);

    // Read back rather than trusting the in-memory result: the store's upsert
    // is the authority on first-seen and last-seen, which it clamps.
    const machines = store.listMachines();
    const report: MachineInventoryReport = {
      machines,
      generatedAt: Date.now(),
      sources: this.sourceStatus(lanScanProbe.read().value),
    };
    this.cached = report;
    return report;
  }

  /**
   * The roster. Serves the cached report inside its TTL and collapses
   * concurrent callers onto one pass.
   */
  async list(options: { refresh?: boolean } = {}): Promise<MachineInventoryReport> {
    const ttl = this.options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    if (!options.refresh && this.cached && Date.now() - this.cached.generatedAt < ttl) {
      return this.cached;
    }
    if (!options.refresh && this.inFlight) return this.inFlight;

    const pass = this.scan(options).finally(() => {
      if (this.inFlight === pass) this.inFlight = null;
    });
    if (!options.refresh) this.inFlight = pass;
    return pass;
  }

  /** Everything on record, without running a pass. */
  roster(): MachineRecord[] {
    return this.requireStore().listMachines();
  }

  /**
   * Resolve an operator-typed reference against the roster. Ambiguity is
   * reported, never guessed — two machines called `mini` is a real situation.
   */
  resolve(reference: string): { machine: MachineRecord } | { ambiguous: string[] } | null {
    const resolved = resolveMachineReference(this.requireStore().listMachines(), reference);
    if (!resolved) return null;
    if ("machine" in resolved) return resolved;
    return { ambiguous: resolved.ambiguous.map((machine) => `${machineLabel(machine)} (${machine.id})`) };
  }

  annotate(
    id: string,
    input: { displayName?: string | null; notes?: string | null; pinned?: boolean },
  ): MachineRecord | undefined {
    const updated = this.requireStore().updateMachineAnnotations(id, input);
    // The cached report now holds a stale label.
    if (updated) this.cached = null;
    return updated;
  }

  /**
   * Drop a machine from the roster. It comes back on the next pass if it is
   * still out there — this forgets what Scout recorded, it does not blocklist.
   */
  forget(id: string): boolean {
    const removed = this.requireStore().deleteMachine(id);
    if (removed) this.cached = null;
    return removed;
  }
}
