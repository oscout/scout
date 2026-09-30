import type { TailEvent } from "@openscout/runtime/tail";

export type TailRecentPayload = {
  generatedAt: number;
  limit: number;
  cursor: string | null;
  events: TailEvent[];
};

export type BrokerJsonCache<T> = {
  data: T | null;
  inFlight: Promise<void> | null;
  lastError: string | null;
  serverTiming: string | null;
  refreshedAt: number | null;
};
