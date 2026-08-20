// Generated from Hudson relay flow.
// Refresh with: node ./scripts/sync-terminal-relay-session.mjs
/** Minimal WebSocket interface used by terminal relay flow control. */
interface RelaySocket {
  readonly readyState: number;
  send(data: string | Buffer): void;
}
export const TERMINAL_ACK_CAPABILITY = 'terminal:ack';
export const TERMINAL_FLOW_CONTROL_CAPABILITY = 'flow-control:ack-v1';

const DEFAULT_HIGH_WATER_BYTES = 512 * 1024;
const DEFAULT_LOW_WATER_BYTES = 256 * 1024;
const DEFAULT_MAX_QUEUED_BYTES = 2 * 1024 * 1024;

interface OutputChunk {
  seq: number;
  data: string;
  bytes: number;
}

export interface TerminalFlowControlOptions {
  highWaterBytes?: number;
  lowWaterBytes?: number;
  maxQueuedBytes?: number;
}

export interface TerminalFlowControlState {
  nextSeq: number;
  inFlightBytes: number;
  queuedBytes: number;
  droppedBytes: number;
  paused: boolean;
  highWaterBytes: number;
  lowWaterBytes: number;
  maxQueuedBytes: number;
  pendingAcks: Map<number, OutputChunk>;
  queue: OutputChunk[];
}

export interface TerminalFlowControlHooks {
  pause?: () => void;
  resume?: () => void;
  onDrop?: (info: { bytes: number; chunks: number }) => void;
}

function byteLength(data: string): number {
  return Buffer.byteLength(data, 'utf8');
}

function socketOpen(ws: RelaySocket | null | undefined): ws is RelaySocket {
  return Boolean(ws && ws.readyState === 1);
}

export function createTerminalFlowControlState(
  options: TerminalFlowControlOptions = {},
): TerminalFlowControlState {
  const highWaterBytes = Math.max(1, options.highWaterBytes ?? DEFAULT_HIGH_WATER_BYTES);
  const lowWaterBytes = Math.max(0, Math.min(options.lowWaterBytes ?? DEFAULT_LOW_WATER_BYTES, highWaterBytes));
  const maxQueuedBytes = Math.max(0, options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES);

  return {
    nextSeq: 1,
    inFlightBytes: 0,
    queuedBytes: 0,
    droppedBytes: 0,
    paused: false,
    highWaterBytes,
    lowWaterBytes,
    maxQueuedBytes,
    pendingAcks: new Map(),
    queue: [],
  };
}

export function resetTerminalFlowControl(state: TerminalFlowControlState, hooks: TerminalFlowControlHooks = {}) {
  state.inFlightBytes = 0;
  state.queuedBytes = 0;
  state.pendingAcks.clear();
  state.queue = [];
  resumeFlow(state, hooks, true);
}

function pauseFlow(state: TerminalFlowControlState, hooks: TerminalFlowControlHooks) {
  if (state.paused) return;
  state.paused = true;
  hooks.pause?.();
}

function resumeFlow(state: TerminalFlowControlState, hooks: TerminalFlowControlHooks, force = false) {
  if (!state.paused) return;
  if (!force && state.inFlightBytes + state.queuedBytes > state.lowWaterBytes) return;
  state.paused = false;
  hooks.resume?.();
}

function sendChunk(state: TerminalFlowControlState, ws: RelaySocket, chunk: OutputChunk, hooks: TerminalFlowControlHooks): boolean {
  if (!socketOpen(ws)) return false;
  ws.send(JSON.stringify({ type: 'terminal:data', data: chunk.data, seq: chunk.seq }));
  state.pendingAcks.set(chunk.seq, chunk);
  state.inFlightBytes += chunk.bytes;
  if (state.inFlightBytes >= state.highWaterBytes) {
    pauseFlow(state, hooks);
  }
  return true;
}

function dropOverflow(state: TerminalFlowControlState, hooks: TerminalFlowControlHooks) {
  if (state.maxQueuedBytes <= 0) return;
  let droppedBytes = 0;
  let droppedChunks = 0;
  while (state.queuedBytes > state.maxQueuedBytes && state.queue.length > 0) {
    const dropped = state.queue.shift();
    if (!dropped) break;
    state.queuedBytes -= dropped.bytes;
    state.droppedBytes += dropped.bytes;
    droppedBytes += dropped.bytes;
    droppedChunks += 1;
  }
  if (droppedChunks > 0) {
    hooks.onDrop?.({ bytes: droppedBytes, chunks: droppedChunks });
  }
}

function queueChunk(state: TerminalFlowControlState, chunk: OutputChunk, hooks: TerminalFlowControlHooks) {
  state.queue.push(chunk);
  state.queuedBytes += chunk.bytes;
  pauseFlow(state, hooks);
  dropOverflow(state, hooks);
}

export function enqueueTerminalData(
  state: TerminalFlowControlState,
  ws: RelaySocket | null | undefined,
  data: string,
  hooks: TerminalFlowControlHooks = {},
): number | null {
  if (!data || !socketOpen(ws)) return null;
  const chunk: OutputChunk = {
    seq: state.nextSeq++,
    data,
    bytes: byteLength(data),
  };

  if (state.inFlightBytes >= state.highWaterBytes || state.queue.length > 0) {
    queueChunk(state, chunk, hooks);
    return chunk.seq;
  }

  sendChunk(state, ws, chunk, hooks);
  return chunk.seq;
}

export function flushTerminalData(
  state: TerminalFlowControlState,
  ws: RelaySocket | null | undefined,
  hooks: TerminalFlowControlHooks = {},
) {
  if (!socketOpen(ws)) return;

  while (state.queue.length > 0) {
    const next = state.queue[0];
    if (!next) break;
    const canSend = state.inFlightBytes === 0 || state.inFlightBytes + next.bytes <= state.highWaterBytes;
    if (!canSend) break;
    state.queue.shift();
    state.queuedBytes -= next.bytes;
    sendChunk(state, ws, next, hooks);
  }

  if (state.queue.length === 0 && state.inFlightBytes <= state.lowWaterBytes) {
    resumeFlow(state, hooks);
  }
}

export function ackTerminalData(
  state: TerminalFlowControlState,
  ws: RelaySocket | null | undefined,
  seq: number,
  hooks: TerminalFlowControlHooks = {},
): boolean {
  const chunk = state.pendingAcks.get(seq);
  if (!chunk) return false;
  state.pendingAcks.delete(seq);
  state.inFlightBytes = Math.max(0, state.inFlightBytes - chunk.bytes);
  flushTerminalData(state, ws, hooks);
  return true;
}
