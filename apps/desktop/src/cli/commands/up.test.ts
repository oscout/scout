import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ScoutOutput } from "../output.ts";

const SUPPORTED_LOCAL_AGENT_HARNESSES = ["claude", "codex", "grok", "grok-acp", "kimi", "pi", "cursor"];

afterEach(() => {
  mock.restore();
});

describe("runUpCommand", () => {
  test("passes the resolved agent definition through when starting by name", async () => {
    const resolveLocalAgentByName = mock(async (_name: string) => ({
      agentId: "smoke.main.mini",
      definitionId: "smoke",
      projectRoot: "/tmp/openscout",
    }));
    const upScoutAgent = mock(async (_input: unknown) => ({
      agentId: "smoke.main.mini",
      definitionId: "smoke",
      projectName: "Openscout",
      projectRoot: "/tmp/openscout",
      sessionId: "relay-smoke",
      startedAt: 123,
      harness: "codex",
      transport: "codex_app_server",
      isOnline: true,
      source: "manual",
    }));
    const writeValue = mock(() => {});
    const output: ScoutOutput = {
      mode: "plain",
      writeText: mock(() => {}),
      writeValue,
    };

    mock.module("@openscout/runtime/local-agents", () => ({
      resolveLocalAgentByName,
      SUPPORTED_LOCAL_AGENT_HARNESSES,
    }));
    mock.module("../../core/agents/service.ts", () => ({
      upScoutAgent,
    }));
    mock.module("../../core/broker/service.ts", () => ({
      parseScoutHarness: (value?: string) => value,
      parseScoutLocalHarness: (value?: string) => value,
    }));

    const { runUpCommand } = await import("./up.ts");
    await runUpCommand({
      cwd: "/tmp/current",
      env: {},
      stdout: () => {},
      stderr: () => {},
      output,
      isTty: false,
    }, ["smoke"]);

    expect(resolveLocalAgentByName.mock.calls).toEqual([
      ["smoke"],
    ]);
    expect(upScoutAgent.mock.calls).toEqual([
      [{
        projectPath: "/tmp/openscout",
        agentName: "smoke",
        harness: undefined,
        model: undefined,
        provider: undefined,
        reasoningEffort: undefined,
        currentDirectory: "/tmp/current",
      }],
    ]);
    expect(writeValue).toHaveBeenCalledTimes(1);
  });

  test("rejects project-name aliases for named startup targets", async () => {
    const resolveLocalAgentByName = mock(async (_name: string, options?: { matchProjectName?: boolean }) => {
      if (options?.matchProjectName) {
        return {
          agentId: "smoke.main.mini",
          definitionId: "smoke",
          projectRoot: "/tmp/openscout",
        };
      }
      return null;
    });

    mock.module("@openscout/runtime/local-agents", () => ({
      resolveLocalAgentByName,
      SUPPORTED_LOCAL_AGENT_HARNESSES,
    }));
    mock.module("../../core/agents/service.ts", () => ({
      upScoutAgent: mock(async () => {
        throw new Error("unexpected startup");
      }),
    }));
    mock.module("../../core/broker/service.ts", () => ({
      parseScoutHarness: (value?: string) => value,
      parseScoutLocalHarness: (value?: string) => value,
    }));

    const { runUpCommand } = await import("./up.ts");
    const output: ScoutOutput = {
      mode: "plain",
      writeText: () => {},
      writeValue: () => {},
    };
    await expect(runUpCommand({
      cwd: "/tmp/current",
      env: {},
      stdout: () => {},
      stderr: () => {},
      output,
      isTty: false,
    }, ["openscout"])).rejects.toThrow(
      'unknown agent "openscout" — that matches project "/tmp/openscout", but the registered agent is "smoke.main.mini". Use `scout up smoke.main.mini` or `scout up "/tmp/openscout"`.',
    );
  });
});
