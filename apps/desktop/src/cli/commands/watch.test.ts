import { describe, expect, test } from "bun:test";

import { createScoutCommandContext } from "../context.ts";
import { renderWatchCommandHelp, runWatchCommand } from "./watch.ts";

describe("watch command help", () => {
  test("documents streaming and supported filters", () => {
    const help = renderWatchCommandHelp();

    expect(help).toContain("Stream Scout broker messages as they arrive.");
    expect(help).toContain("--channel <name>");
    expect(help).toContain("--conversation <id>");
    expect(help).toContain("--since <time>");
    expect(help).toContain("--limit <count>");
    expect(help).toContain("--once");
    expect(help).toContain("--channel and --conversation are mutually exclusive.");
  });

  test("prints help before broker access", async () => {
    const lines: string[] = [];
    const context = createScoutCommandContext({
      cwd: "/tmp/openscout-test",
      env: {},
      stdout: (line) => lines.push(line),
      stderr: () => undefined,
      isTty: false,
    });

    await runWatchCommand(context, ["-h"]);

    expect(lines.join("\n")).toContain("Usage: scout watch");
  });
});
