import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import { buildHarnessResumeCommand, findHarnessEntry } from "@openscout/runtime/harness-catalog";
import { SQLiteControlPlaneStore } from "@openscout/runtime";
import type {
  TerminalBackend,
  TerminalSessionRecord,
  TerminalSurface,
} from "@openscout/protocol";

import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";
import { readCliInputFile } from "../input-file.ts";
import { readScoutWebJson } from "../web-api.ts";

const SESSION_HELP = `scout session — actions on a harness session

Usage:
  scout session intake --harness <name> --session <id> [--project <path>]
  scout session intake <harness> <session-id> [--project <path>]
  scout session handoff ...                 Alias for session intake
  scout session onboard ...                 Alias for session intake
  scout session list [--harness <name>] [--backend tmux|zellij]
  scout session fork <session-id> [prompt]   Fork a recorded session into a new one
  scout session fork --last [prompt]         Fork the most recent recorded session
  scout session touched <session-id>         Show files observed in a session

Options (intake):
  --harness <name>      Harness that owns the source session (claude, codex, pi)
  --session <id>        Harness-native session id to resume
  --backend <name>      Terminal backend/substrate: tmux or zellij (default: tmux)
  --project <path>      Project/cwd for the resumed session (default: cwd)
  --cwd <path>          Alias for --project
  --name <name>         Explicit terminal session name (default: deterministic scout-* name)
  --dry-run             Print the intake plan without creating terminal state
  --attach              Attach to the terminal session after creating/reusing it

Options (fork):
  --last                Fork the most recent session instead of naming an id
  --prompt-file <path>  Read the kickoff prompt from a file
  --all                 With no id, widen the picker beyond the current directory

Intake gives an existing harness session a Scout-owned terminal home. It creates
or reuses a deterministic terminal backend session and starts the harness-native
resume command inside it, so a web/native terminal can attach by session name.

Fork branches a session's context into a fresh run and leaves the original
untouched — hand the fork a prompt and it starts there with the full context
already loaded. It wraps the harness-native fork (today: codex fork) and opens
the forked session interactively. Deterministic when you pass an explicit
<session-id> (a codex session UUID).`;

export async function runSessionCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  const action = args[0];
  if (!action || action === "help" || action === "--help" || action === "-h") {
    context.output.writeText(SESSION_HELP);
    return;
  }

  switch (action) {
    case "intake":
    case "handoff":
    case "onboard":
      await runSessionIntakeAction(context, args.slice(1));
      return;
    case "list":
    case "ls":
      await runSessionListAction(context, args.slice(1));
      return;
    case "fork":
      await runSessionForkAction(context, args.slice(1));
      return;
    case "touched":
    case "touches":
      await runSessionTouchedAction(context, args.slice(1));
      return;
    default:
      throw new ScoutCliError(
        `unknown session action: ${action} (try: scout session intake|list|fork|touched <session-id>)`,
      );
  }
}

type SessionIntakePayload = {
  ok: true;
  action: "session_intake";
  harness: string;
  backend: TerminalBackend;
  sourceSessionId: string;
  terminalSession: string;
  terminalSurface: TerminalSurface;
  tmuxSession?: string;
  zellijSession?: string;
  zellijPaneId?: string | null;
  cwd: string;
  resumeCommand: string;
  created: boolean;
  dryRun: boolean;
  registered: boolean;
  terminalSessionRecord?: TerminalSessionRecord;
  attachCommand: string;
  observeCommand: string | null;
  relay: TerminalSurface["relay"];
};

type SessionListPayload = {
  ok: true;
  action: "session_list";
  count: number;
  sessions: TerminalSessionRecord[];
};

type SessionTouchedPayload = {
  refId: string | null;
  agentId: string | null;
  sessionId: string | null;
  worktreePath: string | null;
  counts: { files: number; changedFiles: number; readFiles: number };
  files: Array<{ path: string; state: string; touches: number }>;
};

async function runSessionTouchedAction(context: ScoutCommandContext, args: string[]): Promise<void> {
  const refId = args.find((arg) => arg !== "--help" && arg !== "-h");
  if (!refId || args.includes("--help") || args.includes("-h")) {
    context.output.writeText(SESSION_HELP);
    return;
  }
  const payload = await readScoutWebJson<SessionTouchedPayload>(
    context,
    `/api/session-ref/${encodeURIComponent(refId)}/touched`,
  );
  context.output.writeValue(payload, renderTouchedFiles);
}

function renderTouchedFiles(payload: SessionTouchedPayload): string {
  const lines = [
    `session ${payload.refId ?? payload.sessionId ?? "(unknown)"}`,
    `worktree ${payload.worktreePath ?? "(unknown)"}`,
    `${payload.counts.changedFiles} changed · ${payload.counts.readFiles} read · ${payload.counts.files} touched`,
  ];
  for (const file of payload.files) {
    lines.push(`${file.state.padEnd(8)} ${file.path} ×${file.touches}`);
  }
  return lines.join("\n");
}

async function runSessionIntakeAction(context: ScoutCommandContext, args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    context.output.writeText(SESSION_HELP);
    return;
  }

  const options = parseSessionIntakeOptions(context, args);
  const harnessEntry = findHarnessEntry(options.harness);
  if (!harnessEntry) {
    throw new ScoutCliError(`unknown harness for session intake: ${options.harness}`);
  }

  const resumeCommand = buildHarnessResumeCommand(harnessEntry, options.sessionId, options.cwd);
  if (!resumeCommand) {
    throw new ScoutCliError(
      `harness "${options.harness}" does not advertise a resume command, so Scout cannot intake it yet`,
    );
  }

  const terminalSession = options.terminalSession ?? defaultTerminalSessionName({
    backend: options.backend,
    harness: options.harness,
    cwd: options.cwd,
    sessionId: options.sessionId,
  });
  validateTerminalSessionName(terminalSession);

  let created = false;
  let paneId: string | null = null;
  if (!options.dryRun) {
    const result = materializeTerminalSurface(context, {
      backend: options.backend,
      sessionName: terminalSession,
      cwd: options.cwd,
      resumeCommand,
      paneName: harnessEntry.name,
    });
    created = result.created;
    paneId = result.paneId;
  }

  const terminalSurface = buildTerminalSurfacePayload({
    backend: options.backend,
    sessionName: terminalSession,
    paneId,
    zellijSocketDir: options.backend === "zellij" ? resolveZellijSocketDir(context) : undefined,
  });
  const terminalSessionRecord = options.dryRun
    ? undefined
    : registerTerminalSessionIntake(context, {
        harness: harnessEntry.name,
        sourceSessionId: options.sessionId,
        cwd: options.cwd,
        resumeCommand,
        surface: {
          ...terminalSurface,
          state: "live",
        },
      });
  const payload: SessionIntakePayload = {
    ok: true,
    action: "session_intake",
    harness: harnessEntry.name,
    backend: options.backend,
    sourceSessionId: options.sessionId,
    terminalSession,
    terminalSurface,
    ...(options.backend === "tmux" ? { tmuxSession: terminalSession } : {}),
    ...(options.backend === "zellij" ? { zellijSession: terminalSession, zellijPaneId: paneId } : {}),
    cwd: options.cwd,
    resumeCommand,
    created,
    dryRun: options.dryRun,
    registered: Boolean(terminalSessionRecord),
    ...(terminalSessionRecord ? { terminalSessionRecord } : {}),
    attachCommand: terminalSurface.attachCommand.map(quoteForShell).join(" "),
    observeCommand: terminalSurface.observeCommand?.map(quoteForShell).join(" ") ?? null,
    relay: terminalSurface.relay,
  };

  context.output.writeValue(payload, renderSessionIntake);

  if (options.attach && !options.dryRun) {
    attachTerminalSurface(context, {
      backend: options.backend,
      sessionName: terminalSession,
    });
  }
}

async function runSessionListAction(context: ScoutCommandContext, args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    context.output.writeText(SESSION_HELP);
    return;
  }

  let harness: string | undefined;
  let backend: TerminalBackend | undefined;
  let limit = 100;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--harness" || arg.startsWith("--harness=")) {
      const parsed = readOptionValue(args, index, "--harness");
      harness = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (arg === "--backend" || arg.startsWith("--backend=")) {
      const parsed = readOptionValue(args, index, "--backend");
      backend = parseTerminalBackend(parsed.value);
      index = parsed.nextIndex;
      continue;
    }
    if (arg === "--limit" || arg.startsWith("--limit=")) {
      const parsed = readOptionValue(args, index, "--limit");
      const parsedLimit = Number.parseInt(parsed.value, 10);
      if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
        throw new ScoutCliError(`invalid --limit value: ${parsed.value}`);
      }
      limit = Math.min(1000, Math.floor(parsedLimit));
      index = parsed.nextIndex;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new ScoutCliError(`unknown option for session list: ${arg}`);
    }
    throw new ScoutCliError(`unexpected argument for session list: ${arg}`);
  }

  const store = openTerminalSessionStore(context);
  try {
    const sessions = store.listTerminalSessions({
      ...(harness ? { harness } : {}),
      ...(backend ? { backend } : {}),
      limit,
    });
    context.output.writeValue({
      ok: true,
      action: "session_list",
      count: sessions.length,
      sessions,
    } satisfies SessionListPayload, renderSessionList);
  } finally {
    store.close();
  }
}

type SessionIntakeOptions = {
  harness: string;
  sessionId: string;
  backend: TerminalBackend;
  cwd: string;
  terminalSession?: string;
  dryRun: boolean;
  attach: boolean;
};

function parseSessionIntakeOptions(context: ScoutCommandContext, args: string[]): SessionIntakeOptions {
  let harness: string | undefined;
  let sessionId: string | undefined;
  let backend: TerminalBackend = "tmux";
  let projectPath: string | undefined;
  let terminalSession: string | undefined;
  let dryRun = false;
  let attach = false;
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--attach") {
      attach = true;
      continue;
    }

    if (arg === "--harness" || arg.startsWith("--harness=")) {
      const parsed = readOptionValue(args, index, "--harness");
      harness = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (arg === "--session" || arg.startsWith("--session=") || arg === "--session-id" || arg.startsWith("--session-id=")) {
      const flag = arg.startsWith("--session-id") ? "--session-id" : "--session";
      const parsed = readOptionValue(args, index, flag);
      sessionId = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (arg === "--backend" || arg.startsWith("--backend=") || arg === "--terminal-backend" || arg.startsWith("--terminal-backend=")) {
      const flag = arg.startsWith("--terminal-backend") ? "--terminal-backend" : "--backend";
      const parsed = readOptionValue(args, index, flag);
      backend = parseTerminalBackend(parsed.value);
      index = parsed.nextIndex;
      continue;
    }
    if (arg === "--project" || arg.startsWith("--project=") || arg === "--cwd" || arg.startsWith("--cwd=")) {
      const flag = arg.startsWith("--cwd") ? "--cwd" : "--project";
      const parsed = readOptionValue(args, index, flag);
      projectPath = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (arg === "--name" || arg.startsWith("--name=") || arg === "--tmux" || arg.startsWith("--tmux=")) {
      const flag = arg.startsWith("--tmux") ? "--tmux" : "--name";
      const parsed = readOptionValue(args, index, flag);
      terminalSession = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new ScoutCliError(`unknown option for session intake: ${arg}`);
    }

    positionals.push(arg);
  }

  if (!harness) {
    harness = positionals.shift();
  }
  if (!sessionId) {
    sessionId = positionals.shift();
  }
  if (positionals.length > 0) {
    throw new ScoutCliError(`unexpected arguments for session intake: ${positionals.join(" ")}`);
  }
  if (!harness) {
    throw new ScoutCliError("session intake needs --harness <name> (or: scout session intake <harness> <session-id>)");
  }
  if (!sessionId) {
    throw new ScoutCliError("session intake needs --session <id> (or: scout session intake <harness> <session-id>)");
  }

  return {
    harness,
    sessionId,
    backend,
    cwd: resolveProjectPath(context, projectPath),
    terminalSession,
    dryRun,
    attach,
  };
}

function parseTerminalBackend(value: string): TerminalBackend {
  const normalized = value.trim().toLowerCase();
  if (normalized === "tmux" || normalized === "zellij") {
    return normalized;
  }
  throw new ScoutCliError(`unknown terminal backend: ${value} (expected tmux or zellij)`);
}

function readOptionValue(args: string[], index: number, flag: string): { value: string; nextIndex: number } {
  const current = args[index] ?? "";
  if (current === flag) {
    const value = args[index + 1];
    if (!value) {
      throw new ScoutCliError(`missing value for ${flag}`);
    }
    return { value, nextIndex: index + 1 };
  }

  const prefix = `${flag}=`;
  if (current.startsWith(prefix)) {
    const value = current.slice(prefix.length);
    if (!value) {
      throw new ScoutCliError(`missing value for ${flag}`);
    }
    return { value, nextIndex: index };
  }

  throw new ScoutCliError(`missing value for ${flag}`);
}

function resolveProjectPath(context: ScoutCommandContext, projectPath?: string): string {
  const rawPath = projectPath?.trim() || context.cwd;
  const expanded = rawPath === "~"
    ? context.env.HOME?.trim() || homedir()
    : rawPath.startsWith("~/")
      ? resolve(context.env.HOME?.trim() || homedir(), rawPath.slice(2))
      : rawPath;
  return resolve(context.cwd, expanded);
}

function resolveControlPlaneDbPath(context: ScoutCommandContext): string {
  const explicitPath = context.env.OPENSCOUT_CONTROL_PLANE_DB?.trim();
  if (explicitPath) {
    return explicitPath;
  }

  const controlHome = context.env.OPENSCOUT_CONTROL_HOME?.trim()
    || join(context.env.HOME?.trim() || homedir(), ".openscout", "control-plane");
  return join(controlHome, "control-plane.sqlite");
}

function openTerminalSessionStore(context: ScoutCommandContext): SQLiteControlPlaneStore {
  return new SQLiteControlPlaneStore(resolveControlPlaneDbPath(context));
}

function registerTerminalSessionIntake(
  context: ScoutCommandContext,
  input: {
    harness: string;
    sourceSessionId: string;
    cwd: string;
    resumeCommand: string;
    surface: TerminalSurface;
  },
): TerminalSessionRecord {
  const store = openTerminalSessionStore(context);
  try {
    const existing = store.listTerminalSessions({
      harness: input.harness,
      sourceSessionId: input.sourceSessionId,
      limit: 1,
    })[0];
    return store.upsertTerminalSession({
      ...(existing ? { id: existing.id } : {}),
      harness: input.harness,
      sourceSessionId: input.sourceSessionId,
      cwd: input.cwd,
      resumeCommand: input.resumeCommand,
      surfaces: mergeTerminalSurfaces(existing?.surfaces ?? [], input.surface),
      metadata: {
        ...(existing?.metadata ?? {}),
        source: "scout-cli",
        updatedBy: "session_intake",
      },
    });
  } finally {
    store.close();
  }
}

export function mergeTerminalSurfaces(
  existing: readonly TerminalSurface[],
  next: TerminalSurface,
): TerminalSurface[] {
  const key = terminalSurfaceKey(next);
  let replaced = false;
  const merged = existing.map((surface) => {
    if (terminalSurfaceKey(surface) !== key) {
      return surface;
    }
    replaced = true;
    return {
      ...surface,
      ...next,
      paneId: next.paneId ?? surface.paneId,
      state: next.state ?? surface.state,
      socketDir: next.socketDir ?? surface.socketDir,
      relay: {
        ...surface.relay,
        ...next.relay,
      },
    };
  });
  if (!replaced) {
    merged.push(next);
  }
  return merged;
}

function terminalSurfaceKey(surface: Pick<TerminalSurface, "backend" | "sessionName">): string {
  return `${surface.backend}:${surface.sessionName}`;
}

function defaultTerminalSessionName(input: { backend: TerminalBackend; harness: string; cwd: string; sessionId: string }): string {
  const projectName = sanitizeTerminalSessionNamePart(basename(input.cwd) || "workspace", 28);
  const harnessName = sanitizeTerminalSessionNamePart(input.harness, 18);
  const fingerprint = createHash("sha1")
    .update(`${input.backend}\0${input.harness}\0${input.cwd}\0${input.sessionId}`)
    .digest("hex")
    .slice(0, 10);
  return `scout-${harnessName}-${projectName}-${fingerprint}`;
}

function sanitizeTerminalSessionNamePart(value: string, maxLength: number): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return (sanitized || "session").slice(0, maxLength);
}

function validateTerminalSessionName(sessionName: string): void {
  if (!/^[A-Za-z0-9_.-]+$/u.test(sessionName)) {
    throw new ScoutCliError(
      `invalid terminal session name "${sessionName}" — use letters, numbers, ".", "_", or "-"`,
    );
  }
}

function materializeTerminalSurface(
  context: ScoutCommandContext,
  input: {
    backend: TerminalBackend;
    sessionName: string;
    cwd: string;
    resumeCommand: string;
    paneName: string;
  },
): { created: boolean; paneId: string | null } {
  if (input.backend === "zellij") {
    return materializeZellijSurface(context, input);
  }
  return materializeTmuxSurface(context, input);
}

function materializeTmuxSurface(
  context: ScoutCommandContext,
  input: { sessionName: string; cwd: string; resumeCommand: string },
): { created: boolean; paneId: string | null } {
  assertTmuxAvailable(context);
  const exists = tmuxSessionExists(context, input.sessionName);
  if (exists) {
    return { created: false, paneId: null };
  }
  createTmuxSession(context, {
    tmuxSession: input.sessionName,
    cwd: input.cwd,
    resumeCommand: input.resumeCommand,
  });
  return { created: true, paneId: null };
}

function materializeZellijSurface(
  context: ScoutCommandContext,
  input: { sessionName: string; cwd: string; resumeCommand: string; paneName: string },
): { created: boolean; paneId: string | null } {
  assertZellijAvailable(context);
  const exists = zellijSessionExists(context, input.sessionName);
  if (exists) {
    return { created: false, paneId: null };
  }

  createZellijSession(context, input.sessionName);
  const paneId = createZellijResumePane(context, input);
  return { created: true, paneId };
}

function assertTmuxAvailable(context: ScoutCommandContext): void {
  const result = spawnSync("tmux", ["-V"], { env: context.env, stdio: "ignore" });
  if (result.error) {
    const detail = (result.error as NodeJS.ErrnoException).code === "ENOENT"
      ? "tmux not found on PATH"
      : result.error.message;
    throw new ScoutCliError(`session intake failed: ${detail}`);
  }
  if (typeof result.status === "number" && result.status !== 0) {
    throw new ScoutCliError("session intake failed: tmux is installed but did not respond to `tmux -V`");
  }
}

function assertZellijAvailable(context: ScoutCommandContext): void {
  const result = spawnSync("zellij", ["--version"], { env: zellijEnv(context), stdio: "ignore" });
  if (result.error) {
    const detail = (result.error as NodeJS.ErrnoException).code === "ENOENT"
      ? "zellij not found on PATH"
      : result.error.message;
    throw new ScoutCliError(`session intake failed: ${detail}`);
  }
  if (typeof result.status === "number" && result.status !== 0) {
    throw new ScoutCliError("session intake failed: zellij is installed but did not respond to `zellij --version`");
  }
}

function resolveZellijSocketDir(context: ScoutCommandContext): string {
  const configured = context.env.ZELLIJ_SOCKET_DIR?.trim() || context.env.OPENSCOUT_ZELLIJ_SOCKET_DIR?.trim();
  return configured || join(context.env.HOME?.trim() || homedir(), ".openscout", "zellij-sockets");
}

function zellijEnv(context: ScoutCommandContext): NodeJS.ProcessEnv {
  const socketDir = resolveZellijSocketDir(context);
  try {
    mkdirSync(socketDir, { recursive: true });
  } catch {
    return context.env;
  }
  return {
    ...context.env,
    ZELLIJ_SOCKET_DIR: socketDir,
  };
}

function tmuxSessionExists(context: ScoutCommandContext, tmuxSession: string): boolean {
  const result = spawnSync("tmux", ["has-session", "-t", tmuxSession], { env: context.env, stdio: "ignore" });
  return result.status === 0;
}

function zellijSessionExists(context: ScoutCommandContext, sessionName: string): boolean {
  const result = spawnSync("zellij", ["list-sessions"], {
    env: zellijEnv(context),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error || typeof result.stdout !== "string") {
    return false;
  }
  return parseZellijSessionList(result.stdout)
    .some((name) => name === sessionName);
}

export function parseZellijSessionList(output: string): string[] {
  return stripAnsi(output)
    .split(/\r?\n/gu)
    .map((line) => line.trim().split(/\s+/u)[0])
    .filter((name): name is string => Boolean(name));
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "");
}

function createTmuxSession(
  context: ScoutCommandContext,
  input: { tmuxSession: string; cwd: string; resumeCommand: string },
): void {
  const result = spawnSync("tmux", [
    "new-session",
    "-d",
    "-s",
    input.tmuxSession,
    "-c",
    input.cwd,
    input.resumeCommand,
  ], {
    env: context.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    throw new ScoutCliError(`session intake failed to create tmux session: ${result.error.message}`);
  }
  if (typeof result.status === "number" && result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || `tmux exited with status ${result.status}`;
    throw new ScoutCliError(`session intake failed to create tmux session: ${detail}`);
  }
}

function createZellijSession(context: ScoutCommandContext, sessionName: string): void {
  const result = spawnSync("zellij", ["attach", "--create-background", sessionName], {
    env: zellijEnv(context),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    throw new ScoutCliError(`session intake failed to create zellij session: ${result.error.message}`);
  }
  if (typeof result.status === "number" && result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || `zellij exited with status ${result.status}`;
    throw new ScoutCliError(`session intake failed to create zellij session: ${detail}`);
  }
}

function createZellijResumePane(
  context: ScoutCommandContext,
  input: { sessionName: string; cwd: string; resumeCommand: string; paneName: string },
): string | null {
  const result = spawnSync("zellij", [
    "--session",
    input.sessionName,
    "action",
    "new-pane",
    "--cwd",
    input.cwd,
    "--name",
    input.paneName,
    "--",
    "sh",
    "-lc",
    input.resumeCommand,
  ], {
    env: zellijEnv(context),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    throw new ScoutCliError(`session intake failed to create zellij pane: ${result.error.message}`);
  }
  if (typeof result.status === "number" && result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || `zellij exited with status ${result.status}`;
    throw new ScoutCliError(`session intake failed to create zellij pane: ${detail}`);
  }

  const paneId = result.stdout?.trim();
  return paneId && /^[A-Za-z0-9_:-]+$/u.test(paneId) ? paneId : null;
}

function buildTerminalSurfacePayload(input: {
  backend: TerminalBackend;
  sessionName: string;
  paneId: string | null;
  zellijSocketDir?: string;
}): TerminalSurface {
  if (input.backend === "zellij") {
    const zellijCommandPrefix = input.zellijSocketDir
      ? ["env", `ZELLIJ_SOCKET_DIR=${input.zellijSocketDir}`, "zellij"]
      : ["zellij"];
    return {
      backend: "zellij",
      sessionName: input.sessionName,
      paneId: input.paneId,
      attachCommand: [...zellijCommandPrefix, "attach", input.sessionName],
      observeCommand: [...zellijCommandPrefix, "watch", input.sessionName],
      relay: {
        backend: "zellij",
        sessionName: input.sessionName,
        zellijSession: input.sessionName,
        ...(input.paneId ? { zellijPaneId: input.paneId } : {}),
      },
      ...(input.zellijSocketDir ? { socketDir: input.zellijSocketDir } : {}),
    };
  }

  return {
    backend: "tmux",
    sessionName: input.sessionName,
    paneId: null,
    attachCommand: ["tmux", "attach", "-t", input.sessionName],
    observeCommand: null,
    relay: {
      backend: "tmux",
      sessionName: input.sessionName,
      tmuxSession: input.sessionName,
    },
  };
}

function attachTerminalSurface(
  context: ScoutCommandContext,
  input: { backend: TerminalBackend; sessionName: string },
): void {
  if (input.backend === "zellij") {
    attachZellijSession(context, input.sessionName);
    return;
  }
  attachTmuxSession(context, input.sessionName);
}

function attachTmuxSession(context: ScoutCommandContext, tmuxSession: string): void {
  const result = spawnSync("tmux", ["attach", "-t", tmuxSession], { env: context.env, stdio: "inherit" });
  if (result.error) {
    throw new ScoutCliError(`session intake failed to attach tmux session: ${result.error.message}`);
  }
  if (typeof result.status === "number" && result.status !== 0) {
    process.exitCode = result.status;
  }
}

function attachZellijSession(context: ScoutCommandContext, sessionName: string): void {
  const result = spawnSync("zellij", ["attach", sessionName], { env: zellijEnv(context), stdio: "inherit" });
  if (result.error) {
    throw new ScoutCliError(`session intake failed to attach zellij session: ${result.error.message}`);
  }
  if (typeof result.status === "number" && result.status !== 0) {
    process.exitCode = result.status;
  }
}

function renderSessionIntake(payload: SessionIntakePayload): string {
  const createdText = payload.dryRun
    ? "planned"
    : payload.created
      ? "created"
      : "reused";
  return [
    `session intake ${createdText}`,
    `harness ${payload.harness}`,
    `backend ${payload.backend}`,
    `source session ${payload.sourceSessionId}`,
    `terminal session ${payload.terminalSession}`,
    ...(payload.zellijPaneId ? [`pane ${payload.zellijPaneId}`] : []),
    `cwd ${payload.cwd}`,
    `resume ${payload.resumeCommand}`,
    ...(payload.registered && payload.terminalSessionRecord ? [`registered ${payload.terminalSessionRecord.id}`] : []),
    `attach ${payload.attachCommand}`,
    ...(payload.observeCommand ? [`observe ${payload.observeCommand}`] : []),
    `relay backend=${payload.relay.backend} sessionName=${payload.relay.sessionName}`,
  ].join("\n");
}

function renderSessionList(payload: SessionListPayload): string {
  if (payload.sessions.length === 0) {
    return "No terminal sessions registered.";
  }

  const lines = [`${payload.count} terminal session${payload.count === 1 ? "" : "s"}`];
  for (const session of payload.sessions) {
    const surfaces = session.surfaces.length === 0
      ? "no surfaces"
      : session.surfaces
        .map((surface) => `${surface.backend}:${surface.sessionName}${surface.state ? `:${surface.state}` : ""}`)
        .join(", ");
    lines.push(`${session.harness} ${session.sourceSessionId} -> ${surfaces}`);
  }
  return lines.join("\n");
}

async function runSessionForkAction(context: ScoutCommandContext, args: string[]): Promise<void> {
  let last = false;
  let all = false;
  let promptFile: string | undefined;
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--last") {
      last = true;
    } else if (arg === "--all") {
      all = true;
    } else if (arg === "--prompt-file") {
      promptFile = args[index + 1];
      index += 1;
      if (!promptFile) {
        throw new ScoutCliError("--prompt-file needs a path");
      }
    } else if (arg === "--help" || arg === "-h") {
      context.output.writeText(SESSION_HELP);
      return;
    } else if (arg.startsWith("--")) {
      throw new ScoutCliError(`unknown option for session fork: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  // First positional is the session id (unless --last); the rest form the inline prompt.
  let sessionId: string | undefined;
  if (!last) {
    sessionId = positionals.shift();
    if (!sessionId) {
      throw new ScoutCliError(
        "session fork needs a <session-id> (or --last) — e.g. scout session fork <codex-session-uuid>",
      );
    }
  }

  const inlinePrompt = positionals.join(" ").trim();
  const prompt = promptFile ? await readCliInputFile(promptFile, "prompt") : inlinePrompt;

  // codex fork [--last] [--all] [<SESSION_ID>] [<PROMPT>]
  const codexArgs = ["fork"];
  if (last) codexArgs.push("--last");
  if (all) codexArgs.push("--all");
  if (sessionId) codexArgs.push(sessionId);
  if (prompt) codexArgs.push(prompt);

  context.stderr(`forking via codex: codex ${codexArgs.map(quoteForLog).join(" ")}`);

  // Inherit stdio: the forked session is interactive (a TUI), and lands the
  // operator straight in it. The source session is never modified.
  const result = spawnSync("codex", codexArgs, { stdio: "inherit", env: context.env });
  if (result.error) {
    const detail =
      (result.error as NodeJS.ErrnoException).code === "ENOENT"
        ? "codex CLI not found on PATH — install Codex, or run the fork on the machine that owns the session"
        : result.error.message;
    throw new ScoutCliError(`session fork failed: ${detail}`);
  }
  if (typeof result.status === "number" && result.status !== 0) {
    process.exitCode = result.status;
  }
}

function quoteForLog(value: string): string {
  return /\s/.test(value) ? JSON.stringify(value) : value;
}

function quoteForShell(value: string): string {
  if (/^[A-Za-z0-9_./:+=@%-]+$/u.test(value)) {
    return value;
  }
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}
