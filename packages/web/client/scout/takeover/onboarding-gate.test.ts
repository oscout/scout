import { describe, expect, test } from "bun:test";

import type { OnboardingState } from "../Provider.tsx";
import { onboardingEmbedView, onboardingResumable, onboardingTakeoverActive, soloSetupGaps } from "./onboarding-gate.ts";

/** The record the public 0.3.1 install on the mini returned: everything healthy but the name. */
const MINI_FIRST_RUN: OnboardingState = {
  hasLocalConfig: true,
  hasProjectConfig: true,
  hasOperatorName: false,
  localConfigPath: "/Users/arach/.openscout/config.json",
  projectRoot: "/Users/arach",
  currentDirectory: "/Users/arach",
  operatorName: null,
  operatorNameSuggestion: "Arach",
  brokerReachable: true,
  hasReadyRuntime: true,
  skippedAt: null,
  completedAt: null,
  needed: true,
};

/** Provider's stand-in while the API is unreachable. */
const PLACEHOLDER: OnboardingState = {
  hasLocalConfig: true,
  hasProjectConfig: true,
  hasOperatorName: true,
  localConfigPath: null,
  projectRoot: null,
  currentDirectory: null,
  operatorName: null,
  operatorNameSuggestion: null,
  needed: false,
};

const done = (overrides: Partial<OnboardingState> = {}): OnboardingState => ({
  ...MINI_FIRST_RUN,
  hasOperatorName: true,
  operatorName: "Arach",
  completedAt: 1_700_000_000_000,
  needed: false,
  ...overrides,
});

describe("onboardingTakeoverActive", () => {
  test("waits for the first state read instead of guessing", () => {
    expect(onboardingTakeoverActive(null, false)).toBeNull();
  });

  test("a first run with only the name missing takes over (the mini 0.3.1 case)", () => {
    expect(onboardingTakeoverActive(MINI_FIRST_RUN, false)).toBe(true);
    expect(soloSetupGaps(MINI_FIRST_RUN)).toEqual(["identity"]);
  });

  test("every unfinished fact keeps the takeover up, in step order", () => {
    const bare: OnboardingState = {
      ...MINI_FIRST_RUN,
      hasLocalConfig: false,
      hasProjectConfig: false,
      brokerReachable: false,
      hasReadyRuntime: false,
    };
    expect(onboardingTakeoverActive(bare, false)).toBe(true);
    expect(soloSetupGaps(bare)).toEqual(["local_config", "identity", "project", "services"]);
    const noRuntime = { ...MINI_FIRST_RUN, hasOperatorName: true, hasReadyRuntime: false };
    expect(onboardingTakeoverActive(noRuntime, false)).toBe(true);
    expect(soloSetupGaps(noRuntime)).toEqual(["services"]);
  });

  test("skipping, in this tab or on the server, returns the app", () => {
    expect(onboardingTakeoverActive(MINI_FIRST_RUN, true)).toBe(false);
    expect(onboardingTakeoverActive({ ...MINI_FIRST_RUN, skippedAt: 1, needed: false }, false)).toBe(false);
  });

  test("completed setup never takes over again", () => {
    expect(onboardingTakeoverActive(done(), false)).toBe(false);
    // Even if a fact later regresses (broker down), completion is sticky.
    expect(onboardingTakeoverActive(done({ brokerReachable: false }), false)).toBe(false);
  });

  test("the unreachable-API placeholder never takes over", () => {
    expect(onboardingTakeoverActive(PLACEHOLDER, false)).toBe(false);
  });
});

describe("onboardingResumable", () => {
  test("only skipped, unfinished setup is offered for resume", () => {
    expect(onboardingResumable({ ...MINI_FIRST_RUN, skippedAt: 1, needed: false }, false)).toBe(true);
    expect(onboardingResumable(MINI_FIRST_RUN, true)).toBe(true);
  });

  test("nothing to resume while the takeover is live, after completion, or before state", () => {
    expect(onboardingResumable(MINI_FIRST_RUN, false)).toBe(false);
    expect(onboardingResumable(done({ skippedAt: 1 }), true)).toBe(false);
    expect(onboardingResumable(null, true)).toBe(false);
    expect(onboardingResumable(PLACEHOLDER, false)).toBe(false);
  });

  test("a skip whose facts are all satisfied has nothing left to resume", () => {
    expect(onboardingResumable({ ...MINI_FIRST_RUN, hasOperatorName: true, skippedAt: 1, needed: false }, false)).toBe(false);
  });
});

describe("onboardingEmbedView (the Mac app's /embed/settings setup window)", () => {
  const LOAD = { kind: "load" as const, message: "Scout's local server isn't responding." };
  const SKIP = { kind: "skip" as const, message: "boom" };

  test("waits for the first read, then shows the takeover while setup is needed", () => {
    expect(onboardingEmbedView(null, null, null)).toEqual({ kind: "checking" });
    expect(onboardingEmbedView(MINI_FIRST_RUN, MINI_FIRST_RUN, null)).toEqual({
      kind: "setup",
      state: MINI_FIRST_RUN,
      reconnecting: null,
    });
  });

  test("a first read that fails offers a retry instead of falling through to Settings", () => {
    expect(onboardingEmbedView(PLACEHOLDER, null, LOAD)).toEqual({ kind: "unavailable", message: LOAD.message });
  });

  test("a read that drops mid-form keeps the form on the last loaded state", () => {
    expect(onboardingEmbedView(PLACEHOLDER, MINI_FIRST_RUN, LOAD)).toEqual({
      kind: "setup",
      state: MINI_FIRST_RUN,
      reconnecting: LOAD.message,
    });
  });

  test("canonical completion or skip hands the page back", () => {
    expect(onboardingEmbedView(done(), done(), null)).toEqual({ kind: "content" });
    const skipped = { ...MINI_FIRST_RUN, skippedAt: 1, needed: false };
    expect(onboardingEmbedView(skipped, skipped, null)).toEqual({ kind: "content" });
  });

  test("a skip that failed to save keeps setup up, since the host waits on skippedAt", () => {
    expect(onboardingEmbedView(MINI_FIRST_RUN, MINI_FIRST_RUN, SKIP).kind).toBe("setup");
  });
});
