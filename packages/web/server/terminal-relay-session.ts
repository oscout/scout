// Generated from Hudson relay session/types.
// Refresh with: node ./scripts/sync-terminal-relay-session.mjs
// OpenScout local overlay: SCO-078 probe/async discipline; do not regenerate blindly.
/** Minimal WebSocket interface — satisfied by both `ws` and Bun's ServerWebSocket. */
export interface RelaySocket {
  readonly readyState: number;
  send(data: string | Buffer): void;
}

export interface SessionInitMessage {
  type: 'session:init';
  cols: number;
  rows: number;
  /** Client-supported protocol capabilities, eg. terminal:ack. */
  clientCapabilities?: string[];
  systemPrompt?: string;
  /** Working directory for the PTY session. Defaults to $HOME. */
  cwd?: string;
  /** Files to bootstrap in the CWD before spawning the CLI. Keys are relative paths, values are file contents. Only written if the file doesn't already exist. */
  workspaceFiles?: Record<string, string>;
  /** How long (ms) to keep the PTY alive after the client disconnects. Defaults to 30 min. */
  orphanTTL?: number;
  /** PTY backend. 'pty' spawns a fresh process; 'tmux'/'zellij'/'herdr' attach to named hosts. */
  backend?: 'pty' | 'tmux' | 'zellij' | 'herdr';
  /** Client control intent. Observe is enforced read-only and cannot size the shared terminal. */
  controlMode?: 'owner' | 'takeover' | 'observe';
  /** For tmux backend: the tmux session name. Required when backend is 'tmux'. */
  tmuxSession?: string;
  /** For zellij backend: the zellij session name. */
  zellijSession?: string;
  /** For zellij backend: optional shorter socket directory (useful on macOS). */
  zellijSocketDir?: string;
  /** For herdr backend: the Herdr session name (`default` or named). */
  herdrSession?: string;
  /** Process to spawn. 'claude' (default), 'codex', 'pi', or 'shell' for a normal login shell. */
  agent?: 'claude' | 'codex' | 'pi' | 'shell';
  /** For pi agent: provider name (e.g. 'minimax', 'github-copilot'). */
  provider?: string;
  /** For pi agent: model ID (e.g. 'MiniMax-M1'). */
  model?: string;
}

export interface SessionReconnectMessage {
  type: 'session:reconnect';
  sessionId: string;
  /** Ownership proof issued in session:ready. Reconnects without it are refused. */
  reconnectToken?: string;
  cols?: number;
  rows?: number;
  /** Client-supported protocol capabilities, eg. terminal:ack. */
  clientCapabilities?: string[];
  /** Client control intent. Observe sessions are re-created instead of byte-tail replayed. */
  controlMode?: 'owner' | 'takeover' | 'observe';
}

export interface TerminalInputMessage {
  type: 'terminal:input';
  data: string;
}

export interface TerminalResizeMessage {
  type: 'terminal:resize';
  cols: number;
  rows: number;
}

export interface TerminalAckMessage {
  type: 'terminal:ack';
  seq: number;
}

export type ClientMessage =
  | SessionInitMessage
  | SessionReconnectMessage
  | TerminalInputMessage
  | TerminalResizeMessage
  | TerminalAckMessage;

import { createRequire } from 'module';
import {
  execSystemFile,
  invalidateTmuxSessions,
  invalidateZellijSessions,
  readTmuxSessionExists,
  readZellijSessionExists,
} from '@openscout/runtime/system-probes';
import { buildInteractiveTerminalEnvironment } from '@openscout/runtime/terminal-environment';
import { randomBytes, timingSafeEqual } from 'crypto';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { dirname as pathDirname, resolve as pathResolve, sep as pathSep } from 'path';
import type { IPty } from '@lydell/node-pty';

const require = createRequire(import.meta.url);
const pty = (() => {
  try {
    return require('@lydell/node-pty') as typeof import('@lydell/node-pty');
  } catch {
    return require('node-pty') as typeof import('@lydell/node-pty');
  }
})();

import {
  ackTerminalData,
  createTerminalFlowControlState,
  enqueueTerminalData,
  resetTerminalFlowControl,
  TERMINAL_ACK_CAPABILITY,
  TERMINAL_FLOW_CONTROL_CAPABILITY,
  type TerminalFlowControlState,
} from './terminal-relay-flow';
import {
  buildZellijAttachArgs,
  createZellijLayoutFile,
  prepareZellijSocketDir,
} from './terminal-relay-zellij';
import { resolveCodexExecutableInventory } from '@openscout/agent-sessions/codex-executable';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default orphan TTL — how long a detached session lives before being reaped. */
const DEFAULT_ORPHAN_TTL_MS = 30 * 60 * 1000; // 30 minutes

/** Maximum size of the raw output buffer for reconnect replay (~512 KB). */
const MAX_BUFFER_SIZE = 512 * 1024;

/** How far past the truncation point we scan for a clean cut (newline / ESC). */
const SAFE_TRUNCATION_WINDOW = 4096;

export const RELAY_CAPABILITIES = [
  TERMINAL_ACK_CAPABILITY,
  TERMINAL_FLOW_CONTROL_CAPABILITY,
  'backend:pty',
  'backend:tmux',
  'backend:zellij',
  'backend:herdr',
  'control-mode:observe',
] as const;

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface Session {
  id: string;
  pty: IPty;
  /** Currently attached WebSocket (null when detached/orphaned). */
  ws: RelaySocket | null;
  /** Rolling buffer of raw PTY output for reconnect replay. */
  outputBuffer: string;
  /** Current terminal dimensions. */
  cols: number;
  rows: number;
  /** Authoritative tmux window dimensions used to clamp read-only clients. */
  tmuxSourceCols?: number;
  tmuxSourceRows?: number;
  /** Set when ws detaches — session is reaped after orphanTTL. */
  reapTimer: ReturnType<typeof setTimeout> | null;
  /** How long this session survives without a client (ms). */
  orphanTTL: number;
  /** Secret required to reattach to this session (proves ownership on reconnect). */
  reconnectToken: string;
  /** PTY backend type. */
  backend: 'pty' | 'tmux' | 'zellij' | 'herdr';
  /** Client control intent. */
  controlMode: 'owner' | 'takeover' | 'observe';
  /** tmux session name (only set when backend is 'tmux'). */
  tmuxSession?: string;
  /** zellij session name (only set when backend is 'zellij'). */
  zellijSession?: string;
  /** zellij socket directory override (only set when backend is 'zellij'). */
  zellijSocketDir?: string;
  /** herdr session name (only set when backend is 'herdr'). */
  herdrSession?: string;
  /** Temporary layout file used to create a zellij session with the requested command. */
  zellijLayoutPath?: string;
  /** ACK-based outbound flow-control state for attached clients. */
  flowControl: TerminalFlowControlState;
  /** Whether the currently attached client supports ACK-based flow control. */
  flowControlEnabled: boolean;
  /** Whether the PTY process has exited. */
  exited: boolean;
  exitCode: number | null;
}

export const sessions = new Map<string, Session>();

function generateId(): string {
  return randomBytes(8).toString('hex');
}

function generateReconnectToken(): string {
  return randomBytes(16).toString('hex');
}

/** Constant-time check of a client-supplied reconnect token against the session's. */
export function verifyReconnectToken(session: Session, token: unknown): boolean {
  if (typeof token !== 'string' || token.length === 0) return false;
  const expected = Buffer.from(session.reconnectToken, 'utf8');
  const supplied = Buffer.from(token, 'utf8');
  if (expected.length !== supplied.length) return false;
  return timingSafeEqual(expected, supplied);
}

/** Session names get passed to tmux/zellij CLIs — keep them boring. */
const MULTIPLEXER_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

export function isValidMultiplexerName(name: string): boolean {
  return MULTIPLEXER_NAME_RE.test(name);
}

export function send(ws: RelaySocket, data: Record<string, unknown>) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(data));
  }
}

function ptyFdClosed(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('EBADF') || message.toLowerCase().includes('bad file descriptor');
}

function markSessionPtyClosed(session: Session, err: unknown, op: 'write' | 'resize') {
  if (session.exited) return;
  session.exited = true;
  console.warn(`[relay] Session ${session.id}: PTY ${op} failed after fd closed (${err instanceof Error ? err.message : String(err)})`);
  scheduleReap(session, 10_000);
}

function pauseSessionOutput(session: Session) {
  try { session.pty.pause?.(); } catch {}
}

function resumeSessionOutput(session: Session) {
  try { session.pty.resume?.(); } catch {}
}

function resetSessionFlowControl(session: Session) {
  resetTerminalFlowControl(session.flowControl, {
    resume: () => resumeSessionOutput(session),
  });
}

export function ackSessionOutput(session: Session, seq: number): boolean {
  if (!session.flowControlEnabled) return false;
  return ackTerminalData(session.flowControl, session.ws, seq, {
    pause: () => pauseSessionOutput(session),
    resume: () => resumeSessionOutput(session),
  });
}

function sendTerminalOutput(session: Session, data: string) {
  if (!session.flowControlEnabled) {
    if (session.ws && session.ws.readyState === 1) {
      send(session.ws, { type: 'terminal:data', data });
    }
    return;
  }

  enqueueTerminalData(session.flowControl, session.ws, data, {
    pause: () => pauseSessionOutput(session),
    resume: () => resumeSessionOutput(session),
    onDrop: ({ bytes, chunks }) => {
      console.warn(`[relay] Session ${session.id}: dropped ${bytes} bytes across ${chunks} queued output chunks after flow-control overflow`);
    },
  });
}

function clientSupportsAck(capabilities?: string[]): boolean {
  return Array.isArray(capabilities) && capabilities.includes(TERMINAL_ACK_CAPABILITY);
}

export function sessionOwnsSocket(session: Session, ws: RelaySocket): boolean {
  return session.ws === ws;
}

export function writeSession(session: Session, data: string): boolean {
  if (session.exited) return false;
  // 'observe' clients are read-only. The client marks observe handles
  // read-only in the UI, but the relay is the trust boundary — enforce it
  // here so it holds for every backend and call site.
  if (session.controlMode === 'observe') return false;
  try {
    session.pty.write(data);
    return true;
  } catch (err) {
    if (ptyFdClosed(err)) {
      markSessionPtyClosed(session, err, 'write');
      return false;
    }
    throw err;
  }
}

export async function resizeSession(session: Session, cols: number, rows: number): Promise<boolean> {
  if (session.exited) return false;
  let acceptedCols = cols;
  let acceptedRows = rows;
  if (session.controlMode === 'observe' && session.backend === 'tmux' && session.tmuxSession) {
    // A read-only client owns only its viewport. Never resize the tmux window;
    // cap the bridge to the authoritative grid so tmux does not draw padding.
    const source = await readTmuxDimensions(session.tmuxSession);
    const accepted = clampObserverDimensions({ cols, rows }, source);
    acceptedCols = accepted.cols;
    acceptedRows = accepted.rows;
    session.tmuxSourceCols = source.cols;
    session.tmuxSourceRows = source.rows;
  } else if (session.controlMode === 'observe' && session.backend !== 'zellij') {
    return false;
  }
  try {
    session.pty.resize(acceptedCols, acceptedRows);
    if (session.backend === 'tmux' && session.tmuxSession) {
      if (session.controlMode !== 'observe') {
        await resizeTmuxWindow(session.tmuxSession, acceptedCols, acceptedRows);
      }
    }
    session.cols = acceptedCols;
    session.rows = acceptedRows;
    send(session.ws!, { type: 'terminal:dimensions', cols: acceptedCols, rows: acceptedRows });
    return true;
  } catch (err) {
    if (ptyFdClosed(err)) {
      markSessionPtyClosed(session, err, 'resize');
      return false;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Trim the rolling output buffer to at most `maxSize` UTF-16 code units,
 * cutting on a safe boundary. A blind `slice(-maxSize)` can split a surrogate
 * pair or land mid-ANSI-escape, corrupting the first replayed line. We never
 * start on the low half of a surrogate pair, and prefer to resume at the next
 * newline or ESC (start of a fresh line / escape sequence) within a small
 * window past the cut point.
 */
export function truncateOutputBuffer(buffer: string, maxSize: number = MAX_BUFFER_SIZE): string {
  if (buffer.length <= maxSize) return buffer;
  let start = buffer.length - maxSize;
  if (isLowSurrogate(buffer.charCodeAt(start))) start += 1;
  const scanEnd = Math.min(buffer.length, start + SAFE_TRUNCATION_WINDOW);
  for (let i = start; i < scanEnd; i++) {
    const code = buffer.charCodeAt(i);
    if (code === 0x0a /* \n */) return buffer.slice(i + 1);
    if (code === 0x1b /* ESC */) return buffer.slice(i);
  }
  return buffer.slice(start);
}

/**
 * Split replay data into chunks of at most `maxBytes` UTF-8 bytes without
 * splitting surrogate pairs. The flow controller always sends the first
 * enqueued chunk regardless of size and a single in-flight chunk can never be
 * dropped, so an oversized replay blob would bypass flow control entirely.
 */
export function chunkReplayData(data: string, maxBytes: number): string[] {
  if (!data) return [];
  const limit = Math.max(1, maxBytes);
  if (Buffer.byteLength(data, 'utf8') <= limit) return [data];
  const chunks: string[] = [];
  let start = 0;
  while (start < data.length) {
    let end = Math.min(start + limit, data.length);
    for (;;) {
      // Never split a surrogate pair across chunks.
      if (end > start + 1 && isLowSurrogate(data.charCodeAt(end))) {
        end -= 1;
        continue;
      }
      const bytes = Buffer.byteLength(data.slice(start, end), 'utf8');
      if (bytes <= limit || end <= start + 1) break;
      // Shrink proportionally toward the byte budget, then re-check.
      end = start + Math.max(1, Math.floor(((end - start) * limit) / bytes));
    }
    chunks.push(data.slice(start, end));
    start = end;
  }
  return chunks;
}

/** Resolve a cwd string, expanding ~, creating if missing, falling back to $HOME. */
function resolveCwd(raw?: string): string {
  const home = process.env.HOME || '/tmp';
  const expanded = (raw || home).replace(/^~/, home);
  if (existsSync(expanded)) return expanded;
  try {
    mkdirSync(expanded, { recursive: true });
    console.log(`[relay] Created missing cwd: ${expanded}`);
    return expanded;
  } catch {
    console.warn(`[relay] Could not create cwd ${expanded}, falling back to ${home}`);
    return home;
  }
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

/** Locate a binary by name, returning null if not found. */
async function findBin(name: string, envOverride?: string): Promise<string | null> {
  if (envOverride && process.env[envOverride]) return process.env[envOverride] ?? null;
  try {
    const result = await execSystemFile('which', [name], {
      timeoutMs: 1_500,
      maxStdoutBytes: 64 * 1024,
      maxStderrBytes: 64 * 1024,
    });
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Locate the claude binary, returning null if not found. */
async function findClaudeBin(): Promise<string | null> {
  return findBin('claude', 'CLAUDE_BIN');
}

/** Locate the pi binary, returning null if not found. */
async function findPiBin(): Promise<string | null> {
  return findBin('pi', 'PI_BIN');
}

/** Locate Codex using the shared app/PATH/npm-aware executable inventory. */
async function findCodexBin(): Promise<string | null> {
  const selected = resolveCodexExecutableInventory().selected;
  if (!selected?.executable) return null;
  if (selected.path === 'codex') return findBin('codex', 'CODEX_BIN');
  return selected.path;
}

/** Locate the user's shell, falling back to common POSIX shells. */
async function findShellBin(): Promise<string | null> {
  const configured = process.env.SHELL;
  if (configured && existsSync(configured)) return configured;
  return await findBin('zsh') ?? await findBin('bash') ?? await findBin('sh') ?? (existsSync('/bin/sh') ? '/bin/sh' : null);
}

/** Locate the zellij binary, returning null if not found. */
async function findZellijBin(): Promise<string | null> {
  return findBin('zellij', 'ZELLIJ_BIN');
}

/** Check if a zellij session exists (only queried when the mux reaper is enabled). */
async function zellijSessionExists(_zellijBin: string, name: string, env: Record<string, string | undefined>): Promise<boolean> {
  return await readZellijSessionExists(name, { env: env as NodeJS.ProcessEnv, maxAgeMs: 5_000 });
}

/** Check if a tmux session exists. */
async function tmuxSessionExists(name: string): Promise<boolean> {
  return await readTmuxSessionExists(name, { maxAgeMs: 5_000 });
}

/** Map Hudson-facing provider ids to the exact provider names accepted by the Pi CLI. */
function normalizePiProviderForCli(provider?: string): string | undefined {
  if (!provider) return undefined;
  if (provider === 'copilot' || provider === 'github') return 'github-copilot';
  return provider;
}

/** Quote a string for POSIX sh (tmux runs the session command through a shell). */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Resize the tmux window behind an attached bridge PTY. */
async function resizeTmuxWindow(name: string, cols: number, rows: number): Promise<boolean> {
  try {
    await execSystemFile('tmux', [
      'resize-window',
      '-t',
      name,
      '-x',
      String(cols),
      '-y',
      String(rows),
    ], { timeoutMs: 2_000 });
    return true;
  } catch {
    return false;
  }
}

export interface TerminalDimensions {
  cols: number;
  rows: number;
}

export function clampObserverDimensions(
  requested: TerminalDimensions,
  source: TerminalDimensions,
): TerminalDimensions {
  return {
    cols: Math.max(1, Math.min(requested.cols, source.cols)),
    rows: Math.max(1, Math.min(requested.rows, source.rows)),
  };
}

async function readTmuxDimensions(name: string): Promise<TerminalDimensions> {
  const result = await execSystemFile('tmux', [
    'display-message',
    '-p',
    '-t',
    name,
    '#{window_width} #{window_height}',
  ], { timeoutMs: 2_000 });
  const match = /^(\d+)\s+(\d+)$/.exec(result.stdout.trim());
  if (!match) {
    throw new Error(`Could not read terminal dimensions for tmux session '${name}'`);
  }
  return { cols: Number(match[1]), rows: Number(match[2]) };
}

/** Resolve a bootstrap file path, rejecting anything that escapes the cwd. */
export function resolveBootstrapPath(cwd: string, relPath: string): string | null {
  const base = pathResolve(cwd);
  const absPath = pathResolve(base, relPath);
  if (absPath === base || !absPath.startsWith(base + pathSep)) return null;
  return absPath;
}

/** Bootstrap workspace files into a directory (only creates if missing). */
function bootstrapFiles(cwd: string, files: Record<string, string>, sessionId: string) {
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = resolveBootstrapPath(cwd, relPath);
    if (!absPath) {
      console.warn(`[relay] Session ${sessionId}: refused to bootstrap ${relPath} — path escapes the session cwd`);
      continue;
    }
    if (!existsSync(absPath)) {
      try {
        const dir = pathDirname(absPath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(absPath, content, 'utf-8');
        console.log(`[relay] Session ${sessionId}: bootstrapped ${relPath}`);
      } catch (err) {
        console.warn(`[relay] Session ${sessionId}: failed to bootstrap ${relPath}:`, err);
      }
    }
  }
}

/** Spawn a PTY that attaches to a tmux session (creating it if needed). */
export function buildTmuxAttachArgs(
  tmuxName: string,
  controlMode: 'owner' | 'takeover' | 'observe',
): string[] {
  // tmux's -r alias sets both read-only and ignore-size. The relay also drops
  // observe input and resize messages, but these client flags keep tmux itself
  // from treating the browser observer as a writer or a sizing authority.
  return controlMode === 'observe'
    ? ['-u', 'attach', '-r', '-t', tmuxName]
    : ['-u', 'attach', '-t', tmuxName];
}

type AttachPtyOutput = (handler: (data: string) => void) => void;

export function bufferPtyOutput(ptyProcess: Pick<IPty, 'onData'>): AttachPtyOutput {
  const pending: string[] = [];
  let handler: ((data: string) => void) | null = null;

  ptyProcess.onData((data) => {
    if (handler) handler(data);
    else pending.push(data);
  });

  return (nextHandler) => {
    handler = nextHandler;
    for (const data of pending.splice(0)) nextHandler(data);
  };
}

async function spawnTmuxSession(
  tmuxName: string,
  cols: number,
  rows: number,
  cwd: string,
  commandBin: string,
  commandArgs: string[],
  env: Record<string, string | undefined>,
  controlMode: 'owner' | 'takeover' | 'observe',
): Promise<{
  ptyProcess: IPty;
  attachOutput: AttachPtyOutput;
  dimensions: TerminalDimensions;
  sourceDimensions?: TerminalDimensions;
}> {
  const exists = await tmuxSessionExists(tmuxName);
  let dimensions = { cols, rows };
  let sourceDimensions: TerminalDimensions | undefined;

  if (!exists) {
    if (controlMode === 'observe') {
      throw new Error(`tmux session '${tmuxName}' does not exist`);
    }
    // Create the tmux session detached, running the requested command inside it.
    // tmux runs the trailing command through a shell, so quote every word;
    // everything else is passed as discrete argv entries (no shell involved).
    const shellCmd = [commandBin, ...commandArgs].map(shellQuote).join(' ');
    await execSystemFile('tmux', [
      'new-session', '-d',
      '-s', tmuxName,
      '-x', String(cols),
      '-y', String(rows),
      '-c', cwd,
      shellCmd,
    ], { env: env as NodeJS.ProcessEnv, timeoutMs: 5_000 });
    invalidateTmuxSessions({ env: env as NodeJS.ProcessEnv, reason: 'terminal-relay.new-session' });
    console.log(`[relay] Created tmux session: ${tmuxName}`);
    if (muxTtlMs() > 0) trackCreatedMuxSession('tmux', tmuxName);
  } else {
    // Observers should never perturb the tmux session they are watching.
    if (controlMode !== 'observe') {
      await resizeTmuxWindow(tmuxName, cols, rows);
    }
    console.log(`[relay] Attaching to existing tmux session: ${tmuxName}${controlMode === 'observe' ? ' (observe)' : ''}`);
    markMuxSessionInUse('tmux', tmuxName);
    if (controlMode === 'observe') {
      sourceDimensions = await readTmuxDimensions(tmuxName);
      dimensions = clampObserverDimensions(dimensions, sourceDimensions);
    }
  }

  // Spawn a PTY bridge that attaches to the tmux session
  // This gives us a PTY file descriptor that pipes tmux I/O to our WebSocket
  const ptyProcess = pty.spawn('tmux', buildTmuxAttachArgs(tmuxName, controlMode), {
    name: 'xterm-256color',
    cols: dimensions.cols,
    rows: dimensions.rows,
    cwd,
    env,
  });
  return { ptyProcess, attachOutput: bufferPtyOutput(ptyProcess), dimensions, sourceDimensions };
}

/** Spawn a PTY that attaches to a zellij session (creating it if needed). */
function spawnZellijSession(
  zellijBin: string,
  zellijName: string,
  cols: number,
  rows: number,
  cwd: string,
  commandBin: string,
  commandArgs: string[],
  env: Record<string, string | undefined>,
  controlMode: 'owner' | 'takeover' | 'observe',
): { ptyProcess: IPty; layoutPath?: string } {
  const layoutPath = controlMode === 'observe'
    ? undefined
    : createZellijLayoutFile({ cwd, commandBin, commandArgs });
  const args = buildZellijAttachArgs({
    sessionName: zellijName,
    controlMode,
    layoutPath,
    cwd,
  });

  return {
    ptyProcess: pty.spawn(zellijBin, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env,
    }),
    layoutPath,
  };
}

export async function createSession(ws: RelaySocket, msg: SessionInitMessage): Promise<Session | null> {
  const id = generateId();
  let cols = Math.max(msg.cols || 80, 20);
  let rows = Math.max(msg.rows || 24, 4);
  const backend = msg.backend || 'pty';
  const controlMode = msg.controlMode || 'owner';
  const tmuxName = msg.tmuxSession || `hudson-${id}`;
  const zellijName = msg.zellijSession || `hudson-${id}`;
  const herdrName = msg.herdrSession || msg.tmuxSession || `scout-herdr-${id}`;
  const agent = msg.agent || 'claude';

  // ---- Pre-flight: multiplexer session names reach tmux/zellij/herdr CLIs ----
  const multiplexerName = backend === 'tmux'
    ? tmuxName
    : backend === 'zellij'
      ? zellijName
      : backend === 'herdr'
        ? herdrName
        : null;
  if (multiplexerName && !isValidMultiplexerName(multiplexerName)) {
    const reason = `Invalid ${backend} session name. Use only letters, digits, dashes, and underscores.`;
    console.error(`[relay] Session ${id} failed: ${reason}`);
    send(ws, { type: 'session:error', error: reason });
    return null;
  }

  // ---- Pre-flight: locate command binary ----
  let agentBin: string | null = null;
  let agentArgs: string[] = [];
  const herdrBin = backend === 'herdr' ? await findBin('herdr', 'OPENSCOUT_HERDR_BIN') : null;

  if (backend === 'herdr') {
    if (!herdrBin) {
      const reason = 'herdr not found. Install it from https://herdr.dev/docs/install/';
      console.error(`[relay] Session ${id} failed: ${reason}`);
      send(ws, { type: 'session:error', error: reason });
      return null;
    }
    agentBin = herdrBin;
    // Create-or-attach for named sessions; plain `herdr` for the default session.
    agentArgs = !herdrName || herdrName === 'default'
      ? []
      : ['--session', herdrName];
  } else if (agent === 'shell') {
    agentBin = await findShellBin();
    if (!agentBin) {
      const reason = 'No login shell found. Set SHELL or install zsh, bash, or sh.';
      console.error(`[relay] Session ${id} failed: ${reason}`);
      send(ws, { type: 'session:error', error: reason });
      return null;
    }
  } else if (agent === 'codex') {
    agentBin = await findCodexBin();
    if (!agentBin) {
      const reason = 'Codex CLI not found. Install it with: npm install -g @openai/codex';
      console.error(`[relay] Session ${id} failed: ${reason}`);
      send(ws, { type: 'session:error', error: reason });
      return null;
    }
  } else if (agent === 'pi') {
    agentBin = await findPiBin();
    if (!agentBin) {
      const reason = 'pi CLI not found. Install it with: npm install -g @mariozechner/pi-coding-agent';
      console.error(`[relay] Session ${id} failed: ${reason}`);
      send(ws, { type: 'session:error', error: reason });
      return null;
    }
  } else {
    agentBin = await findClaudeBin();
    if (!agentBin) {
      const reason = 'Claude CLI not found. Install it with: npm install -g @anthropic-ai/claude-code';
      console.error(`[relay] Session ${id} failed: ${reason}`);
      send(ws, { type: 'session:error', error: reason });
      return null;
    }
  }

  if (!agentBin || !existsSync(agentBin)) {
    const reason = `${backend === 'herdr' ? 'herdr' : agent} binary not found${agentBin ? ` at ${agentBin}` : ''}`;
    console.error(`[relay] Session ${id} failed: ${reason}`);
    send(ws, { type: 'session:error', error: reason });
    return null;
  }

  // ---- Pre-flight: tmux backend requires tmux ----
  if (backend === 'tmux' && !(await findBin('tmux'))) {
    const reason = 'tmux not found. Install it with: brew install tmux';
    console.error(`[relay] Session ${id} failed: ${reason}`);
    send(ws, { type: 'session:error', error: reason });
    return null;
  }

  const zellijBin = backend === 'zellij' ? await findZellijBin() : null;
  if (backend === 'zellij' && !zellijBin) {
    const reason = 'zellij not found. Install it with: brew install zellij';
    console.error(`[relay] Session ${id} failed: ${reason}`);
    send(ws, { type: 'session:error', error: reason });
    return null;
  }

  // ---- Pre-flight: resolve working directory ----
  const cwd = resolveCwd(msg.cwd);

  // ---- Bootstrap workspace files ----
  if (msg.workspaceFiles) {
    bootstrapFiles(cwd, msg.workspaceFiles, id);
  }

  // ---- Build command arguments based on process type ----
  if (backend !== 'herdr') {
    if (agent === 'shell') {
      const shellName = agentBin.split('/').pop() ?? '';
      agentArgs = shellName === 'sh' ? [] : ['-l'];
    } else if (agent === 'codex') {
      agentArgs = [];
    } else if (agent === 'pi') {
      agentArgs = ['--verbose'];
      const provider = normalizePiProviderForCli(msg.provider);
      if (provider) agentArgs.push('--provider', provider);
      if (msg.model) agentArgs.push('--model', msg.model);
      if (msg.systemPrompt) agentArgs.push('--system-prompt', msg.systemPrompt);
    } else {
      agentArgs = ['--verbose'];
      if (msg.systemPrompt) agentArgs.push('--system-prompt', msg.systemPrompt);
    }
  }

  const env: Record<string, string | undefined> = buildInteractiveTerminalEnvironment(process.env, {
    ...prepareZellijSocketDir(backend === 'zellij' ? msg.zellijSocketDir : undefined),
    TERM: 'xterm-256color',
  });

  // ---- Spawn PTY (direct or host-backed) ----
  let ptyProcess: IPty;
  let attachPtyOutput: AttachPtyOutput | null = null;
  let zellijLayoutPath: string | undefined;
  let tmuxSourceDimensions: TerminalDimensions | undefined;

  try {
    if (backend === 'tmux') {
      console.log(`[relay] Session ${id}: tmux backend (session: ${tmuxName}) in ${cwd} [agent: ${agent}]`);
      const spawned = await spawnTmuxSession(tmuxName, cols, rows, cwd, agentBin, agentArgs, env, controlMode);
      ptyProcess = spawned.ptyProcess;
      attachPtyOutput = spawned.attachOutput;
      cols = spawned.dimensions.cols;
      rows = spawned.dimensions.rows;
      tmuxSourceDimensions = spawned.sourceDimensions;
    } else if (backend === 'zellij') {
      console.log(`[relay] Session ${id}: zellij backend (session: ${zellijName}, mode: ${controlMode}) in ${cwd} [agent: ${agent}]`);
      // Only pay for the existence check when the mux reaper is on; 'observe'
      // never creates a session, so it never tracks one either.
      const trackZellij = muxTtlMs() > 0 && controlMode !== 'observe'
        && !(await zellijSessionExists(zellijBin!, zellijName, env));
      const spawned = spawnZellijSession(zellijBin!, zellijName, cols, rows, cwd, agentBin, agentArgs, env, controlMode);
      ptyProcess = spawned.ptyProcess;
      zellijLayoutPath = spawned.layoutPath;
      if (trackZellij) trackCreatedMuxSession('zellij', zellijName);
      else markMuxSessionInUse('zellij', zellijName);
    } else if (backend === 'herdr') {
      // Full Herdr client inside the Scout relay PTY. Detaching the relay
      // closes this client only; the Herdr server and panes keep running.
      console.log(`[relay] Session ${id}: herdr backend (session: ${herdrName}) in ${cwd}`);
      ptyProcess = pty.spawn(agentBin, agentArgs, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env,
      });
    } else {
      console.log(`[relay] Session ${id}: pty backend, spawning ${agentBin} in ${cwd} [agent: ${agent}]`);
      ptyProcess = pty.spawn(agentBin, agentArgs, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[relay] Session ${id}: failed to spawn PTY — ${message}`);
    send(ws, { type: 'session:error', error: `Failed to spawn terminal: ${message}` });
    return null;
  }

  const orphanTTL = msg.orphanTTL && msg.orphanTTL > 0 ? msg.orphanTTL : DEFAULT_ORPHAN_TTL_MS;

  const session: Session = {
    id,
    pty: ptyProcess,
    ws,
    reconnectToken: generateReconnectToken(),
    outputBuffer: '',
    cols,
    rows,
    reapTimer: null,
    orphanTTL,
    backend,
    controlMode,
    ...(backend === 'tmux' ? { tmuxSession: tmuxName } : {}),
    ...(tmuxSourceDimensions ? {
      tmuxSourceCols: tmuxSourceDimensions.cols,
      tmuxSourceRows: tmuxSourceDimensions.rows,
    } : {}),
    ...(backend === 'zellij' ? {
      zellijSession: zellijName,
      ...(msg.zellijSocketDir ? { zellijSocketDir: msg.zellijSocketDir } : {}),
      ...(zellijLayoutPath ? { zellijLayoutPath } : {}),
    } : {}),
    ...(backend === 'herdr' ? { herdrSession: herdrName } : {}),
    flowControl: createTerminalFlowControlState(),
    flowControlEnabled: clientSupportsAck(msg.clientCapabilities),
    exited: false,
    exitCode: null,
  };

  // Track start time to detect immediate crashes
  const startTime = Date.now();

  const handlePtyData = (data: string) => {
    // An observer reconnect must come from a fresh tmux attach/full redraw.
    // A byte-tail is not a terminal snapshot and may begin mid-escape sequence.
    if (session.controlMode !== 'observe') {
      session.outputBuffer = truncateOutputBuffer(session.outputBuffer + data, MAX_BUFFER_SIZE);
    }

    // Forward raw data to attached client with ACK-based backpressure.
    sendTerminalOutput(session, data);
  };
  send(ws, { type: 'terminal:dimensions', cols, rows });
  if (attachPtyOutput) attachPtyOutput(handlePtyData);
  else ptyProcess.onData(handlePtyData);

  ptyProcess.onExit(({ exitCode }: { exitCode: number; signal?: number }) => {
    session.exited = true;
    session.exitCode = exitCode;

    const uptime = Date.now() - startTime;
    const crashed = exitCode !== 0 && uptime < 5000;

    // Build a human-readable reason from buffered output for early crashes
    let reason: string | undefined;
    if (crashed) {
      // Strip ANSI escape codes for a clean error message
      const clean = session.outputBuffer.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();
      // Take last meaningful lines (skip blanks)
      const lines = clean.split('\n').filter(l => l.trim()).slice(-5);
      reason = lines.join('\n') || `Process exited with code ${exitCode}`;
      console.error(`[relay] Session ${id} crashed after ${uptime}ms (code ${exitCode}): ${reason}`);
    }

    if (session.ws) {
      send(session.ws, { type: 'session:exit', exitCode, ...(reason ? { reason } : {}) });
    }
    // Don't cleanup immediately — let the client see the exit message.
    scheduleReap(session, 10_000);
  });

  sessions.set(id, session);
  console.log(`[relay] Session ${id} created (${cols}x${rows})`);
  return session;
}

/** Attach a WebSocket to an existing session (reconnect). */
export async function attachSession(session: Session, ws: RelaySocket, cols?: number, rows?: number, clientCapabilities?: string[]) {
  // Cancel any pending reap
  if (session.reapTimer) {
    clearTimeout(session.reapTimer);
    session.reapTimer = null;
  }

  resetSessionFlowControl(session);
  session.flowControlEnabled = clientSupportsAck(clientCapabilities);
  session.ws = ws;

  // Resize if the client has different dimensions
  if (cols && rows) {
    const c = Math.max(cols, 20);
    const r = Math.max(rows, 4);
    if (c !== session.cols || r !== session.rows) {
      await resizeSession(session, c, r);
    }
  }

  // Replay buffered output so xterm.js rebuilds the screen. Replay in
  // ≤ highWaterBytes chunks — the flow controller always transmits the first
  // enqueued chunk whatever its size, so a single 512 KB blob would blow
  // straight past the flow-control window.
  if (session.exited) {
    send(ws, { type: 'session:exit', exitCode: session.exitCode });
  } else if (session.outputBuffer.length > 0) {
    const replayChunks = session.flowControlEnabled
      ? chunkReplayData(session.outputBuffer, session.flowControl.highWaterBytes)
      : [session.outputBuffer];
    for (const chunk of replayChunks) {
      sendTerminalOutput(session, chunk);
    }
  }

  console.log(`[relay] Session ${session.id} reconnected`);
}

/** Detach the WebSocket from a session (keeps PTY alive). */
export function detachSession(session: Session) {
  resetSessionFlowControl(session);
  session.ws = null;

  if (session.exited) {
    scheduleReap(session, 5_000);
  } else {
    scheduleReap(session, session.orphanTTL);
    console.log(`[relay] Session ${session.id} detached (orphaned for ${session.orphanTTL / 1000}s)`);
  }
}

export function scheduleReap(session: Session, delay: number) {
  if (session.reapTimer) clearTimeout(session.reapTimer);
  session.reapTimer = setTimeout(() => {
    if (!session.ws) {
      destroy(session.id);
    }
  }, delay);
}

/** Hard destroy — kill PTY bridge, remove from map.
 *  For tmux sessions: only kills the attach bridge, not the tmux session itself. */
export function destroy(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (session.reapTimer) clearTimeout(session.reapTimer);
  resetSessionFlowControl(session);
  try { session.pty.kill(); } catch {}
  if (session.zellijLayoutPath) {
    try { rmSync(pathDirname(session.zellijLayoutPath), { recursive: true, force: true }); } catch {}
  }
  sessions.delete(sessionId);
  if (session.backend === 'tmux') {
    console.log(`[relay] Session ${sessionId} bridge destroyed (tmux session '${session.tmuxSession}' still alive)`);
    if (session.tmuxSession) markMuxSessionDetached('tmux', session.tmuxSession);
  } else if (session.backend === 'zellij') {
    console.log(`[relay] Session ${sessionId} bridge destroyed (zellij session '${session.zellijSession}' still alive)`);
    if (session.zellijSession) markMuxSessionDetached('zellij', session.zellijSession);
  } else if (session.backend === 'herdr') {
    console.log(`[relay] Session ${sessionId} bridge destroyed (herdr session '${session.herdrSession}' still alive)`);
  } else {
    console.log(`[relay] Session ${sessionId} destroyed`);
  }
}

// ---------------------------------------------------------------------------
// Multiplexer session reaper (opt-in)
//
// destroy() deliberately leaves tmux/zellij sessions alive so users can
// re-attach from a real terminal — but nothing ever cleans them up. Set
// HUDSON_RELAY_MUX_TTL_MS to have the relay reap multiplexer sessions *it
// created* once their last bridge has been gone longer than the TTL.
// Sessions the relay merely attached to (pre-existing tmux/zellij sessions)
// are never tracked and never touched. Default: off (current behavior).
// ---------------------------------------------------------------------------

export interface TrackedMuxSession {
  backend: 'tmux' | 'zellij';
  name: string;
  /** When the last relay bridge for this mux session went away (null while in use). */
  detachedAt: number | null;
}

/** Mux sessions this relay created — the only reap candidates. */
export const trackedMuxSessions = new Map<string, TrackedMuxSession>();

/** TTL for orphaned relay-created mux sessions. 0 = reaper disabled. */
export function muxTtlMs(): number {
  const raw = Number(process.env.HUDSON_RELAY_MUX_TTL_MS || 0);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

function muxKey(backend: 'tmux' | 'zellij', name: string): string {
  return `${backend}:${name}`;
}

/** Record a mux session this relay just created. */
export function trackCreatedMuxSession(backend: 'tmux' | 'zellij', name: string) {
  trackedMuxSessions.set(muxKey(backend, name), { backend, name, detachedAt: null });
}

/** Mark a tracked mux session in-use again (a bridge attached to it). */
export function markMuxSessionInUse(backend: 'tmux' | 'zellij', name: string) {
  const record = trackedMuxSessions.get(muxKey(backend, name));
  if (record) record.detachedAt = null;
}

/** Mark a tracked mux session detached (its bridge was destroyed). No-op for untracked names. */
export function markMuxSessionDetached(backend: 'tmux' | 'zellij', name: string, now = Date.now()) {
  const record = trackedMuxSessions.get(muxKey(backend, name));
  if (record) record.detachedAt = now;
}

function muxSessionInUse(record: TrackedMuxSession): boolean {
  for (const session of sessions.values()) {
    if (record.backend === 'tmux' && session.tmuxSession === record.name) return true;
    if (record.backend === 'zellij' && session.zellijSession === record.name) return true;
  }
  return false;
}

async function killMuxSession(record: Pick<TrackedMuxSession, 'backend' | 'name'>): Promise<void> {
  if (record.backend === 'tmux') {
    await execSystemFile('tmux', ['kill-session', '-t', record.name], { timeoutMs: 2_000 });
    invalidateTmuxSessions({ reason: 'terminal-relay.kill-session' });
  } else {
    const zellijBin = await findZellijBin();
    if (!zellijBin) throw new Error('zellij binary not found');
    await execSystemFile(zellijBin, ['delete-session', '--force', record.name], { timeoutMs: 2_000 });
    invalidateZellijSessions({ reason: 'terminal-relay.delete-session' });
  }
}

/** Reap tracked mux sessions detached longer than ttlMs. Returns reaped names. */
export async function reapExpiredMuxSessions(
  ttlMs: number,
  now = Date.now(),
  kill: (record: TrackedMuxSession) => Promise<void> = killMuxSession,
): Promise<string[]> {
  const reaped: string[] = [];
  for (const [key, record] of trackedMuxSessions) {
    if (record.detachedAt === null || now - record.detachedAt < ttlMs) continue;
    if (muxSessionInUse(record)) {
      // A live bridge still references it — treat as in use again.
      record.detachedAt = null;
      continue;
    }
    try {
      await kill(record);
      console.log(`[relay] Reaped orphaned ${record.backend} session '${record.name}' (detached > ${ttlMs}ms)`);
      reaped.push(record.name);
    } catch (err) {
      // Most likely the session is already gone (killed by hand). Either way,
      // drop the record so we don't retry every sweep.
      console.warn(`[relay] Failed to reap ${record.backend} session '${record.name}': ${err instanceof Error ? err.message : String(err)}`);
    }
    trackedMuxSessions.delete(key);
  }
  return reaped;
}

let muxReaperTimer: ReturnType<typeof setInterval> | null = null;

/** Start the TTL reaper if HUDSON_RELAY_MUX_TTL_MS is set. No-op (and no behavior change) otherwise. */
export function maybeStartMuxReaper(): boolean {
  const ttl = muxTtlMs();
  if (ttl <= 0) return false;
  if (muxReaperTimer) return true;
  const sweepInterval = Math.min(Math.max(Math.floor(ttl / 2), 5_000), 60_000);
  muxReaperTimer = setInterval(() => { void reapExpiredMuxSessions(muxTtlMs()); }, sweepInterval);
  muxReaperTimer.unref?.();
  console.log(`[relay] Mux session reaper enabled: TTL ${ttl}ms, sweeping every ${Math.round(sweepInterval / 1000)}s`);
  return true;
}

export function stopMuxReaper() {
  if (muxReaperTimer) {
    clearInterval(muxReaperTimer);
    muxReaperTimer = null;
  }
}
