import { describe, expect, test } from "bun:test";

import {
  buildInteractiveTerminalEnvironment,
  buildInteractiveTerminalShellDirectives,
  INHERITED_CLAUDE_SESSION_ENV_KEYS,
} from "./terminal-environment.js";

describe("buildInteractiveTerminalEnvironment", () => {
  test("does not leak supervisor no-color policy into an interactive PTY", () => {
    const env = buildInteractiveTerminalEnvironment({
      PATH: "/usr/bin",
      NO_COLOR: "1",
    });

    expect(env).toMatchObject({
      PATH: "/usr/bin",
      COLORTERM: "truecolor",
      FORCE_COLOR: "1",
    });
    expect(env.NO_COLOR).toBeUndefined();
  });

  test("preserves explicit interactive color capabilities", () => {
    const env = buildInteractiveTerminalEnvironment(
      { COLORTERM: "24bit", FORCE_COLOR: "2", NO_COLOR: "1" },
      { TERM: "xterm-256color" },
    );

    expect(env).toMatchObject({
      TERM: "xterm-256color",
      COLORTERM: "24bit",
      FORCE_COLOR: "2",
    });
    expect(env.NO_COLOR).toBeUndefined();
  });

  test("does not leak parent Claude session identity into a fresh terminal", () => {
    const inherited = Object.fromEntries(
      INHERITED_CLAUDE_SESSION_ENV_KEYS.map((key) => [key, "inherited"]),
    );
    const env = buildInteractiveTerminalEnvironment({
      PATH: "/usr/bin",
      ...inherited,
      CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1",
    });

    for (const key of INHERITED_CLAUDE_SESSION_ENV_KEYS) {
      expect(env[key]).toBeUndefined();
    }
    // Only the parent-session markers go; deliberate configuration stays.
    expect(env.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE).toBe("1");
  });
});

describe("buildInteractiveTerminalShellDirectives", () => {
  test("removes an inherited color opt-out and preserves explicit capabilities", () => {
    expect(buildInteractiveTerminalShellDirectives()).toEqual([
      "unset NO_COLOR",
      `unset ${INHERITED_CLAUDE_SESSION_ENV_KEYS.join(" ")}`,
      'export COLORTERM="${COLORTERM:-truecolor}"',
      'export FORCE_COLOR="${FORCE_COLOR:-1}"',
    ]);
  });
});
