import type { Route } from "./types.ts";

/**
 * Slot = the kind of content view whose "back" affordance was historically
 * keyed in sessionStorage. Slots remain as BackToPicker call-site labels;
 * return destinations now live on the history entry via
 * `navigate(..., { returnTo })` (SCO-082 Phase B).
 */
export type NavReturnSlot =
  | "agents"
  | "conversation"
  | "work"
  | "terminal"
  | "sessions"
  | "agent-info"
  | "channels";

/**
 * @deprecated No-op. Prefer `navigate(route, { returnTo })` or `openContent`.
 * Kept so any residual callers compile; the sessionStorage side channel is gone.
 */
export function setNavReturn(_slot: NavReturnSlot, _route: Route): void {
  /* history-state returnTo supersedes the sessionStorage channel */
}

/**
 * @deprecated Always returns null. BackToPicker reads history.state.returnTo.
 */
export function getNavReturn(_slot: NavReturnSlot): Route | null {
  return null;
}

/**
 * @deprecated No-op. History entry state is managed by the router.
 */
export function clearNavReturn(_slot: NavReturnSlot): void {
  /* no-op */
}
