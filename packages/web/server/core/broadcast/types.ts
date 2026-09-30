import type { DiscoverySnapshot, TailEvent } from "@openscout/runtime/tail";
import type {
  BroadcastTier,
  Broadcast,
} from "../../../shared/api/broadcasts.ts";
export type {
  BroadcastTier,
  Broadcast,
} from "../../../shared/api/broadcasts.ts";

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
