import { describe, expect, test } from "bun:test";

import { createScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";
import { renderMonitorCommandHelp, runMonitorCommand } from "./monitor.ts";

describe("scout monitor", () => {
  test("documents the v1 console and points at scout tui", () => {
    const help = renderMonitorCommandHelp();
    expect(help).toContain("scout monitor");
    expect(help).toContain("scout tui");
    expect(help).toContain("v1 OpenTUI console");
  });

  test("rejects --json", async () => {
    const context = createScoutCommandContext({ outputMode: "json" });
    await expect(runMonitorCommand(context, [])).rejects.toThrow(ScoutCliError);
  });
});
