import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  extractRuntimeFreshnessDecisionFromScoutdPayload,
  RUNTIME_FRESHNESS_DECISION_KEYS,
  shouldRestartBrokerForRuntimeFreshness,
} from "./runtime-freshness.ts";

const fixtureNames = [
  "scoutd-status-unverified.json",
  "scoutd-status-stale.json",
  "scoutd-status-pinned.json",
  "scoutd-status-pin-mismatch.json",
  "scoutd-status-stale-intentional-defensive.json",
  "scoutd-status-stale-explicit-pin-defensive.json",
  "scoutd-status-stale-workspace-head.json",
] as const;

function readFixture(name: (typeof fixtureNames)[number]): unknown {
  return JSON.parse(
    readFileSync(new URL(`./test-fixtures/${name}`, import.meta.url), "utf8"),
  );
}

function fixtureRuntimeFreshness(payload: unknown): Record<string, unknown> {
  expect(payload).toBeObject();
  const freshness = (payload as Record<string, unknown>).runtimeFreshness;
  expect(freshness).toBeObject();
  return freshness as Record<string, unknown>;
}

describe("scoutd runtime freshness contract", () => {
  test("status fixtures retain every field used by the decision extractor", () => {
    for (const name of fixtureNames) {
      const freshness = fixtureRuntimeFreshness(readFixture(name));
      for (const key of RUNTIME_FRESHNESS_DECISION_KEYS) {
        expect(Object.hasOwn(freshness, key)).toBe(true);
      }
    }
  });

  test("a live dirty-checkout status is unverified and cannot authorize restart", () => {
    const freshness = extractRuntimeFreshnessDecisionFromScoutdPayload(
      readFixture("scoutd-status-unverified.json"),
    );

    expect(freshness).toEqual({
      state: "unverified",
      intentional: false,
      basis: "workspace_head",
      reasonCode: null,
      detail:
        "The runtime started from a dirty source checkout; commit identity alone cannot prove that the currently loaded process includes every working-tree edit.",
    });
    expect(shouldRestartBrokerForRuntimeFreshness(freshness)).toBe(false);
  });

  test("a stale installed artifact authorizes restart", () => {
    const freshness = extractRuntimeFreshnessDecisionFromScoutdPayload(
      readFixture("scoutd-status-stale.json"),
    );

    expect(freshness).toMatchObject({
      state: "stale",
      intentional: false,
      basis: "installed_artifact",
      reasonCode: null,
    });
    const contract = fixtureRuntimeFreshness(readFixture("scoutd-status-stale.json"));
    expect(contract.actualBuiltAt).toBe("2026-08-01T12:00:00.000Z");
    expect(contract.expectedBuiltAt).toBe("2026-08-02T12:00:00.000Z");
    expect(shouldRestartBrokerForRuntimeFreshness(freshness)).toBe(true);
  });

  test("a reachable explicit pin is intentional and cannot authorize restart", () => {
    const payload = readFixture("scoutd-status-pinned.json");
    const freshness = extractRuntimeFreshnessDecisionFromScoutdPayload(payload);
    const contract = fixtureRuntimeFreshness(payload);
    const runtimeBuild = (payload as {
      scoutdState: { runtimeBuild: { commit: string } };
    }).scoutdState.runtimeBuild;

    expect(freshness).toMatchObject({
      state: "pinned",
      intentional: true,
      basis: "explicit_pin",
      reasonCode: null,
    });
    expect(contract.artifactCommit).toBe(runtimeBuild.commit);
    expect(contract.expectedCommit).toBe(contract.pin);
    expect(contract.artifactCommit).toBe(contract.pin);
    expect(shouldRestartBrokerForRuntimeFreshness(freshness)).toBe(false);
  });

  test("a reachable pin mismatch fails closed with a machine-readable reason", () => {
    const payload = readFixture("scoutd-status-pin-mismatch.json");
    const freshness = extractRuntimeFreshnessDecisionFromScoutdPayload(payload);
    const contract = fixtureRuntimeFreshness(payload);
    const runtimeBuild = (payload as {
      scoutdState: { runtimeBuild: { commit: string } };
    }).scoutdState.runtimeBuild;

    expect(freshness).toMatchObject({
      state: "unverified",
      intentional: false,
      basis: "explicit_pin",
      reasonCode: "pin_mismatch",
    });
    expect(contract.artifactCommit).toBe(runtimeBuild.commit);
    expect(contract.expectedCommit).toBe(contract.pin);
    expect(contract.artifactCommit).not.toBe(contract.pin);
    expect(shouldRestartBrokerForRuntimeFreshness(freshness)).toBe(false);
  });

  test("defensively rejects stale plus intentional although scoutd never emits it", () => {
    const freshness = extractRuntimeFreshnessDecisionFromScoutdPayload(
      readFixture("scoutd-status-stale-intentional-defensive.json"),
    );

    expect(freshness).toMatchObject({
      state: "stale",
      intentional: true,
      basis: "installed_artifact",
    });
    expect(shouldRestartBrokerForRuntimeFreshness(freshness)).toBe(false);
  });

  test("defensively rejects a stale explicit-pin verdict although scoutd no longer emits it", () => {
    const freshness = extractRuntimeFreshnessDecisionFromScoutdPayload(
      readFixture("scoutd-status-stale-explicit-pin-defensive.json"),
    );

    expect(freshness).toMatchObject({
      state: "stale",
      intentional: false,
      basis: "explicit_pin",
    });
    expect(shouldRestartBrokerForRuntimeFreshness(freshness)).toBe(false);
  });

  test("a stale workspace checkout cannot authorize automatic restart", () => {
    const freshness = extractRuntimeFreshnessDecisionFromScoutdPayload(
      readFixture("scoutd-status-stale-workspace-head.json"),
    );

    expect(freshness).toMatchObject({
      state: "stale",
      intentional: false,
      basis: "workspace_head",
    });
    expect(shouldRestartBrokerForRuntimeFreshness(freshness)).toBe(false);
  });

  test("missing decision fields fail closed", () => {
    const freshness = extractRuntimeFreshnessDecisionFromScoutdPayload({
      runtimeFreshness: { state: "stale", basis: "installed_artifact" },
    });

    expect(freshness).toBeNull();
    expect(shouldRestartBrokerForRuntimeFreshness(freshness)).toBe(false);
  });
});
