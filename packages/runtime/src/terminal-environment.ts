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
 * Pane identity a terminal multiplexer exports to everything running inside
 * one of its panes.
 *
 * Same class of leak as the Claude markers, one layer down. A Scout process
 * started from a herdr pane (or a tmux/zellij one) carries that pane's
 * identity for its whole life, and hands it to every terminal it spawns. In a
 * Scout tile that identity is a lie — the tile is a new top-level terminal,
 * not a pane inside the session Scout happened to be launched from — and it
 * breaks two things:
 *
 *   - The multiplexer client refuses to start. herdr answers `nested herdr is
 *     disabled by default` (its `[experimental] allow_nested` guard) and tmux
 *     answers `sessions should be nested with care`, so a session that
 *     attaches fine from any other terminal cannot be attached in a tile.
 *   - An agent in the tile believes it lives in the ORIGINAL pane. herdr's own
 *     skill gates on `HERDR_ENV=1`, so the check passes and the agent then
 *     drives whatever `HERDR_PANE_ID` names — the pane Scout was launched
 *     from, not its own.
 *
 * Scrubbed from the environment handed to a multiplexer CLIENT only. The
 * multiplexer sets these again, correctly, for the pane it creates, which is
 * why {@link buildInteractiveTerminalShellDirectives} — those run INSIDE such
 * a pane — must not unset them.
 *
 * Keep in sync with `ScoutTerminalLaunchCommand` on the macOS side.
 */
export const INHERITED_MULTIPLEXER_PANE_ENV_KEYS = [
  "HERDR_ENV",
  "HERDR_PANE_ID",
  "HERDR_TAB_ID",
  "HERDR_WORKSPACE_ID",
  "HERDR_SOCKET_PATH",
  "HERDR_STARTUP_CWD",
  "TMUX",
  "TMUX_PANE",
  "ZELLIJ",
  "ZELLIJ_SESSION_NAME",
  "ZELLIJ_PANE_ID",
] as const;

/** Every identity a fresh top-level terminal must not inherit. */
export const INHERITED_TERMINAL_IDENTITY_ENV_KEYS = [
  ...INHERITED_CLAUDE_SESSION_ENV_KEYS,
  ...INHERITED_MULTIPLEXER_PANE_ENV_KEYS,
] as const;

/**
 * Build an environment for a fresh interactive terminal process.
 *
 * OpenScout's supervisors may intentionally run with NO_COLOR for their own
 * logs. That setting must not leak into a PTY-backed application: it suppresses
 * the application's ANSI output before a terminal client ever sees it. Harness
 * identity from a parent Claude process must not leak across this boundary
 * either, nor pane identity from a multiplexer Scout was launched inside: the
 * terminal is a new top-level environment, not a Claude child and not a pane.
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
  for (const key of INHERITED_TERMINAL_IDENTITY_ENV_KEYS) {
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
 *
 * Multiplexer pane identity is deliberately NOT unset here: this script runs
 * inside the pane the multiplexer just created, where `TMUX`/`TMUX_PANE`
 * describe the real pane the agent is in. Stripping it is the client-side
 * job — see {@link INHERITED_MULTIPLEXER_PANE_ENV_KEYS}.
 */
export function buildInteractiveTerminalShellDirectives(): string[] {
  return [
    "unset NO_COLOR",
    `unset ${INHERITED_CLAUDE_SESSION_ENV_KEYS.join(" ")}`,
    'export COLORTERM="${COLORTERM:-truecolor}"',
    'export FORCE_COLOR="${FORCE_COLOR:-1}"',
  ];
}
