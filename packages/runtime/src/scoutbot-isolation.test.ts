import { describe, expect, test } from "bun:test";
import type { AgentEndpoint } from "@openscout/protocol";
import { scoutbotIsolationMetadata } from "./scoutbot-isolation.js";

const base = {
  agentId: "scoutbot", harness: "codex",
  metadata: {
    roleConfig: { roleId: "scoutbot" }, systemPrompt: "Use only the granted broker tools.",
    toolGrants: { shell: false, read: ["broker_feed"], write: ["ask"] },
    permissionProfile: "observe", approvalPolicy: "never", sandbox: "read-only", shellTool: false,
    launchArgs: ["--reasoning-effort", "low", "-c", "features.shell_tool=false", "-c", "mcp_servers.scout.enabled_tools=[\"broker_feed\",\"ask\"]"],
    threadId: "old-provider-session", observedModel: "old-model",
  },
} as unknown as AgentEndpoint;

describe("Scoutbot exact-model isolation", () => {
  test("retains role and tool boundaries while replacing model and effort without carrying session identity", () => {
    const result = scoutbotIsolationMetadata(base, { harness: "codex", model: "gpt-6-astra", reasoningEffort: "high" },
      ["-c", 'model="gpt-6-astra"', "-c", 'model_reasoning_effort="high"']);
    expect(result).toMatchObject({ systemPrompt: base.metadata!.systemPrompt, toolGrants: base.metadata!.toolGrants, shellTool: false, sandbox: "read-only" });
    expect(result.launchArgs).toEqual(["-c", "features.shell_tool=false", "-c", 'mcp_servers.scout.enabled_tools=["broker_feed","ask"]', "-c", 'model="gpt-6-astra"', "-c", 'model_reasoning_effort="high"']);
    expect(result.threadId).toBeUndefined();
    expect(result.observedModel).toBeUndefined();
  });
  test("fails closed if constrained role is missing or a different harness is requested", () => {
    expect(() => scoutbotIsolationMetadata({ ...base, metadata: {} }, { model: "gpt-6-astra" }, [])).toThrow("constrained Scoutbot");
    expect(() => scoutbotIsolationMetadata(base, { harness: "claude" }, [])).toThrow("constrained Scoutbot");
  });
  test("leaves unrelated isolated agent metadata unchanged", () => {
    expect(scoutbotIsolationMetadata({ ...base, agentId: "other" }, {}, [])).toEqual({});
  });
});
