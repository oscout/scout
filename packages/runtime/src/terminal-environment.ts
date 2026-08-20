/**
 * Claude exports these markers to commands that run inside an active session.
 * They describe the PARENT harness, not a fresh terminal OpenScout launched,
 * and leaking them can make a new Claude session disable transcript
 * persistence because it believes it is a nested child session.
 *
 * Keep in sync with the macOS terminal launch command.
 */
export const INHERITED_CLAUDE_SESSION_ENV_KEYS = [
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_SESSION_ID",
  "CLAUDE_CODE_REMOTE",
  "CLAUDE_CODE_REMOTE_SESSION_ID",
  "CLAUDE_PID",
] as const;

/**
 * Build an environment for a fresh interactive terminal process.
 *
 * OpenScout's supervisors may intentionally run with NO_COLOR for their own
 * logs. That setting must not leak into a PTY-backed application: it suppresses
 * the application's ANSI output before a terminal client ever sees it. Harness
 * identity from a parent Claude process must not leak across this boundary
 * either: the terminal is a new top-level environment, not a Claude child.
 */
export function buildInteractiveTerminalEnvironment(
  base: NodeJS.ProcessEnv = process.env,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    ...overrides,
    COLORTERM: overrides.COLORTERM || base.COLORTERM || "truecolor",
    FORCE_COLOR: overrides.FORCE_COLOR || base.FORCE_COLOR || "1",
  };
  delete env.NO_COLOR;
  for (const key of INHERITED_CLAUDE_SESSION_ENV_KEYS) {
    delete env[key];
  }
  return env;
}

/**
 * Apply the same interactive color contract inside a managed launch script.
 *
 * A long-lived tmux server keeps its own global environment, so changing the
 * environment of the `tmux new-session` client is not enough to remove an old
 * NO_COLOR value from the process launched in the new pane. These directives
 * establish the contract at the final process boundary while preserving any
 * explicit color capability selected by the user.
 */
export function buildInteractiveTerminalShellDirectives(): string[] {
  return [
    "unset NO_COLOR",
    `unset ${INHERITED_CLAUDE_SESSION_ENV_KEYS.join(" ")}`,
    'export COLORTERM="${COLORTERM:-truecolor}"',
    'export FORCE_COLOR="${FORCE_COLOR:-1}"',
  ];
}
