import { expect, test } from "bun:test";
import type { AgentEndpoint, InvocationRequest } from "@openscout/protocol";
import { exactClaudeNativeSessionForDelivery, flatSessionEndpointLaunchArgs, requireClaudeNativeSessionBeforeDelivery } from "./local-agents.js";

test("flat tmux Claude continuation explicitly resumes its requested native id", () => {
  const endpoint = { transport: "tmux", harness: "claude", metadata: { flatDispatch: true, nativeSessionId: "native-target", launchArgs: ["--model", "opus", "--continue", "--resume", "wrong", "--fork-session", "--session-id=wrong"] } } as AgentEndpoint;
  expect(flatSessionEndpointLaunchArgs(endpoint)).toEqual(["--model", "opus", "--resume", "native-target"]);
});

test("a flat continuation without native identity cannot launch fresh", () => {
  expect(() => flatSessionEndpointLaunchArgs({ transport: "tmux", harness: "claude", metadata: { flatDispatch: true } } as AgentEndpoint)).toThrow("no native session id");
});

test("ordinary new Claude launches keep their launch arguments", () => {
  expect(flatSessionEndpointLaunchArgs({ transport: "tmux", harness: "claude", metadata: { launchArgs: ["--model", "opus"] } } as AgentEndpoint)).toEqual(["--model", "opus"]);
});


test("pre-delivery native guard accepts only the observed requested session", async () => {
  await expect(requireClaudeNativeSessionBeforeDelivery("native-target", {
    observe: async () => ({ sessionId: "native-target" }),
  })).resolves.toBeUndefined();
});

test("pre-delivery native guard rejects wrong live process immediately", async () => {
  let waits = 0;
  await expect(requireClaudeNativeSessionBeforeDelivery("native-target", {
    observe: async () => ({ sessionId: "wrong-live-session" }),
    wait: async () => { waits += 1; },
  })).rejects.toThrow("no task was sent");
  expect(waits).toBe(0);
});

test("pre-delivery native guard bounds absent evidence and never authorizes delivery", async () => {
  let observations = 0;
  let waits = 0;
  await expect(requireClaudeNativeSessionBeforeDelivery("native-target", {
    observe: async () => { observations += 1; return null; },
    wait: async () => { waits += 1; },
    attempts: 3,
  })).rejects.toThrow("no verified live process");
  expect(observations).toBe(3);
  expect(waits).toBe(2);
});

test("pre-delivery native guard allows startup evidence to arrive before sending", async () => {
  let observations = 0;
  await expect(requireClaudeNativeSessionBeforeDelivery("native-target", {
    observe: async () => ++observations === 2 ? { sessionId: "native-target" } : null,
    wait: async () => {},
    attempts: 3,
  })).resolves.toBeUndefined();
  expect(observations).toBe(2);
});


test("all exact native tmux targets require the final identity guard", () => {
  const endpoint = { id: "endpoint", sessionId: "scout-session", transport: "tmux", harness: "claude", metadata: { tmuxSession: "pane-session" } } as AgentEndpoint;
  expect(exactClaudeNativeSessionForDelivery(endpoint, { execution: { targetSessionId: "native-target" } } as InvocationRequest)).toBe("native-target");
  expect(exactClaudeNativeSessionForDelivery(endpoint, { metadata: { targetSessionId: "metadata-native" } } as InvocationRequest)).toBe("metadata-native");
  for (const targetSessionId of ["endpoint", "scout-session", "pane-session"]) {
    expect(exactClaudeNativeSessionForDelivery(endpoint, { execution: { targetSessionId } } as InvocationRequest)).toBeNull();
  }
  expect(exactClaudeNativeSessionForDelivery({ ...endpoint, metadata: { flatDispatch: true, externalSessionId: "flat-native" } }, { execution: { targetSessionId: "scout-session" } } as InvocationRequest)).toBe("flat-native");
});
