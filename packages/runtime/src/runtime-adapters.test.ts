import { describe, expect, test } from "bun:test";

import {
  defaultServiceAdapterForPlatform,
  normalizeRuntimeHost,
  normalizeRuntimeServiceAdapter,
  planRuntimeAdapters,
} from "./runtime-adapters.ts";

describe("runtime adapter planning", () => {
  test("keeps Bun as the optimized host plan", () => {
    expect(planRuntimeAdapters({ host: "bun", platform: "darwin", env: {} })).toEqual({
      host: "bun",
      database: "bun-sqlite",
      httpServer: "bun-serve",
      files: "bun-file",
      process: "bun-spawn",
      service: "macos-scoutd",
    });
  });

  test("plans Node headless adapters on Linux", () => {
    expect(planRuntimeAdapters({ host: "node", platform: "linux", env: {} })).toEqual({
      host: "node",
      database: "node-sqlite",
      httpServer: "node-http-ws",
      files: "node-fs",
      process: "node-child-process",
      service: "headless-foreground",
    });
  });

  test("honors explicit runtime and service adapter environment choices", () => {
    expect(normalizeRuntimeHost("Node")).toBe("node");
    expect(normalizeRuntimeServiceAdapter("systemd_user")).toBe("linux-systemd-user");
    expect(defaultServiceAdapterForPlatform("darwin", { OPENSCOUT_RUNTIME_HOST: "node" })).toBe(
      "headless-foreground",
    );
    expect(defaultServiceAdapterForPlatform("linux", { OPENSCOUT_SERVICE_ADAPTER: "systemd-user" })).toBe(
      "linux-systemd-user",
    );
    expect(planRuntimeAdapters({
      platform: "linux",
      env: {
        OPENSCOUT_RUNTIME_HOST: "node",
        OPENSCOUT_SERVICE_ADAPTER: "systemd-user",
      },
    }).service).toBe("linux-systemd-user");
  });
});
