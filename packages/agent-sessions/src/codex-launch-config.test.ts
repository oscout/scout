import { describe, expect, test } from "bun:test";

import { buildScoutMcpCodexLaunchArgs } from "./codex-launch-config";

describe("buildScoutMcpCodexLaunchArgs", () => {
  test("builds Scout MCP config overrides for the current context root", () => {
    const args = buildScoutMcpCodexLaunchArgs({
      currentDirectory: "/Users/arach/dev/openscout",
      env: {
        ...process.env,
        OPENSCOUT_SETUP_CWD: "/Users/arach",
      },
    });

    expect(args).toHaveLength(6);
    expect(args[0]).toBe("-c");
    expect(args[2]).toBe("-c");
    expect(args[4]).toBe("-c");
    expect(args[1]?.startsWith("mcp_servers.scout.command=")).toBe(true);
    expect(args[3]?.startsWith("mcp_servers.scout.args=")).toBe(true);
    expect(args[5]).toBe(`mcp_servers.scout.cwd=${JSON.stringify("/Users/arach")}`);

    const rawCommand = args[1]?.split("=", 2)[1] ?? "";
    const rawArgs = args[3]?.split("=", 2)[1] ?? "";
    const command = JSON.parse(rawCommand) as string;
    const scoutArgs = JSON.parse(rawArgs) as string[];

    expect(command.length).toBeGreaterThan(0);
    expect(scoutArgs).toContain("mcp");
    expect(scoutArgs).toContain("--context-root");
    expect(scoutArgs.at(-1)).toBe("/Users/arach");
  });
});
