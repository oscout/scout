#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(scriptDirectory, "..");
const outputPath = resolve(packageDirectory, "server/terminal-relay-session.ts");
const flowOutputPath = resolve(packageDirectory, "server/terminal-relay-flow.ts");
const zellijOutputPath = resolve(packageDirectory, "server/terminal-relay-zellij.ts");
const checkOnly = process.argv.includes("--check");

function safeGit(args, cwd) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
    }).trim() || null;
  } catch {
    return null;
  }
}

function resolveHudsonRelaySource() {
  const configuredSession = process.env.HUDSON_RELAY_SESSION_PATH?.trim();
  const configuredTypes = process.env.HUDSON_RELAY_TYPES_PATH?.trim();
  if (configuredSession && configuredTypes) {
    const sourceRoot = dirname(resolve(configuredSession));
    const flowPath = resolve(sourceRoot, "flow.ts");
    const zellijPath = resolve(sourceRoot, "zellij.ts");
    return {
      sessionPath: resolve(configuredSession),
      typesPath: resolve(configuredTypes),
      flowPath: existsSync(flowPath) ? flowPath : null,
      zellijPath: existsSync(zellijPath) ? zellijPath : null,
    };
  }

  const directHudsonRoot = resolve(packageDirectory, "../../..", "hudson");
  const directSource = resolveHudsonRelaySourceFromRoot(directHudsonRoot);
  if (directSource) return directSource;

  const commonGitDir = safeGit(["rev-parse", "--git-common-dir"], packageDirectory);
  if (!commonGitDir) {
    return null;
  }

  const commonRoot = resolve(packageDirectory, commonGitDir, "..");
  return resolveHudsonRelaySourceFromRoot(resolve(commonRoot, "..", "hudson"));
}

function resolveHudsonRelaySourceFromRoot(hudsonRoot) {
  for (const relayRoot of [
    "packages/services/hudson-relay/src/relay",
    "packages/hudson-relay/src/relay",
  ]) {
    const sourceRoot = resolve(hudsonRoot, relayRoot);
    const sessionPath = resolve(sourceRoot, "session.ts");
    const typesPath = resolve(sourceRoot, "types.ts");
    const flowPath = resolve(sourceRoot, "flow.ts");
    const zellijPath = resolve(sourceRoot, "zellij.ts");
    if (existsSync(sessionPath) && existsSync(typesPath)) {
      return {
        sessionPath,
        typesPath,
        flowPath: existsSync(flowPath) ? flowPath : null,
        zellijPath: existsSync(zellijPath) ? zellijPath : null,
      };
    }
  }
  return null;
}

function stripTypeImport(source) {
  return source
    .replace(/^import type \{ SessionInitMessage, RelaySocket \} from ['"]\.\/types['"];\n\n?/m, "")
    .trim();
}

function buildGeneratedContent(hudsonSource) {
  const typesSource = applyOpenScoutRelayTypeCompatibility(
    readFileSync(hudsonSource.typesPath, "utf8").trim(),
  );
  const sessionSource = rewriteHudsonRelayHelperImports(
    applyOpenScoutRelaySessionCompatibility(stripTypeImport(
      readFileSync(hudsonSource.sessionPath, "utf8"),
    )),
  );

  const banner = [
    "// Generated from Hudson relay session/types.",
    "// Refresh with: node ./scripts/sync-terminal-relay-session.mjs",
    "",
  ].join("\n");

  return `${banner}${typesSource}\n\n${sessionSource}\n`;
}

function generatedHelperBanner(sourceName) {
  return [
    `// Generated from Hudson relay ${sourceName}.`,
    "// Refresh with: node ./scripts/sync-terminal-relay-session.mjs",
    "",
  ].join("\n");
}

function buildGeneratedFlowContent(hudsonSource) {
  if (!hudsonSource.flowPath) return null;
  const source = readFileSync(hudsonSource.flowPath, "utf8")
    .replace(
      /^import type \{ RelaySocket \} from ['"]\.\/types['"];\n\n?/m,
      [
        "/** Minimal WebSocket interface used by terminal relay flow control. */",
        "interface RelaySocket {",
        "  readonly readyState: number;",
        "  send(data: string | Buffer): void;",
        "}",
        "",
      ].join("\n"),
    )
    .trim();
  return `${generatedHelperBanner("flow")}${source}\n`;
}

function buildGeneratedZellijContent(hudsonSource) {
  if (!hudsonSource.zellijPath) return null;
  return `${generatedHelperBanner("zellij")}${readFileSync(hudsonSource.zellijPath, "utf8").trim()}\n`;
}

function rewriteHudsonRelayHelperImports(source) {
  return source
    .replaceAll("from './flow'", "from './terminal-relay-flow'")
    .replaceAll('from "./flow"', 'from "./terminal-relay-flow"')
    .replaceAll("from './zellij'", "from './terminal-relay-zellij'")
    .replaceAll('from "./zellij"', 'from "./terminal-relay-zellij"');
}

function applyOpenScoutRelayTypeCompatibility(source) {
  let next = source;

  if (!next.includes("agent?: 'claude' | 'pi' | 'shell'")) {
    next = next
    .replace(
      "/** CLI agent to spawn. 'claude' (default) or 'pi'. */",
      "/** CLI agent to spawn. 'claude' (default), 'pi', or 'shell'. */",
    )
    .replace("agent?: 'claude' | 'pi';", "agent?: 'claude' | 'pi' | 'shell';");
  }

  if (!next.includes("backend?: 'pty' | 'tmux' | 'zellij'")) {
    next = next
      .replace(
        "/** PTY backend. 'pty' spawns a fresh process (default). 'tmux' attaches to a named tmux session. */",
        "/** PTY backend. 'pty' spawns a fresh process (default). Terminal backends attach to a named surface. */",
      )
      .replace("backend?: 'pty' | 'tmux';", "backend?: 'pty' | 'tmux' | 'zellij';")
      .replace(
        "/** For tmux backend: the tmux session name. Required when backend is 'tmux'. */\n  tmuxSession?: string;",
        "/** Generic terminal surface session name. */\n  terminalSession?: string;\n  /** For tmux backend: the tmux session name. */\n  tmuxSession?: string;\n  /** For zellij backend: the zellij session name. */\n  zellijSession?: string;\n  /** For zellij backend: socket directory to preserve across attach/watch calls. */\n  zellijSocketDir?: string;",
      );
  }

  return next;
}

function applyOpenScoutRelaySessionCompatibility(source) {
  if (source.includes("function findShellBin()")) {
    return applyOpenScoutRelayZellijCompatibility(source);
  }

  const helpers = `function expandHomePath(value: string): string {
  const home = process.env.HOME || '/tmp';
  if (value === '~') return home;
  if (value.startsWith('~/')) return join(home, value.slice(2));
  return value;
}

function isExecutablePath(candidate: string | null | undefined): candidate is string {
  if (!candidate) return false;
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findExecutableInDirectories(name: string, directories: string[]): string | null {
  const seen = new Set<string>();
  for (const directory of directories) {
    if (!directory) continue;
    const normalizedDirectory = pathResolve(expandHomePath(directory));
    if (seen.has(normalizedDirectory)) continue;
    seen.add(normalizedDirectory);
    const candidate = join(normalizedDirectory, name);
    if (isExecutablePath(candidate)) return candidate;
  }
  return null;
}

function findExecutableOnPath(name: string): string | null {
  return findExecutableInDirectories(name, (process.env.PATH || '').split(pathDelimiter));
}`;

  const findClaudeBin = `/** Locate the claude binary, returning null if not found. */
function findClaudeBin(): string | null {
  for (const envKey of ['OPENSCOUT_CLAUDE_BIN', 'SCOUT_CLAUDE_BIN', 'CLAUDE_BIN']) {
    const explicit = process.env[envKey]?.trim();
    if (!explicit) continue;
    const expanded = expandHomePath(explicit);
    if (isExecutablePath(expanded)) return pathResolve(expanded);
    const foundOnPath = findExecutableOnPath(explicit);
    if (foundOnPath) return foundOnPath;
  }

  const home = process.env.HOME || '/tmp';
  return findExecutableInDirectories('claude', [
    join(home, '.local', 'bin'),
    join(home, '.claude', 'local'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(home, '.bun', 'bin'),
  ]) ?? findExecutableOnPath('claude');
}`;

  const findShellBin = `/** Locate the user's shell, returning null if not found. */
function findShellBin(): string | null {
  const candidates = [
    process.env.SHELL,
    '/bin/zsh',
    '/bin/bash',
    '/bin/sh',
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}`;

  const withShellCompatibility = source
    .replace(
      "import { existsSync, mkdirSync, writeFileSync } from 'fs';",
      "import { accessSync, constants, existsSync, mkdirSync, writeFileSync } from 'fs';",
    )
    .replace(
      "import { join, dirname as pathDirname } from 'path';",
      "import { delimiter as pathDelimiter, join, dirname as pathDirname, resolve as pathResolve } from 'path';",
    )
    .replace(
      `/** Locate the claude binary, returning null if not found. */
function findClaudeBin(): string | null {
  return findBin('claude', 'CLAUDE_BIN');
}`,
      `${helpers}\n${findClaudeBin}`,
    )
    .replace(
      `/** Locate the pi binary, returning null if not found. */
function findPiBin(): string | null {
  return findBin('pi', 'PI_BIN');
}`,
      `/** Locate the pi binary, returning null if not found. */
function findPiBin(): string | null {
  return findBin('pi', 'PI_BIN');
}

${findShellBin}`,
    )
    .replace(
      "if (agent === 'pi') {\n    agentBin = findPiBin();",
      "if (agent === 'shell') {\n    agentBin = findShellBin();\n    if (!agentBin) {\n      const reason = 'Shell not found. Set SHELL or install zsh/bash/sh.';\n      console.error(`[relay] Session ${id} failed: ${reason}`);\n      send(ws, { type: 'session:error', error: reason });\n      return null;\n    }\n  } else if (agent === 'pi') {\n    agentBin = findPiBin();",
    )
    .replace(
      "const reason = 'Claude CLI not found. Install it with: npm install -g @anthropic-ai/claude-code';",
      "const reason = 'Claude CLI not found. Install it with: curl -fsSL https://claude.ai/install.sh | bash';",
    )
    .replace(
      "if (agent === 'pi') {\n    agentArgs = ['--verbose'];",
      "if (agent === 'shell') {\n    agentArgs = [];\n  } else if (agent === 'pi') {\n    agentArgs = ['--verbose'];",
    );

  return applyOpenScoutRelayZellijCompatibility(withShellCompatibility);
}

function applyOpenScoutRelayZellijCompatibility(source) {
  if (source.includes("function spawnZellijSession(")) {
    return source;
  }

  const zellijHelpers = `function resolveZellijSocketDir(raw?: string): string {
  const home = process.env.HOME || '/tmp';
  const configured = raw?.trim() || process.env.ZELLIJ_SOCKET_DIR?.trim() || process.env.OPENSCOUT_ZELLIJ_SOCKET_DIR?.trim();
  const candidate = configured || join(home, '.openscout', 'zellij-sockets');
  return candidate === '~' ? home : candidate.startsWith('~/') ? join(home, candidate.slice(2)) : candidate;
}

function zellijEnv(baseEnv: Record<string, string | undefined>, socketDir: string): Record<string, string | undefined> {
  try {
    mkdirSync(socketDir, { recursive: true });
  } catch {}
  return { ...baseEnv, ZELLIJ_SOCKET_DIR: socketDir };
}

/** Check if a zellij session exists. */
function zellijSessionExists(name: string, env: Record<string, string | undefined>): boolean {
  try {
    const output = execFileSync('zellij', ['list-sessions'], {
      env: env as NodeJS.ProcessEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output
      .split(/\\r?\\n/u)
      .map((line) => line.trim().split(/\\s+/u)[0])
      .some((sessionName) => sessionName === name);
  } catch {
    return false;
  }
}

/** Spawn a PTY that attaches to a zellij session (creating it if needed). */
function spawnZellijSession(
  zellijName: string,
  cols: number,
  rows: number,
  cwd: string,
  commandBin: string,
  commandArgs: string[],
  env: Record<string, string | undefined>,
  socketDir: string,
): IPty {
  const effectiveEnv = zellijEnv(env, socketDir);
  const exists = zellijSessionExists(zellijName, effectiveEnv);

  if (!exists) {
    execFileSync('zellij', ['attach', '--create-background', zellijName], {
      env: effectiveEnv as NodeJS.ProcessEnv,
      stdio: 'ignore',
    });
    execFileSync('zellij', [
      '--session',
      zellijName,
      'action',
      'new-pane',
      '--cwd',
      cwd,
      '--',
      commandBin,
      ...commandArgs,
    ], {
      env: effectiveEnv as NodeJS.ProcessEnv,
      stdio: 'ignore',
    });
    console.log(\`[relay] Created zellij session: \${zellijName}\`);
  } else {
    console.log(\`[relay] Attaching to existing zellij session: \${zellijName}\`);
  }

  return pty.spawn('zellij', ['attach', zellijName], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: effectiveEnv,
  });
}`;

  return source
    .replaceAll("backend: 'pty' | 'tmux';", "backend: 'pty' | 'tmux' | 'zellij';")
    .replace(
      "/** tmux session name (only set when backend is 'tmux'). */\n  tmuxSession?: string;",
      "/** Generic terminal surface session name. */\n  terminalSession?: string;\n  /** tmux session name (only set when backend is 'tmux'). */\n  tmuxSession?: string;\n  /** zellij session name (only set when backend is 'zellij'). */\n  zellijSession?: string;\n  /** zellij socket directory (only set when backend is 'zellij'). */\n  zellijSocketDir?: string;",
    )
    .replace(
      `/** Resize the tmux window behind an attached bridge PTY. */
function resizeTmuxWindow(name: string, cols: number, rows: number): boolean {
  try {
    execFileSync('tmux', [
      'resize-window',
      '-t',
      name,
      '-x',
      String(cols),
      '-y',
      String(rows),
    ], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}`,
      `/** Resize the tmux window behind an attached bridge PTY. */
function resizeTmuxWindow(name: string, cols: number, rows: number): boolean {
  try {
    execFileSync('tmux', [
      'resize-window',
      '-t',
      name,
      '-x',
      String(cols),
      '-y',
      String(rows),
    ], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

${zellijHelpers}`,
    )
    .replace(
      "const tmuxName = msg.tmuxSession || `hudson-${id}`;",
      "const terminalName = msg.terminalSession || msg.tmuxSession || msg.zellijSession || `hudson-${id}`;\n  const tmuxName = msg.tmuxSession || terminalName;\n  const zellijName = msg.zellijSession || terminalName;\n  const zellijSocketDir = resolveZellijSocketDir(msg.zellijSocketDir);",
    )
    .replace(
      `// ---- Pre-flight: tmux backend requires tmux ----
  if (backend === 'tmux' && !findBin('tmux')) {
    const reason = 'tmux not found. Install it with: brew install tmux';
    console.error(\`[relay] Session \${id} failed: \${reason}\`);
    send(ws, { type: 'session:error', error: reason });
    return null;
  }`,
      `// ---- Pre-flight: terminal backends require their multiplexer ----
  if (backend === 'tmux' && !findBin('tmux')) {
    const reason = 'tmux not found. Install it with: brew install tmux';
    console.error(\`[relay] Session \${id} failed: \${reason}\`);
    send(ws, { type: 'session:error', error: reason });
    return null;
  }
  if (backend === 'zellij' && !findBin('zellij')) {
    const reason = 'zellij not found. Install it with: brew install zellij';
    console.error(\`[relay] Session \${id} failed: \${reason}\`);
    send(ws, { type: 'session:error', error: reason });
    return null;
  }`,
    )
    .replace(
      `if (backend === 'tmux') {
      console.log(\`[relay] Session \${id}: tmux backend (session: \${tmuxName}) in \${cwd} [agent: \${agent}]\`);
      ptyProcess = spawnTmuxSession(tmuxName, cols, rows, cwd, agentBin, agentArgs, env);
    } else {`,
      `if (backend === 'tmux') {
      console.log(\`[relay] Session \${id}: tmux backend (session: \${tmuxName}) in \${cwd} [agent: \${agent}]\`);
      ptyProcess = spawnTmuxSession(tmuxName, cols, rows, cwd, agentBin, agentArgs, env);
    } else if (backend === 'zellij') {
      console.log(\`[relay] Session \${id}: zellij backend (session: \${zellijName}) in \${cwd} [agent: \${agent}]\`);
      ptyProcess = spawnZellijSession(zellijName, cols, rows, cwd, agentBin, agentArgs, env, zellijSocketDir);
    } else {`,
    )
    .replace(
      "...(backend === 'tmux' ? { tmuxSession: tmuxName } : {}),",
      "...(backend === 'tmux' ? { terminalSession: tmuxName, tmuxSession: tmuxName } : {}),\n    ...(backend === 'zellij' ? { terminalSession: zellijName, zellijSession: zellijName, zellijSocketDir } : {}),",
    )
    .replace(
      `if (session.backend === 'tmux') {
    console.log(\`[relay] Session \${sessionId} bridge destroyed (tmux session '\${session.tmuxSession}' still alive)\`);
  } else {
    console.log(\`[relay] Session \${sessionId} destroyed\`);
  }`,
      `if (session.backend === 'tmux') {
    console.log(\`[relay] Session \${sessionId} bridge destroyed (tmux session '\${session.tmuxSession}' still alive)\`);
  } else if (session.backend === 'zellij') {
    console.log(\`[relay] Session \${sessionId} bridge destroyed (zellij session '\${session.zellijSession}' still alive)\`);
  } else {
    console.log(\`[relay] Session \${sessionId} destroyed\`);
  }`,
    );
}

const hudsonSource = resolveHudsonRelaySource();
if (!hudsonSource) {
  console.log("@openscout/web: Hudson relay source not found; skipping relay sync.");
  process.exit(0);
}

const nextContent = buildGeneratedContent(hudsonSource);
const outputs = [
  { path: outputPath, content: nextContent },
  ...(buildGeneratedFlowContent(hudsonSource)
    ? [{ path: flowOutputPath, content: buildGeneratedFlowContent(hudsonSource) }]
    : []),
  ...(buildGeneratedZellijContent(hudsonSource)
    ? [{ path: zellijOutputPath, content: buildGeneratedZellijContent(hudsonSource) }]
    : []),
];

const OPENSCOUT_LOCAL_OVERLAY_MARKER = "OpenScout local overlay: SCO-078 probe/async discipline";

const dirtyOutputs = outputs.filter((output) => {
  const current = existsSync(output.path) ? readFileSync(output.path, "utf8") : null;
  if (
    checkOnly
    && output.path === outputPath
    && current?.includes(OPENSCOUT_LOCAL_OVERLAY_MARKER)
  ) {
    return false;
  }
  return current !== output.content;
});

if (dirtyOutputs.length === 0) {
  console.log(`Terminal relay session already matches ${hudsonSource.sessionPath}`);
  process.exit(0);
}

if (checkOnly) {
  console.error(
    "@openscout/web: terminal relay session snapshot is out of sync with Hudson.\n"
    + "Run: bun --cwd packages/web relay:sync",
  );
  process.exit(1);
}

for (const output of outputs) {
  writeFileSync(output.path, output.content, "utf8");
}
console.log(`Synced terminal relay session from ${hudsonSource.sessionPath}`);
