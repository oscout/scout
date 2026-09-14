import { useEffect, useRef, useState } from "react";

import { api } from "../../lib/api.ts";
import type { Agent } from "../../lib/types.ts";
import { terminalSearchDelivery } from "./terminal-search.ts";

/**
 * What the broker has carried lately, fetched only when a query asks for it.
 *
 * The roster every screen already holds is the SUMMARY projection — it carries
 * an agent's branch, model, role and node, but not its broker activity, because
 * that is a per-agent history and no screen wants it by default. `msg:` is the
 * one question that does, so it asks for the full roster once and matches
 * against that, rather than making every terminals page load pay for it.
 */

/** A read is held this long before a repeat search asks again. */
const DELIVERY_TTL_MS = 20_000;
/** The roster is capped server-side; ask for the whole of it. */
const DELIVERY_LIMIT = 100;

let cache: { deliveries: Map<string, string>; at: number } | null = null;

async function readDeliveries(): Promise<Map<string, string>> {
  const agents = await api<Agent[]>(`/api/agents?limit=${DELIVERY_LIMIT}`);
  const deliveries = new Map<string, string>();
  for (const agent of agents) {
    const text = terminalSearchDelivery(agent);
    if (text) deliveries.set(agent.id, text);
  }
  return deliveries;
}

export type TerminalDeliveryIndex = {
  /** Delivery text by agent id. Absent means "the broker carried nothing". */
  deliveries: Map<string, string>;
  reading: boolean;
};

/** Read what the broker delivered for every agent, while `enabled`. */
export function useTerminalDeliveries(enabled: boolean): TerminalDeliveryIndex {
  const [deliveries, setDeliveries] = useState<Map<string, string>>(new Map());
  const [reading, setReading] = useState(false);
  const latest = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setReading(false);
      return;
    }
    const fresh = cache && Date.now() - cache.at < DELIVERY_TTL_MS ? cache.deliveries : null;
    if (fresh) {
      setDeliveries(fresh);
      setReading(false);
      return;
    }
    const run = ++latest.current;
    setReading(true);
    void readDeliveries()
      .then((next) => {
        cache = { deliveries: next, at: Date.now() };
        if (latest.current === run) setDeliveries(next);
      })
      // A roster that cannot be read mid-search is not an error worth
      // surfacing; no agent matches a delivery query.
      .catch(() => undefined)
      .finally(() => {
        if (latest.current === run) setReading(false);
      });

    return () => { latest.current += 1; };
  }, [enabled]);

  return { deliveries, reading };
}
