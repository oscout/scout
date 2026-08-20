import { describe, expect, test } from "bun:test";

import { createScoutCommandContext } from "../context.ts";
import { renderWhoCommandHelp, runWhoCommand } from "./who.ts";

describe("who command help", () => {
  test("documents routing discovery and qualified handles", () => {
    const help = renderWhoCommandHelp();

    expect(help).toContain("List agents known to the broker");
    expect(help).toContain("exact target");
    expect(help).toContain("Short handles");
    expect(help).toContain("@talkie#codex?5.5");
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

    await runWhoCommand(context, ["--help"]);

    expect(lines.join("\n")).toContain("Usage: scout who");
  });
});
