/**
 * First-run gate shared by the full shell (Hudson takeover slot) and the basic
 * web client. Pure so both surfaces read the same `/api/onboarding/state`
 * record the same way; there is no second setup model on the client.
 */
import type { OnboardingError, OnboardingState } from "../Provider.tsx";

/** The Solo setup facts the takeover walks, in order. */
export type SoloSetupGap = "local_config" | "identity" | "project" | "services";

export function soloSetupGaps(onboarding: OnboardingState): SoloSetupGap[] {
  const gaps: SoloSetupGap[] = [];
  if (!onboarding.hasLocalConfig) gaps.push("local_config");
  if (!onboarding.hasOperatorName) gaps.push("identity");
  if (!onboarding.hasProjectConfig) gaps.push("project");
  if (!onboarding.brokerReachable || !onboarding.hasReadyRuntime) gaps.push("services");
  return gaps;
}

/**
 * Whether the first-run takeover owns the screen.
 *
 * - `null` until the first state read lands: waiting one round trip beats
 *   flashing setup at returning users or hiding it from new ones.
 * - Off once setup is completed or skipped (server record or this tab), and
 *   for the unreachable-API placeholder, which carries `needed: false`.
 */
export function onboardingTakeoverActive(
  onboarding: OnboardingState | null,
  skippedHere: boolean,
): boolean | null {
  if (!onboarding) return null;
  if (skippedHere || onboarding.needed === false || onboarding.skippedAt || onboarding.completedAt) {
    return false;
  }
  return soloSetupGaps(onboarding).length > 0;
}

/**
 * Setup that was set aside and is still unfinished: the case Home offers to
 * resume. Completed setup, a live takeover and the placeholder don't count.
 */
export function onboardingResumable(onboarding: OnboardingState | null, skippedHere: boolean): boolean {
  if (!onboarding || onboarding.completedAt) return false;
  // The placeholder has no `skippedAt` and `needed: false`; only a real
  // record (or a skip in this tab) can be resumed.
  if (!(skippedHere || onboarding.skippedAt)) return false;
  return soloSetupGaps(onboarding).length > 0;
}

/** What a host-gated setup page shows (the Mac app's `/embed/settings` gate). */
export type OnboardingEmbedView =
  | { kind: "checking" }
  /** No state has ever loaded: say so and offer a retry. */
  | { kind: "unavailable"; message: string }
  /** Setup is owed. `reconnecting` keeps the form (and its input) up through a dropped read. */
  | { kind: "setup"; state: OnboardingState; reconnecting: string | null }
  | { kind: "content" };

/**
 * The embed answers to the canonical record only: a skip this tab made but
 * couldn't save doesn't count, since the host is waiting on `skippedAt`.
 * `lastLoaded` is the last state read without a load error, so a service
 * restart mid-form doesn't swap the form for the placeholder.
 */
export function onboardingEmbedView(
  current: OnboardingState | null,
  lastLoaded: OnboardingState | null,
  error: OnboardingError | null,
): OnboardingEmbedView {
  const loadError = error?.kind === "load" ? error.message : null;
  const state = loadError ? lastLoaded : current;
  if (!state) return loadError ? { kind: "unavailable", message: loadError } : { kind: "checking" };
  return onboardingTakeoverActive(state, false)
    ? { kind: "setup", state, reconnecting: loadError }
    : { kind: "content" };
}
