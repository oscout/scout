import { describe, expect, test } from "bun:test";
import { scoutFlags } from "./scout-flags.ts";

describe("nav.sidebar flag (SCO-083)", () => {
  test("is registered, default on since the sco-083 soak, and not an ops/surface bundle key", () => {
    expect(scoutFlags["nav.sidebar"]).toBeDefined();
    expect(scoutFlags["nav.sidebar"].defaultEnabled).toBe(true);
    expect(scoutFlags["nav.sidebar"].tier).toBe("everyone");
    expect(scoutFlags["nav.sidebar"].tags).not.toContain("experiment");
  });

  test("max-pro and light-prod bundle helpers do not force-enable nav.sidebar", async () => {
    // Bundles only flip OPS_FLAG_KEYS and SURFACE_FLAG_KEYS; nav.sidebar is
    // intentionally excluded so max-pro users are not silently switched.
    const source = await Bun.file(new URL("./scout-flags.ts", import.meta.url)).text();
    expect(source).toContain('"nav.sidebar"');
    // Bundle flagValues calls should not include nav.sidebar.
    expect(source).not.toMatch(/flagValues\([^)]*nav\.sidebar/);
    expect(source).toMatch(/Not included in max-pro/);
  });
});
