import { describe, expect, test } from "bun:test";

import { createScoutCommandContext } from "../context.ts";
import { renderWhoAmICommandHelp, runWhoAmICommand } from "./whoami.ts";

describe("whoami command help", () => {
  test("documents sender and broker context", () => {
    const help = renderWhoAmICommandHelp();

    expect(help).toContain("Show the current Scout sender and broker context.");
    expect(help).toContain("default sender id");
    expect(help).toContain("OPENSCOUT_AGENT");
    expect(help).toContain("broker URL");
  });

  test("prints help before setup or broker access", async () => {
    const lines: string[] = [];
    const context = createScoutCommandContext({
      cwd: "/tmp/openscout-test",
      env: {},
      stdout: (line) => lines.push(line),
      stderr: () => undefined,
      isTty: false,
    });

    await runWhoAmICommand(context, ["-h"]);

    expect(lines.join("\n")).toContain("Usage: scout whoami");
  });
});
