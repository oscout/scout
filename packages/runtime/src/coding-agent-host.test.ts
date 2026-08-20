import { describe, expect, test } from "bun:test";

import { detectCodingAgentHost, isCodingAgentHost } from "./coding-agent-host.js";

describe("detectCodingAgentHost", () => {
  test("returns null for a plain operator shell", () => {
    expect(detectCodingAgentHost({} as NodeJS.ProcessEnv)).toBeNull();
    expect(isCodingAgentHost({} as NodeJS.ProcessEnv)).toBe(false);
  });

  test("detects Scout-managed and bound-agent sessions", () => {
    expect(detectCodingAgentHost({ OPENSCOUT_AGENT: "openscout.main.mini" } as NodeJS.ProcessEnv)).toEqual({
      harness: "scout",
      signal: "OPENSCOUT_AGENT",
    });
    expect(detectCodingAgentHost({ OPENSCOUT_MANAGED_AGENT: "1" } as NodeJS.ProcessEnv)).toEqual({
      harness: "scout",
      signal: "OPENSCOUT_MANAGED_AGENT",
    });
  });

  test("detects Cursor agent shells", () => {
    expect(detectCodingAgentHost({ CURSOR_AGENT: "1" } as NodeJS.ProcessEnv)).toEqual({
      harness: "cursor",
      signal: "CURSOR_AGENT",
    });
  });

  test("detects Claude Code host and cloud session markers", () => {
    expect(detectCodingAgentHost({ CLAUDECODE: "1" } as NodeJS.ProcessEnv)).toEqual({
      harness: "claude",
      signal: "CLAUDECODE",
    });
    expect(detectCodingAgentHost({ CLAUDE_CODE_CHILD_SESSION: "1" } as NodeJS.ProcessEnv)).toEqual({
      harness: "claude",
      signal: "CLAUDE_CODE_CHILD_SESSION",
    });
    expect(detectCodingAgentHost({ CLAUDE_CODE_REMOTE: "true" } as NodeJS.ProcessEnv)).toEqual({
      harness: "claude",
      signal: "CLAUDE_CODE_REMOTE",
    });
    expect(detectCodingAgentHost({ CLAUDE_CODE_SESSION_ID: "sess-2" } as NodeJS.ProcessEnv)).toEqual({
      harness: "claude",
      signal: "CLAUDE_CODE_SESSION_ID",
    });
    expect(detectCodingAgentHost({ CLAUDE_SESSION_ID: "sess-1" } as NodeJS.ProcessEnv)).toEqual({
      harness: "claude",
      signal: "CLAUDE_SESSION_ID",
    });
  });

  test("detects Codex subprocess and integration markers", () => {
    expect(detectCodingAgentHost({ AGENT: "codex" } as NodeJS.ProcessEnv)).toEqual({
      harness: "codex",
      signal: "AGENT",
    });
    expect(detectCodingAgentHost({ CODEX_THREAD_ID: "thread-1" } as NodeJS.ProcessEnv)).toEqual({
      harness: "codex",
      signal: "CODEX_THREAD_ID",
    });
    expect(detectCodingAgentHost({ CODEX_CI: "1" } as NodeJS.ProcessEnv)).toEqual({
      harness: "codex",
      signal: "CODEX_CI",
    });
    expect(detectCodingAgentHost({ CODEX_SANDBOX: "seatbelt" } as NodeJS.ProcessEnv)).toEqual({
      harness: "codex",
      signal: "CODEX_SANDBOX",
    });
  });

  test("prefers Scout binding over vendor flags", () => {
    expect(detectCodingAgentHost({
      OPENSCOUT_AGENT: "openscout.main.mini",
      CURSOR_AGENT: "1",
      CLAUDECODE: "1",
    } as NodeJS.ProcessEnv)).toEqual({
      harness: "scout",
      signal: "OPENSCOUT_AGENT",
    });
  });
});
