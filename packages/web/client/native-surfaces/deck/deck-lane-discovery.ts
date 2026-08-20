import type {
  CodexDeckRoute,
  CodexDeckThreadSnapshot,
} from "../../surface-contract/scout-surface-contract.ts";

export type DiscoverableDeckLane = {
  key: string;
  hostId: string;
  id: string;
  transport?: string | null;
};

export function prioritizeDeckLane<T extends DiscoverableDeckLane>(
  lanes: readonly T[],
  preferredKey: string,
): T[] {
  const preferred = lanes.find((lane) => lane.key === preferredKey);
  return preferred ? [preferred, ...lanes.filter((lane) => lane.key !== preferredKey)] : [...lanes];
}

/**
 * First-run task discovery is deliberately bounded to the visible channel bank.
 * Each successful connect attaches to Scout's managed Codex app-server; no
 * prompt is sent. A running task wins, then an idle bound task, and failures are
 * ignored so one stale lane cannot strand the whole Deck.
 */
export async function discoverPreferredDeckLane(
  lanes: readonly DiscoverableDeckLane[],
  connect: (route: CodexDeckRoute) => Promise<CodexDeckThreadSnapshot>,
): Promise<string | null> {
  const candidates = lanes.filter((lane) => lane.transport === "codex_app_server");
  const outcomes = await Promise.allSettled(candidates.map(async (lane) => ({
    lane,
    snapshot: await connect({ hostId: lane.hostId, agentId: lane.id }),
  })));
  const bound = outcomes.flatMap((outcome) => outcome.status === "fulfilled" ? [outcome.value] : []);
  return bound.find(({ snapshot }) => snapshot.state === "running")?.lane.key
    ?? bound.find(({ snapshot }) => snapshot.state === "idle")?.lane.key
    ?? null;
}
