import { useSyncExternalStore } from "react";

import { getRecapQueueSnapshot, stopSessionRecaps, subscribeRecapQueue } from "../../lib/session-recap-queue.ts";
import "./fleet-roll-call.css";

export function FleetRollCallHud() {
  const snapshot = useSyncExternalStore(subscribeRecapQueue, getRecapQueueSnapshot, getRecapQueueSnapshot);
  if (!snapshot.running && snapshot.items.length === 0 && !snapshot.notice) return null;
  return (
    <aside className="fleet-roll-call" role="status" aria-live="polite">
      <h2>Fleet roll call</h2>
      {snapshot.speaker ? <p>Speaking <strong>{snapshot.speaker}</strong></p> : null}
      {snapshot.notice ? <p>{snapshot.notice}</p> : null}
      {snapshot.items.length > 0 ? (
        <ol>
          {snapshot.items.map((item) => (
            <li key={item.target.voiceKey}>
              <strong>{item.target.displayLabel}</strong>
              {" · "}
              {item.target.sourceExact}
              {item.summary ? ` — ${item.summary}` : item.reason ? ` — ${item.reason}` : ` — ${item.status}`}
              {item.target.observedAt ? (
                <time dateTime={new Date(item.target.observedAt).toISOString()}>
                  {new Date(item.target.observedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                </time>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      {snapshot.running ? (
        <button type="button" onClick={() => stopSessionRecaps()}>Stop spoken summaries</button>
      ) : null}
    </aside>
  );
}
