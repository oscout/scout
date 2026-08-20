import { describe, expect, test } from "bun:test";

import {
  isHarnessFeatureUsable,
  normalizeHarnessSupportLevel,
  unsupportedHarnessFeature,
} from "./harness-feature-support";

describe("harness feature support", () => {
  test("normalizes support level aliases conservatively", () => {
    expect(normalizeHarnessSupportLevel("supported")).toBe("yes");
    expect(normalizeHarnessSupportLevel("degraded")).toBe("partial");
    expect(normalizeHarnessSupportLevel("unsupported")).toBe("no");
    expect(normalizeHarnessSupportLevel("unexpected")).toBe("unknown");
    expect(normalizeHarnessSupportLevel(undefined)).toBe("unknown");
  });

  test("treats yes and partial as usable", () => {
    expect(isHarnessFeatureUsable({ level: "yes" })).toBe(true);
    expect(isHarnessFeatureUsable({ level: "partial" })).toBe(true);
    expect(isHarnessFeatureUsable({ level: "no" })).toBe(false);
    expect(isHarnessFeatureUsable({ level: "unknown" })).toBe(false);
    expect(isHarnessFeatureUsable(undefined)).toBe(false);
  });

  test("builds explicit unsupported feature records", () => {
    expect(unsupportedHarnessFeature("Codex does not expose this control yet.", [{
      kind: "adapter_spec",
      ref: "packages/agent-sessions/src/adapters/codex/adapter.spec.json",
    }])).toEqual({
      level: "no",
      reason: "Codex does not expose this control yet.",
      evidence: [{
        kind: "adapter_spec",
        ref: "packages/agent-sessions/src/adapters/codex/adapter.spec.json",
      }],
      downgrade: "unsupported",
    });
  });
});
