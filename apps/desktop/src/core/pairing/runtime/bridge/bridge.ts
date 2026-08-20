// Bridge — the local orchestrator.
//
// Runs on the user's machine.  Manages adapter instances (one per session),
// collects their Pairing events, and exposes a single WebSocket endpoint for
// the relay (or a direct phone connection) to consume.
//
// The bridge never touches API keys or provider credentials directly — those
// live inside the adapters, which run as local code on the same machine.

import {
  SessionRegistry as SharedSessionRegistry,
  type AdapterConfig,
  type AdapterFactory,
  type Prompt,
  type QuestionAnswer,
  type SessionDecisionInput,
  type Session,
  type SessionRegistry,
  type SequencedEvent,
  type SessionState,
  type SessionSummary,
} from "@openscout/agent-sessions";
import { log } from "./log.ts";

// ---------------------------------------------------------------------------
// Bridge configuration
// ---------------------------------------------------------------------------

export interface BridgeConfig {
  /** Port for the local WebSocket listener. */
  port?: number;
  /** Registered adapter factories, keyed by adapter type. */
  adapters: Record<string, AdapterFactory>;
  /** Max events in the outbound ring buffer (default 500). */
  bufferCapacity?: number;
}

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

export class Bridge {
  private registry: SessionRegistry;

  constructor(private config: BridgeConfig) {
    this.registry = new SharedSessionRegistry({
      adapters: config.adapters,
      bufferCapacity: config.bufferCapacity,
    });
  }

  // -- Session management ---------------------------------------------------

  /** Create a new session with the given adapter type. */
  async createSession(
    adapterType: string,
    options?: Partial<AdapterConfig>,
  ): Promise<Session> {
    return this.registry.createSession(adapterType, options);
  }

  /** Send a prompt to a session. */
  send(prompt: Prompt): void {
    this.registry.send(prompt);
  }

  /** Interrupt the active turn in a session. */
  interrupt(sessionId: string): void {
    this.registry.interrupt(sessionId);
  }

  /** Route a user's answer to a QuestionBlock back to the adapter. */
  answerQuestion(answer: QuestionAnswer): void {
    this.registry.answer(answer);
  }

  /** Shut down a single session. */
  async closeSession(sessionId: string): Promise<void> {
    await this.registry.closeSession(sessionId);
  }

  /** List all active sessions. */
  listSessions(): Session[] {
    return this.registry.listSessions();
  }

  /**
   * Relay an approval decision to the adapter for a given session.
   * The registry performs the authoritative stale-version check before
   * forwarding anything to the adapter.
   */
  decide(input: SessionDecisionInput): void {
    this.registry.decide(input);
  }

  /** Shut down the bridge and all sessions. */
  async shutdown(): Promise<void> {
    await this.registry.shutdown();
  }

  // -- Snapshot / status ----------------------------------------------------

  /** Return the full accumulated state for a session (for reconnect). */
  getSessionSnapshot(sessionId: string): SessionState | null {
    return this.registry.getSessionSnapshot(sessionId);
  }

  /** Return lightweight summaries of all active sessions. */
  getSessionSummaries(): SessionSummary[] {
    return this.registry.getSessionSummaries();
  }

  // -- Event distribution ---------------------------------------------------

  /** Subscribe to all Pairing events from all sessions (receives SequencedEvents). */
  onEvent(listener: (event: SequencedEvent) => void): () => void {
    return this.registry.onEvent((sequenced) => {
      if (sequenced.event.event !== "block:delta") {
        log.debug("event", `seq=${sequenced.seq} ${sequenced.event.event}`);
      }
      listener(sequenced);
    });
  }

  /** Replay buffered events for one session after `afterSeq`. */
  replay(sessionId: string, afterSeq: number): SequencedEvent[] {
    return this.registry.replay(sessionId, afterSeq);
  }

  /** Highest sequence number assigned for a session (0 if no events yet). */
  currentSeq(sessionId: string): number {
    return this.registry.currentSeq(sessionId);
  }

  /** Oldest buffered sequence number for a session (0 if its buffer is empty). */
  oldestBufferedSeq(sessionId: string): number {
    return this.registry.oldestBufferedSeq(sessionId);
  }
}
