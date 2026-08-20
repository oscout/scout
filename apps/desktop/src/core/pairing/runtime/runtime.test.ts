import { describe, expect, test } from "bun:test";

import { createPairingAdapterRegistry } from "./runtime.ts";

describe("Pairing adapter registry", () => {
  test("registers every OpenCode compatibility path", () => {
    const adapters = createPairingAdapterRegistry();

    for (const adapterType of ["opencode", "opencode-v2", "opencode-acp"] as const) {
      const factory = adapters[adapterType];
      expect(typeof factory).toBe("function");
      expect(factory?.({ sessionId: `test-${adapterType}` }).type).toBe(adapterType);
    }
  });
});
