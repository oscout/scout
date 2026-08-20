import type { Route } from "../../lib/types.ts";

/** Jump the visible lane deck to a rendered column, falling back to a profile for registered agents. */
export function focusDeckLane(
  laneId: string,
  agentId: string | undefined,
  navigate: (route: Route) => void,
): void {
  const selector = `[data-lane-id="${laneId.replace(/["\\]/g, "\\$&")}"]`;
  const column = typeof document !== "undefined"
    ? document.querySelector<HTMLElement>(selector)
    : null;
  if (column) {
    column.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    column.focus();
    return;
  }
  if (agentId) {
    navigate({ view: "agents-v2", agentId, tab: "profile" });
  }
}
