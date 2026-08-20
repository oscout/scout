import { describe, expect, test } from "bun:test";

import { startProcessParentWatchdog } from "./process-parent-watchdog.ts";

describe("startProcessParentWatchdog", () => {
  test("does nothing without an explicit parent identity", () => {
    expect(startProcessParentWatchdog(undefined)).toBeNull();
    expect(startProcessParentWatchdog("not-a-pid")).toBeNull();
  });

  test("notifies its owner when the expected parent is gone", async () => {
    let orphaned = false;
    const watchdog = startProcessParentWatchdog("123", {
      intervalMs: 1,
      parentPid: () => 1,
      onOrphan: () => { orphaned = true; },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    if (watchdog) clearInterval(watchdog);
    expect(orphaned).toBe(true);
  });
});
