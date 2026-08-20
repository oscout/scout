import { useEffect } from "react";

/**
 * Honor-system contract for "right-rail" / "bottom-rail" slot occupancy.
 *
 * Coordinated with Hudson (see docs/eng/scout-issue-tally in git history +
 * Hudson reply regarding `useRailSlot`):
 *   - One occupant per `side`.
 *   - Claimant wins; previous occupant gets `hudson:rail:preempted` and is
 *     expected to collapse cooperatively.
 *   - `body[data-rail-occupant-${side}]` reflects the current owner.
 *
 * Hudson plans to ship a matching hook in `@hudsonkit` so cross-app
 * coordination works without either side hand-rolling the events.
 */

export type RailSide = "right" | "bottom";

type RailEventDetail = { owner: string; side: RailSide; by?: string };

const datasetKey = (side: RailSide): "railOccupantRight" | "railOccupantBottom" =>
  side === "right" ? "railOccupantRight" : "railOccupantBottom";

export function useRailSlot(
  side: RailSide,
  owner: string,
  active: boolean,
  onPreempt?: () => void,
): void {
  useEffect(() => {
    if (!active) return;
    if (typeof window === "undefined" || typeof document === "undefined") return;

    const key = datasetKey(side);
    const previous = document.body.dataset[key];

    document.body.dataset[key] = owner;

    window.dispatchEvent(
      new CustomEvent<RailEventDetail>("hudson:rail:claim", {
        detail: { owner, side },
      }),
    );

    if (previous && previous !== owner) {
      window.dispatchEvent(
        new CustomEvent<RailEventDetail>("hudson:rail:preempted", {
          detail: { owner: previous, side, by: owner },
        }),
      );
    }

    const onClaim = (event: Event) => {
      const detail = (event as CustomEvent<RailEventDetail>).detail;
      if (!detail) return;
      if (detail.side !== side) return;
      if (detail.owner === owner) return;
      onPreempt?.();
    };

    const onPreemptedExternal = (event: Event) => {
      const detail = (event as CustomEvent<RailEventDetail>).detail;
      if (!detail) return;
      if (detail.side !== side) return;
      if (detail.owner !== owner) return;
      onPreempt?.();
    };

    window.addEventListener("hudson:rail:claim", onClaim);
    window.addEventListener("hudson:rail:preempted", onPreemptedExternal);

    return () => {
      window.removeEventListener("hudson:rail:claim", onClaim);
      window.removeEventListener("hudson:rail:preempted", onPreemptedExternal);
      if (document.body.dataset[key] === owner) {
        delete document.body.dataset[key];
      }
      window.dispatchEvent(
        new CustomEvent<RailEventDetail>("hudson:rail:release", {
          detail: { owner, side },
        }),
      );
    };
  }, [side, owner, active, onPreempt]);
}
