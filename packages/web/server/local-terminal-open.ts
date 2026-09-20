/**
 * Open a host attach command in the operator's real terminal app.
 *
 * This is the server-side counterpart of the macOS app's
 * `ScoutTerminalOpener`: same candidate apps, same per-app launch strategy,
 * same "shell line plus optional cd" payload. It exists so every client that
 * can show an agent/session — the web UI, the HUD, anything that can reach the
 * local API — can offer "hop into the real terminal" without re-implementing
 * the per-app incantations.
 *
 * Only macOS knows the launch vocabulary today; other platforms report
 * unsupported and the caller surfaces that honestly instead of pretending.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { execSystemFile } from "@openscout/runtime/system-probes";

export type LocalTerminalAppKind =
  | "terminal"
  | "ghostty"
  | "iterm"
  | "alacritty"
  | "hyper"
  | "unknown";

export type LocalTerminalApp = {
  name: string;
  path: string;
  kind: LocalTerminalAppKind;
};

export type LocalTerminalOpenResult = {
  app: string;
};

/** Ordered exactly like the app: Ghostty wins when nothing is configured. */
const TERMINAL_APP_CANDIDATES: ReadonlyArray<readonly [string, string]> = [
  ["Ghostty", "/Applications/Ghostty.app"],
  ["Ghostty", `${homedir()}/Applications/Ghostty.app`],
  ["iTerm", "/Applications/iTerm.app"],
  ["iTerm", `${homedir()}/Applications/iTerm.app`],
  ["Alacritty", "/Applications/Alacritty.app"],
  ["Alacritty", `${homedir()}/Applications/Alacritty.app`],
  ["Hyper", "/Applications/Hyper.app"],
  ["Hyper", `${homedir()}/Applications/Hyper.app`],
  ["Terminal", "/System/Applications/Utilities/Terminal.app"],
  ["Terminal", "/Applications/Utilities/Terminal.app"],
];

export function identifyLocalTerminalApp(path: string): LocalTerminalAppKind {
  const name = path.replace(/\.app$/iu, "").split("/").pop()?.toLowerCase() ?? "";
  if (name === "terminal") return "terminal";
  if (name.includes("ghostty")) return "ghostty";
  if (name.includes("iterm")) return "iterm";
  if (name.includes("alacritty")) return "alacritty";
  if (name.includes("hyper")) return "hyper";
  return "unknown";
}

export function listLocalTerminalApps(env: NodeJS.ProcessEnv = process.env): LocalTerminalApp[] {
  const home = env.HOME ?? homedir();
  const seen = new Set<string>();
  const apps: LocalTerminalApp[] = [];
  for (const [name, path] of TERMINAL_APP_CANDIDATES) {
    const resolved = path.replace(homedir(), home);
    if (seen.has(resolved) || !existsSync(resolved)) continue;
    seen.add(resolved);
    apps.push({ name, path: resolved, kind: identifyLocalTerminalApp(resolved) });
  }
  return apps;
}

/**
 * `OPENSCOUT_TERMINAL_APP` pins the hop target app: an absolute `.app` path,
 * or a name matched against the installed candidates (case-insensitive).
 * Without it the first installed candidate wins — Terminal.app always exists
 * on macOS, so the preference list is ordered by intent, not by survival.
 */
export function preferredLocalTerminalApp(env: NodeJS.ProcessEnv = process.env): LocalTerminalApp | null {
  const configured = env.OPENSCOUT_TERMINAL_APP?.trim();
  const installed = listLocalTerminalApps(env);
  if (configured) {
    if (configured.endsWith(".app") && existsSync(configured)) {
      return { name: appNameFromPath(configured), path: configured, kind: identifyLocalTerminalApp(configured) };
    }
    const named = installed.find((app) => app.name.toLowerCase() === configured.toLowerCase());
    if (named) return named;
    // A configured path that is missing or a name nothing installed is a
    // configuration error; falling back silently would open somewhere the
    // operator did not ask for.
    return null;
  }
  return installed[0] ?? null;
}

function appNameFromPath(path: string): string {
  return path.replace(/\.app$/iu, "").split("/").pop() ?? path;
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)) return value;
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

export function appleScriptEscape(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
}

/** The one-line shell payload: `cd <cwd> && <argv>` when cwd is real. */
export function attachShellLine(argv: readonly string[], cwd?: string | null): string {
  const line = argv.map(shellQuote).join(" ");
  const dir = cwd?.trim();
  if (dir && existsSync(dir)) return `cd ${shellQuote(dir)} && ${line}`;
  return line;
}

function terminalAppScript(shellLine: string): string {
  return `tell application "Terminal"
  activate
  do script "${appleScriptEscape(shellLine)}"
end tell`;
}

function itermScript(shellLine: string): string {
  const escaped = appleScriptEscape(shellLine);
  return `tell application "iTerm"
  activate
  if (count of windows) = 0 then
    try
      create window with profile "OpenScout Herd"
    on error
      create window with default profile
    end try
  else
    tell current window
      try
        create tab with profile "OpenScout Herd"
      on error
        create tab with default profile
      end try
    end tell
  end if
  tell current session of current window
    write text "${escaped}"
  end tell
end tell`;
}

/**
 * GUI terminal processes must not be awaited — `execSystemFile` waits for exit
 * and a terminal stays alive for as long as its window is open. Spawn detached
 * and report the spawn event (or the spawn failure) instead.
 */
function spawnDetached(file: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<Error | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, [...args], { env, detached: true, stdio: "ignore" });
    } catch (error) {
      resolve(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    child.once("error", (error: Error) => resolve(error));
    child.once("spawn", () => {
      child.unref();
      resolve(null);
    });
  });
}

async function runAppleScript(source: string, env: NodeJS.ProcessEnv): Promise<void> {
  await execSystemFile("osascript", ["-e", source], { timeoutMs: 5_000, env });
}

/**
 * Open `argv` in the operator's terminal app. `app` overrides selection —
 * callers pass one only when the operator named it. Throws with a reason the
 * endpoint can hand back verbatim.
 */
export async function openLocalTerminalAttach(
  argv: readonly string[],
  options: {
    cwd?: string | null;
    env?: NodeJS.ProcessEnv;
    app?: LocalTerminalApp | null;
    platform?: NodeJS.Platform;
  } = {},
): Promise<LocalTerminalOpenResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    throw new Error("opening a local terminal app is wired for macOS only");
  }
  if (argv.length === 0) {
    throw new Error("the terminal surface has no attach command");
  }
  const env = options.env ?? process.env;
  const app = options.app !== undefined ? options.app : preferredLocalTerminalApp(env);
  if (!app) {
    throw new Error(
      env.OPENSCOUT_TERMINAL_APP?.trim()
        ? `configured terminal app ${env.OPENSCOUT_TERMINAL_APP} is not installed`
        : "no terminal app found",
    );
  }

  const shellLine = attachShellLine(argv, options.cwd);

  switch (app.kind) {
    case "terminal":
      await runAppleScript(terminalAppScript(shellLine), env);
      break;
    case "iterm":
      await runAppleScript(itermScript(shellLine), env);
      break;
    case "ghostty": {
      const shell = env.SHELL?.trim() || "/bin/zsh";
      const failure = await spawnDetached("open", [
        "-na", app.path, "--args", "-e", shell, "-lc", shellLine,
      ], env);
      if (failure) throw failure;
      break;
    }
    case "alacritty": {
      const binary = join(app.path, "Contents", "MacOS", "alacritty");
      const executable = existsSync(binary) ? binary : app.path;
      const cwd = options.cwd?.trim();
      const args: string[] = cwd && existsSync(cwd) ? ["--working-directory", cwd] : [];
      const plainArgv = argv.every((arg) => !arg.includes(" ") && !arg.includes("="));
      if (plainArgv) {
        args.push("-e", ...argv);
      } else {
        const shell = env.SHELL?.trim() || "/bin/zsh";
        args.push("-e", shell, "-lc", shellLine);
      }
      const failure = await spawnDetached(executable, args, env);
      if (failure) throw failure;
      break;
    }
    case "hyper":
    case "unknown":
    default: {
      // No stable "run this command" API: command on the pasteboard, app open.
      await runAppleScript(`set the clipboard to "${appleScriptEscape(shellLine)}"`, env);
      const failure = await spawnDetached("open", ["-a", app.path], env);
      if (failure) throw failure;
      break;
    }
  }

  return { app: app.name };
}
