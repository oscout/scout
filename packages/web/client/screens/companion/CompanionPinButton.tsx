import { Pin, PinOff, RotateCw } from "lucide-react";
import { useState } from "react";
import { pinToCompanion, unpinFromCompanion } from "../../lib/companion-host.ts";
import { useCompanionHostState } from "./useCompanionHostState.ts";
import "./companion-surface.css";

/**
 * Pin or unpin a work item on the Mac app's desktop companion. Rendered only
 * when the page runs inside the Scout app: in a plain browser there is no
 * companion to pin to, so the control is left out rather than shown dead.
 */
export function CompanionPinButton({ workId, machineId, className }: { workId: string; machineId?: string | null; className: string }) {
  const host = useCompanionHostState();
  const [busy, setBusy] = useState(false);

  if (!host.available) return null;

  // The first read failed: say so, and let the operator try again.
  if (!host.state) {
    return host.error ? (
      <button type="button" className={className} onClick={host.retry} title={host.error}>
        <RotateCw aria-hidden="true" size={13} />
        <span>Companion unavailable · Retry</span>
      </button>
    ) : (
      <button type="button" className={className} disabled aria-busy="true">
        <Pin aria-hidden="true" size={13} />
        <span>Pin to companion</span>
      </button>
    );
  }

  const pinned = host.state.pins.some((pin) => pin.workId === workId);
  const toggle = () => {
    setBusy(true);
    (pinned ? unpinFromCompanion(workId) : pinToCompanion(workId, machineId))
      .then(host.apply)
      .catch(host.fail)
      .finally(() => setBusy(false));
  };

  return (
    <span className="co-host-control">
      <button
        type="button"
        className={className}
        onClick={toggle}
        disabled={busy}
        aria-pressed={pinned}
        title={pinned ? "Remove from the desktop companion" : "Keep this work on the desktop companion"}
      >
        {pinned ? <PinOff aria-hidden="true" size={13} /> : <Pin aria-hidden="true" size={13} />}
        <span>{pinned ? "Unpin from companion" : "Pin to companion"}</span>
      </button>
      {host.error && <span className="co-host-error" role="alert">{host.error}</span>}
    </span>
  );
}
