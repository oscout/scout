/**
 * Subscribes the working-turn card to the Tail firehose, scoped to the turn's
 * own session. Backfills from `/api/tail/recent` so a card mounted mid-turn
 * shows the steps that already happened, then keeps up live.
 *
 * No playback cadence here, unlike the inspector rail: this ledger sits inside
 * the transcript where the user is watching for the next move, so a step is
 * shown the moment it lands.
 */
import { useEffect, useMemo, useState } from "react";

import { api } from "../../lib/api.ts";
import { useTailEvents } from "../../lib/tail-events.ts";
import type { TailEvent } from "../../lib/types.ts";
import {
  TURN_STEP_LIMIT,
  type TurnStep,
  mergeTurnStepEvents,
  tailEventMatchesTurn,
  toTurnSteps,
} from "./turn-steps.ts";

export function useTurnSteps(input: {
  sessionIds: string[];
  active: boolean;
}): TurnStep[] {
  const { sessionIds, active } = input;
  const scopeKey = sessionIds.join("|");
  const enabled = active && sessionIds.length > 0;
  const [events, setEvents] = useState<TailEvent[]>([]);

  // A new turn (or a new conversation) is a new ledger; never carry rows over.
  useEffect(() => {
    setEvents([]);
  }, [scopeKey]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const params = new URLSearchParams({
      limit: String(TURN_STEP_LIMIT * 3),
      transcripts: "true",
    });
    api<{ events: TailEvent[] }>(`/api/tail/recent?${params.toString()}`)
      .then((result) => {
        if (cancelled) return;
        const matched = (result.events ?? []).filter((event) =>
          tailEventMatchesTurn(event, sessionIds),
        );
        if (matched.length === 0) return;
        setEvents((previous) => mergeTurnStepEvents(previous, matched));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [enabled, scopeKey]);

  useTailEvents(
    (event) => {
      if (!enabled) return;
      if (!tailEventMatchesTurn(event, sessionIds)) return;
      setEvents((previous) => mergeTurnStepEvents(previous, [event]));
    },
    enabled,
  );

  return useMemo(() => (enabled ? toTurnSteps(events) : []), [enabled, events]);
}
