import { expect, test } from "bun:test";

import { openTailscaleApp } from "./service.ts";

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

test("does not run open -a Tailscale when process.platform is linux", async () => {
  await withPlatform("linux", async () => {
    let spawned = false;
    await openTailscaleApp(async () => {
      spawned = true;
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    expect(spawned).toBe(false);
  });
});

test("darwin still opens Tailscale with open -a", async () => {
  await withPlatform("darwin", async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    await openTailscaleApp(async (file, args) => {
      calls.push({ file, args });
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    expect(calls).toEqual([{ file: "open", args: ["-a", "Tailscale"] }]);
  });
});
