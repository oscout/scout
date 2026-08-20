import { describe, expect, test } from "bun:test";

import {
  initialLedgerFocusState,
  ledgerFocusClamp,
  ledgerFocusMove,
  ledgerFocusTrack,
  shouldPullLedgerFocus,
  type LedgerFocusState,
} from "./ledger-focus-core.ts";

/**
 * Replays a commit the way the hook's focus effect sees it: pull focus iff the
 * request is unconsumed, then consume it. Returns whether this commit pulled.
 */
function commit(state: LedgerFocusState, consumed: { request: number }): boolean {
  const pulls = shouldPullLedgerFocus(state, consumed.request);
  if (pulls) consumed.request = state.request;
  return pulls;
}

describe("ledger focus request protocol", () => {
  test("operator moves pull focus exactly once each", () => {
    const consumed = { request: initialLedgerFocusState.request };
    let state = ledgerFocusMove(initialLedgerFocusState, 1); // End
    expect(commit(state, consumed)).toBe(true);
    // Feed churn re-renders without state changes: no further pulls.
    expect(commit(state, consumed)).toBe(false);
    state = ledgerFocusMove(state, 0); // k
    expect(commit(state, consumed)).toBe(true);
  });

  test("same-index activation cannot leave intent behind for a clamp to spend", () => {
    // The reviewer's reproduction, as state algebra. Two rows; End focused the
    // last one and that request was consumed.
    const consumed = { request: initialLedgerFocusState.request };
    let state = ledgerFocusMove(initialLedgerFocusState, 1);
    expect(commit(state, consumed)).toBe(true);

    // Enter on the already-focused row. Under the old boolean this armed
    // intent while committing no state — the arm survived, unconsumed. As a
    // numbered request it commits and is consumed on its own commit, aimed at
    // the row the operator explicitly activated.
    state = ledgerFocusMove(state, 1);
    expect(state.request).not.toBe(consumed.request);
    expect(commit(state, consumed)).toBe(true);

    // The operator clicks into the composer and types; broker traffic shrinks
    // the ledger to one row. The clamp adopts index 0 without minting a
    // request, so this commit must not pull focus out of the composer.
    state = ledgerFocusClamp(state, 1);
    expect(state.index).toBe(0);
    expect(commit(state, consumed)).toBe(false);
  });

  test("tracking and clamping never mint focus requests", () => {
    let state = ledgerFocusMove(initialLedgerFocusState, 3);
    const request = state.request;
    state = ledgerFocusTrack(state, 5); // selection tracking (route change, mouse)
    state = ledgerFocusClamp(state, 4); // rows shrank past the selection
    state = ledgerFocusTrack(state, -1); // Escape clears
    expect(state.request).toBe(request);
  });

  test("clamp is inert while the selection is still in range", () => {
    const state = ledgerFocusMove(initialLedgerFocusState, 2);
    expect(ledgerFocusClamp(state, 3)).toBe(state);
    expect(ledgerFocusTrack(state, 2)).toBe(state);
  });

  test("clamp of an empty ledger parks the selection off-list", () => {
    const state = ledgerFocusMove(initialLedgerFocusState, 0);
    expect(ledgerFocusClamp(state, 0).index).toBe(-1);
  });
});
