import { describe, expect, test } from "bun:test";

import { createScoutCommandContext } from "../context.ts";
import { renderLatestCommandHelp, runLatestCommand } from "./latest.ts";

describe("latest command help", () => {
  test("documents activity, message mode, and filters", () => {
    const help = renderLatestCommandHelp();

    expect(help).toContain("Show the latest Scout activity by default.");
    expect(help).toContain("--messages");
    expect(help).toContain("--conversation <id>");
    expect(help).toContain("--channel <name>");
    expect(help).toContain("--limit <count>");
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

    await runLatestCommand(context, ["--help"]);

    expect(lines.join("\n")).toContain("Usage: scout latest");
  });
});
