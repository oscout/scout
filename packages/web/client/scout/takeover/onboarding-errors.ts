import { friendlyApiError, isOfflineApiError } from "../../lib/api-errors.ts";

export type OnboardingStep = "init" | "identity" | "project" | "setup";

const NETWORK =
  "Scout's local server isn't responding. It may still be starting up — wait a moment and try again.";
const NO_SERVICE =
  "Scout couldn't start its background service. Restart Scout from the menu bar icon, then try again.";
const BROKER_DOWN =
  "The broker isn't running yet. Start Scout's services from the menu bar icon, then run setup again.";
const SCOUTD_TIMEOUT =
  "Starting the broker took too long. Try again — if it keeps happening, restart Scout.";
const PERMISSION =
  "Scout couldn't write its settings in your home folder (~/.openscout). Check the folder's permissions and try again.";
const MISSING_FOLDER =
  "That folder doesn't exist on this Mac. Double-check the path — for example /Users/you/dev.";

/**
 * Turn a raw onboarding failure into copy a first-run user can act on.
 * Builds on the shared api-errors helpers for network detection and the
 * generic fallback, then layers the onboarding-specific broker/scoutd/path
 * cases on top (raw strings sourced from broker-process-manager.ts).
 */
export function friendlyOnboardingError(step: OnboardingStep, cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);

  // Local server / fetch failure — reuse the shared network detection.
  if (isOfflineApiError(friendlyApiError(cause))) {
    return NETWORK;
  }

  // scoutd or Bun executable could not be located.
  if (/Unable to locate scoutd|Unable to locate Bun/i.test(message)) {
    return NO_SERVICE;
  }

  // Headless service adapter — broker must be started out of band.
  if (/openscout-runtime broker/i.test(message)) {
    return BROKER_DOWN;
  }

  // scoutd command exceeded its timeout budget.
  if (/timed out/i.test(message)) {
    return SCOUTD_TIMEOUT;
  }

  // Could not write ~/.openscout because of filesystem permissions.
  if (/EACCES|EPERM|EROFS/i.test(message)) {
    return PERMISSION;
  }

  // Project step: a chosen folder does not exist.
  if (step === "project" && /ENOENT|does not exist|doesn'?t exist/i.test(message)) {
    // Pass the server message through when it already names the path;
    // otherwise fall back to generic guidance.
    const namesPath = /does not exist|doesn'?t exist/i.test(message) && /[/~]/.test(message);
    return namesPath ? message : MISSING_FOLDER;
  }

  return friendlyApiError(cause);
}
