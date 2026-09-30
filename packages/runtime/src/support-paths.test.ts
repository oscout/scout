import { afterEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";

import { assertTestIsolatedUserData, resolveOpenScoutSupportPaths } from "./support-paths.js";

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  OPENSCOUT_SUPPORT_DIRECTORY: process.env.OPENSCOUT_SUPPORT_DIRECTORY,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
};

function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const previous = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { configurable: true, enumerable: true, value: platform });
  const restore = () => {
    if (previous) Object.defineProperty(process, "platform", previous);
  };
  try {
    const result = run();
    if (result instanceof Promise) return result.finally(restore) as T;
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

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

describe("resolveOpenScoutSupportPaths platform default", () => {
  test("darwin keeps ~/Library/Application Support/OpenScout", () => {
    delete process.env.OPENSCOUT_SUPPORT_DIRECTORY;
    process.env.XDG_DATA_HOME = "/var/lib/openscout-should-not-apply";
    withPlatform("darwin", () => {
      expect(resolveOpenScoutSupportPaths().supportDirectory)
        .toBe(join(homedir(), "Library", "Application Support", "OpenScout"));
    });
  });

  test("linux uses ~/.local/share/openscout when the support env and XDG_DATA_HOME are unset", () => {
    delete process.env.OPENSCOUT_SUPPORT_DIRECTORY;
    delete process.env.XDG_DATA_HOME;
    withPlatform("linux", () => {
      expect(resolveOpenScoutSupportPaths().supportDirectory)
        .toBe(join(homedir(), ".local", "share", "openscout"));
    });
  });

  test("linux uses XDG_DATA_HOME, and OPENSCOUT_SUPPORT_DIRECTORY still wins", () => {
    delete process.env.OPENSCOUT_SUPPORT_DIRECTORY;
    process.env.XDG_DATA_HOME = "/custom/xdg-data";
    withPlatform("linux", () => {
      expect(resolveOpenScoutSupportPaths().supportDirectory).toBe("/custom/xdg-data/openscout");
    });
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = "/opt/openscout-override";
    withPlatform("linux", () => {
      expect(resolveOpenScoutSupportPaths().supportDirectory).toBe("/opt/openscout-override");
    });
  });
});
