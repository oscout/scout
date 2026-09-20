import { describe, expect, test } from "bun:test";

import {
  appleScriptEscape,
  attachShellLine,
  identifyLocalTerminalApp,
  preferredLocalTerminalApp,
  shellQuote,
} from "./local-terminal-open.ts";

describe("shellQuote", () => {
  test("passes safe argv through bare", () => {
    expect(shellQuote("tmux")).toBe("tmux");
    expect(shellQuote("session-ms0hf3f7-3ngln1")).toBe("session-ms0hf3f7-3ngln1");
    expect(shellQuote("/Users/art/dev/x")).toBe("/Users/art/dev/x");
  });

  test("single-quotes and escapes the rest", () => {
    expect(shellQuote("my session")).toBe("'my session'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});

describe("appleScriptEscape", () => {
  test("escapes quotes and backslashes for do script", () => {
    expect(appleScriptEscape('say "hi" \\ done')).toBe('say \\"hi\\" \\\\ done');
  });
});

describe("attachShellLine", () => {
  test("joins argv and prepends cd for a real cwd", () => {
    const line = attachShellLine(["tmux", "attach", "-t", "my session"], "/tmp");
    expect(line).toBe("cd /tmp && tmux attach -t 'my session'");
  });

  test("drops a cwd that does not exist", () => {
    const line = attachShellLine(["tmux", "attach", "-t", "s"], "/no/such/dir/at/all");
    expect(line).toBe("tmux attach -t s");
  });
});

describe("identifyLocalTerminalApp", () => {
  test("knows the named apps", () => {
    expect(identifyLocalTerminalApp("/Applications/Ghostty.app")).toBe("ghostty");
    expect(identifyLocalTerminalApp("/Applications/iTerm.app")).toBe("iterm");
    expect(identifyLocalTerminalApp("/System/Applications/Utilities/Terminal.app")).toBe("terminal");
    expect(identifyLocalTerminalApp("/Applications/WezTerm.app")).toBe("unknown");
  });
});

describe("preferredLocalTerminalApp", () => {
  test("env override picks by name when installed", () => {
    // Terminal.app is always present on macOS; the override must select it by name.
    if (process.platform !== "darwin") return;
    const app = preferredLocalTerminalApp({ ...process.env, OPENSCOUT_TERMINAL_APP: "Terminal" });
    expect(app?.kind).toBe("terminal");
  });

  test("a missing configured path does not silently fall back", () => {
    const app = preferredLocalTerminalApp({
      ...process.env,
      OPENSCOUT_TERMINAL_APP: "/Applications/NotARealTerminal.app",
    });
    expect(app).toBeNull();
  });
});
