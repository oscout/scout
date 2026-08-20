/** Launch-instruction handling for the chat bootstrap payload.
 *
 * Kept in its own module because `main.tsx` calls `createRoot` at module scope:
 * importing it from a test would mount the app. Everything here is pure. */

/** The launch-only fields of the bootstrap payload — instructions the host sends
 * once, as opposed to preferences it keeps re-sending. */
export type LaunchInstructions = { openIdentity?: boolean; openActions?: boolean };

/** Strip the one-shot launch instructions from a re-read bootstrap.
 *
 * The host re-injects its entire bootstrap whenever a preference changes (a new
 * density, say), and that payload still carries the `openIdentity` flag it sent
 * at launch. Applying a re-read verbatim therefore re-asserts "open the identity
 * card", reopening the card the operator just dismissed — one of the two loops
 * that made Back unusable in the 2026-08-12 captures. `openActions` is the same
 * kind of instruction and is stripped alongside it: the capture seam's own guard
 * lives in a component ref, which a remount would reset, so the contract for
 * "launch-only" belongs here where every such field is handled in one place.
 *
 * This is deliberately a strip on the re-read rather than a consume inside the
 * payload reader: the reader feeds a `useState` initialiser, and StrictMode
 * invokes those twice, so a consuming reader would hand the second invocation a
 * different answer than the first. A pure reader plus a pure strip is
 * double-invoke safe. */
export function stripLaunchOnlyFields<T extends LaunchInstructions>(
  config: T,
): Omit<T, "openIdentity" | "openActions"> & { openIdentity: boolean; openActions: boolean } {
  return { ...config, openIdentity: false, openActions: false };
}
