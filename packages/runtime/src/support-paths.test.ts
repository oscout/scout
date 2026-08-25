import { afterEach, describe, expect, test } from "bun:test";

import { assertTestIsolatedUserData } from "./support-paths.js";

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  OPENSCOUT_SUPPORT_DIRECTORY: process.env.OPENSCOUT_SUPPORT_DIRECTORY,
};

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("assertTestIsolatedUserData", () => {
  test("refuses an unisolated write under the test runner", () => {
    delete process.env.OPENSCOUT_SUPPORT_DIRECTORY;
    expect(() => assertTestIsolatedUserData("write test data", "OPENSCOUT_SUPPORT_DIRECTORY"))
      .toThrow(/Refusing to write test data/);
  });

  test("refuses even when NODE_ENV is preset to something other than test", () => {
    // bun test does not override a preset NODE_ENV; the leak that corrupted a
    // real settings.json ran exactly this way. The guard must recognize the
    // runner by its test-file entrypoint, not NODE_ENV alone.
    process.env.NODE_ENV = "development";
    delete process.env.OPENSCOUT_SUPPORT_DIRECTORY;
    expect(() => assertTestIsolatedUserData("write test data", "OPENSCOUT_SUPPORT_DIRECTORY"))
      .toThrow(/Refusing to write test data/);
  });

  test("allows the write once the isolation env var redirects it", () => {
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = "/tmp/openscout-isolated-test";
    expect(() => assertTestIsolatedUserData("write test data", "OPENSCOUT_SUPPORT_DIRECTORY"))
      .not.toThrow();
  });
});
