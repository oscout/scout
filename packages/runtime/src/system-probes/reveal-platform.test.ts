import { expect, test } from "bun:test";

import { resetExecSystemTransportForTests, setExecSystemSpawnForTests } from "./exec.ts";
import { resetScoutdProbeClientForTests } from "./scoutd-client.ts";
import { revealCommandForPlatform, scout } from "./scout-host.ts";

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

test("does not spawn open -R when process.platform is linux", async () => {
  const previousSocket = process.env.OPENSCOUT_PROBES_SOCKET;
  process.env.OPENSCOUT_PROBES_SOCKET = "/tmp/openscout-missing-probes.sock";
  resetScoutdProbeClientForTests();
  let spawned = false;
  setExecSystemSpawnForTests(() => {
    spawned = true;
    throw new Error("open spawned");
  });
  try {
    await withPlatform("linux", async () => {
      expect(revealCommandForPlatform("darwinReveal", "/tmp/secret")).toBeNull();
      expect(revealCommandForPlatform("darwinOpen", "/tmp/secret")).toBeNull();
      expect(revealCommandForPlatform("xdgOpen", "/tmp/secret")).toEqual({
        file: "xdg-open",
        args: ["/tmp/secret"],
      });
      const result = await scout.host.reveal.open("/tmp/secret", "darwinReveal");
      expect(result).toEqual({ stdout: "", stderr: "", exitCode: 0 });
      expect(spawned).toBe(false);
    });
  } finally {
    resetExecSystemTransportForTests();
    resetScoutdProbeClientForTests();
    if (previousSocket === undefined) delete process.env.OPENSCOUT_PROBES_SOCKET;
    else process.env.OPENSCOUT_PROBES_SOCKET = previousSocket;
  }
});

test("darwin reveal still uses open -R", () => {
  withPlatform("darwin", () => {
    expect(revealCommandForPlatform("darwinReveal", "/tmp/secret")).toEqual({
      file: "open",
      args: ["-R", "/tmp/secret"],
    });
    expect(revealCommandForPlatform("darwinOpen", "/tmp/secret")).toEqual({
      file: "open",
      args: ["/tmp/secret"],
    });
  });
});
