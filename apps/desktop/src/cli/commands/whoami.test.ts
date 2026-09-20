import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

describe("whoami report", () => {
  test("includes the Herdr managed agent name when present", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "openscout-whoami-"));
    try {
      const lines: string[] = [];
      const context = createScoutCommandContext({
        cwd,
        env: {
          HERDR_ENV: "1",
          HERDR_PANE_ID: "w1:p2",
          HERDR_AGENT: "pi",
          HERDR_AGENT_NAME: "worker",
        },
        stdout: (line) => lines.push(line),
        stderr: () => undefined,
        isTty: false,
      });

      await runWhoAmICommand(context, []);

      const output = lines.join("\n");
      expect(output).toContain("Herdr Agent: worker");
      expect(output).toContain("Host Harness: pi (HERDR_AGENT_NAME)");
      expect(output).toContain("Default Sender: worker.");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
