/**
 * Pulling DOM focus is only ever correct when the operator asked to move
 * through the list. The dispatch feed re-renders whenever new traffic lands,
 * and the selected row's index shifts as rows come and go — if focus followed
 * that churn it would rip the caret out of whatever the operator is typing
 * into (the "Ask another agent" composer) and drop it on a list row, where
 * j/k/g/Enter are navigation shortcuts.
 *
 * Intent is therefore a numbered request, not a flag. Every operator move
 * increments `request`; the focus effect pulls focus exactly once per number
 * it has not consumed yet. Index changes that are not operator moves — the
 * clamp when rows disappear, selection tracking, Escape — keep the current
 * number, so they can never spend someone else's intent. A boolean cannot
 * make that guarantee: arming it for a move that leaves the index unchanged
 * (Enter on the already-focused row) commits no state, runs no effect, and
 * leaves the arm behind for the next unrelated index change to spend.
 */
export type LedgerFocusState = { index: number; request: number };

export const initialLedgerFocusState: LedgerFocusState = { index: -1, request: 0 };

/** An operator move: adopt the index and stamp a fresh focus request. */
export function ledgerFocusMove(current: LedgerFocusState, index: number): LedgerFocusState {
  return { index, request: current.request + 1 };
}

/**
 * A non-focusing index update (selection tracking, Escape, clamp): adopt the
 * index, keep the request number so no focus pull can result. Returns the
 * current state identity when nothing changes.
 */
export function ledgerFocusTrack(current: LedgerFocusState, index: number): LedgerFocusState {
  return index === current.index ? current : { index, request: current.request };
}

/** Rows disappeared under the selection: clamp without spending any intent. */
export function ledgerFocusClamp(current: LedgerFocusState, rowCount: number): LedgerFocusState {
  if (current.index < rowCount) return current;
  return ledgerFocusTrack(current, rowCount > 0 ? rowCount - 1 : -1);
}

/** The focus effect pulls focus only for a request number it has not consumed. */
export function shouldPullLedgerFocus(state: LedgerFocusState, consumedRequest: number): boolean {
  return state.request !== consumedRequest;
}
