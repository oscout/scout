import type { DiscoverySnapshot, TailEvent } from "@openscout/runtime/tail";

export type BroadcastTier = "info" | "warn" | "error";

export type Broadcast = {
  id: string;
  tier: BroadcastTier;
  text: string;
  agent?: string;
  project?: string;
  ts: number;
  ruleId: string;
  key: string;
};

export type BroadcastContext = {
  now: number;
  recentEvents: TailEvent[];
  discovery: DiscoverySnapshot;
  previousDiscovery: DiscoverySnapshot | null;
  seenExits: Set<number>;
};

export interface BroadcastRule {
  id: string;
  tier: BroadcastTier;
  cooldownMs: number;
  evaluate(ctx: BroadcastContext): Broadcast[] | null;
}

export type BroadcastSubscriber = (broadcast: Broadcast) => void;
