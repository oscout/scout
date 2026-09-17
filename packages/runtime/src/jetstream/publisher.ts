import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { MessageRecord } from "@openscout/protocol";

import type {
  BrokerJournalEntry,
  BrokerJournalReplayBarrier,
  BrokerJournalReplayBoundary,
  BrokerJournalReplayOptions,
} from "../broker-journal.js";
import type { JetStreamRuntimeConfig } from "./config.js";
import type { ScoutJetStreamConnection } from "./connection.js";
import {
  jetStreamSubject,
  messagePostedStreamEvent,
  type ScoutStreamEvent,
} from "./events.js";

/**
 * Journal projection identity for publisher progress.
 *
 * Deliberately distinct from the SQLite projection's `control-plane` id so the
 * two checkpoints can never clobber each other in the shared journal.
 */
export const JETSTREAM_PUBLISHER_PROJECTION_ID = "jetstream-publisher";
export const JETSTREAM_PUBLISHER_PROJECTION_VERSION = 1;

/** The minimal journal surface the publisher needs; keeps tests free of a real journal. */
export type JetStreamPublisherJournal = {
  captureReplayBoundary(options?: {
    barrier?: BrokerJournalReplayBarrier;
  }): Promise<BrokerJournalReplayBoundary>;
  replay(
    visitor: (entry: BrokerJournalEntry) => void | Promise<void>,
    boundary?: BrokerJournalReplayBoundary,
    options?: BrokerJournalReplayOptions,
  ): Promise<{ afterBarrierFound: boolean; visitedEntries: number }>;
};

type PersistedProgress = {
  version: 1;
  projectionId: string;
  projectionVersion: number;
  barrierId: string;
  updatedAt: number;
};

export type JetStreamPublisherStatus = {
  state: "stopped" | "catching_up" | "live" | "degraded";
  /** Startup refused to resume; nothing will be published until it is cleared. */
  blocked: boolean;
  detail: string | null;
  /** Committed barrier id; null until the first successful checkpoint. */
  checkpointBarrierId: string | null;
  queued: number;
  publishedEvents: number;
  duplicateEvents: number;
  failedPasses: number;
  lastPublishedAt: number | null;
  lastCheckpointAt: number | null;
  droppedFromQueue: number;
};

export type JetStreamPublisherOptions = {
  config: JetStreamRuntimeConfig;
  connection: ScoutJetStreamConnection;
  journal: JetStreamPublisherJournal;
  publisherNodeId: string;
  now?: () => number;
  log?: (message: string, detail?: unknown) => void;
  warn?: (message: string, detail?: unknown) => void;
  error?: (message: string, detail?: unknown) => void;
};

/**
 * Absent and unreadable are different answers.
 *
 * Absent means "never enabled here" and legitimately starts at `now`. A file
 * that exists but cannot be understood means progress is unknown, and silently
 * restarting at `now` there would skip every source record committed since the
 * last real checkpoint. That case fails closed.
 */
export type JetStreamPublisherProgressRead =
  | { kind: "absent" }
  | { kind: "invalid"; reason: string }
  | { kind: "ok"; progress: PersistedProgress };

export function readJetStreamPublisherProgress(path: string): JetStreamPublisherProgressRead {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "absent" };
    return { kind: "invalid", reason: `progress file is unreadable: ${String(error)}` };
  }
  let parsed: Partial<PersistedProgress>;
  try {
    parsed = JSON.parse(raw) as Partial<PersistedProgress>;
  } catch (error) {
    return { kind: "invalid", reason: `progress file is not valid JSON: ${String(error)}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "invalid", reason: "progress must be a JSON object" };
  }
  if (parsed.version !== 1) {
    return { kind: "invalid", reason: `unsupported progress version ${String(parsed.version)}` };
  }
  if (parsed.projectionId !== JETSTREAM_PUBLISHER_PROJECTION_ID) {
    return { kind: "invalid", reason: `progress belongs to projection ${String(parsed.projectionId)}` };
  }
  if (parsed.projectionVersion !== JETSTREAM_PUBLISHER_PROJECTION_VERSION) {
    return {
      kind: "invalid",
      reason: `progress was written by publisher version ${String(parsed.projectionVersion)}, `
        + `this build is ${JETSTREAM_PUBLISHER_PROJECTION_VERSION}`,
    };
  }
  if (typeof parsed.barrierId !== "string" || parsed.barrierId.length === 0) {
    return { kind: "invalid", reason: "progress has no barrier id" };
  }
  return { kind: "ok", progress: parsed as PersistedProgress };
}

function writeJetStreamPublisherProgress(path: string, barrierId: string, at: number): void {
  const payload: PersistedProgress = {
    version: 1,
    projectionId: JETSTREAM_PUBLISHER_PROJECTION_ID,
    projectionVersion: JETSTREAM_PUBLISHER_PROJECTION_VERSION,
    barrierId,
    updatedAt: at,
  };
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * Publishes committed Scout records onto JetStream, recoverably.
 *
 * Two paths feed the same serialized worker:
 *
 * 1. **Live** — the durable store hands over the entries the journal just
 *    accepted. Low latency, but memory only.
 * 2. **Catch-up** — a replay barrier is appended to the journal, everything
 *    between the last committed barrier and that boundary is rescanned and
 *    republished, and only then is the new barrier persisted as progress.
 *
 * The second path is what makes the first recoverable: nothing is ever
 * acknowledged as published because a callback fired, only because a scan that
 * covered it completed against an acked stream. Republishing the overlap is the
 * point, not a defect — `Nats-Msg-Id` collapses it inside the duplicate window,
 * and consumers dedupe on the same key. This is at-least-once delivery. It
 * makes no exactly-once and no global-ordering claim.
 *
 * Progress is a barrier id, never a byte offset: journal compaction rewrites
 * every offset in the file but leaves barrier entries in place.
 */
export class JetStreamJournalPublisher {
  private work: Promise<void> = Promise.resolve();
  /** Live entries, each tagged with the order it was handed to us. */
  private queue: Array<{ seq: number; entry: BrokerJournalEntry }> = [];
  private queueSeq = 0;
  private committedBarrierId: string | null = null;
  private started = false;
  private stopped = false;
  /**
   * Set when startup refused to proceed (unreadable progress). Every
   * publishing and checkpointing path is closed while it is set: a blocked
   * publisher that still honoured `stop()`'s final pass would replay history it
   * explicitly declined to resume.
   */
  private blocked = false;
  /** True once a first-enable boundary has been captured and persisted. */
  private boundaryEstablished = false;
  private checkpointTimer: NodeJS.Timeout | null = null;
  /** Coalescing flags: one pending drain and one pending checkpoint, never N. */
  private drainScheduled = false;
  private checkpointScheduled = false;
  private status: JetStreamPublisherStatus = {
    state: "stopped",
    blocked: false,
    detail: null,
    checkpointBarrierId: null,
    queued: 0,
    publishedEvents: 0,
    duplicateEvents: 0,
    failedPasses: 0,
    lastPublishedAt: null,
    lastCheckpointAt: null,
    droppedFromQueue: 0,
  };

  private readonly now: () => number;

  constructor(private readonly options: JetStreamPublisherOptions) {
    this.now = options.now ?? Date.now;
  }

  snapshot(): JetStreamPublisherStatus {
    return { ...this.status, queued: this.queue.length, blocked: this.blocked };
  }

  /**
   * Establish the starting position and drain anything already committed.
   *
   * With no committed progress the default start position is `now`: a barrier
   * is placed and persisted without publishing anything before it, so enabling
   * the sidecar on an existing machine never dumps that machine's private
   * history into a new stream. `beginning` is the explicit opt-in.
   *
   * An unreadable progress file is not treated as "never enabled". It leaves
   * the publisher degraded and publishing nothing, because the alternative —
   * restarting at `now` — silently drops every record since the last real
   * checkpoint.
   */
  /**
   * Capture and persist the `now` start boundary, with no network involved.
   *
   * Called before the broker admits writes. Deferring it until the transport is
   * reachable would leave every record accepted in the meantime behind a
   * later-placed barrier, and a `now` start position would then skip them.
   * Resuming from an existing checkpoint needs nothing here.
   */
  async establishStartBoundary(): Promise<void> {
    if (this.started || this.blocked || this.boundaryEstablished) return;
    const read = readJetStreamPublisherProgress(this.options.config.progressPath);
    if (read.kind === "invalid") {
      this.blockOnInvalidProgress(read.reason);
      return;
    }
    if (read.kind === "ok") return;
    if (this.options.config.startPosition !== "now") return;
    try {
      await this.enqueue(() => this.runCatchUpPass({ publish: false }));
      if (!this.committedBarrierId) {
        this.blocked = true;
        return;
      }
      this.boundaryEstablished = true;
    } catch (error) {
      // A failed enable boundary must not be re-taken later, after writes have
      // already been accepted, or those writes would silently become history.
      this.blocked = true;
      this.failPass("could not persist the initial publication boundary", error);
    }
  }

  async start(): Promise<void> {
    if (this.started || this.blocked) return;
    const read = readJetStreamPublisherProgress(this.options.config.progressPath);
    if (read.kind === "invalid") {
      this.blockOnInvalidProgress(read.reason);
      return;
    }
    this.started = true;
    this.stopped = false;
    this.committedBarrierId = read.kind === "ok" ? read.progress.barrierId : null;
    this.status.checkpointBarrierId = this.committedBarrierId;

    // `establishStartBoundary()` normally already committed the first-enable
    // barrier. Re-derive here for callers that skipped it (tests, embedded use).
    const firstEnable = read.kind === "absent";
    const skipHistory = firstEnable && this.options.config.startPosition === "now";
    await this.enqueue(() => this.runCatchUpPass({ publish: !skipHistory }));

    this.checkpointTimer = setInterval(() => {
      this.scheduleCheckpoint();
    }, this.options.config.checkpointIntervalMs);
    this.checkpointTimer.unref?.();
  }

  /**
   * Hand over entries the canonical journal has just accepted.
   *
   * Called from `BrokerDurableStore.commitEntries` after `appendEntries`
   * resolves — the one chokepoint every Scout-owned record passes through, and
   * the one that is *not* abandoned on shutdown the way the projection queue is.
   * Non-blocking by design: a NATS round trip must never sit on the durable
   * write path a UI mutation is awaiting.
   */
  notifyCommitted(entries: BrokerJournalEntry[]): void {
    if (this.blocked || this.stopped || !this.started) return;
    const eligible = entries.filter(isPublishableEntry);
    if (eligible.length === 0) return;
    if (this.queue.length + eligible.length > this.options.config.maxQueuedEvents) {
      // Backpressure without unbounded memory: drop the live queue and let the
      // next catch-up pass republish from the journal, which is authoritative.
      this.status.droppedFromQueue += this.queue.length + eligible.length;
      this.queue = [];
      this.options.warn?.(
        "[openscout-jetstream] live publish queue exceeded "
          + `${this.options.config.maxQueuedEvents}; falling back to journal catch-up`,
      );
      this.scheduleCheckpoint();
      return;
    }
    for (const entry of eligible) {
      this.queueSeq += 1;
      this.queue.push({ seq: this.queueSeq, entry });
    }
    this.scheduleDrain();
  }

  /** Force a checkpoint now and wait for it. Used at shutdown and by tests. */
  async checkpoint(): Promise<void> {
    if (this.blocked) return;
    await this.enqueue(() => this.runCatchUpPass({ publish: true }));
  }

  async stop(): Promise<void> {
    if (this.checkpointTimer) {
      clearInterval(this.checkpointTimer);
      this.checkpointTimer = null;
    }
    if (this.blocked) {
      this.stopped = true;
      this.queue = [];
      return;
    }
    if (!this.started) return;
    // One last pass so a clean shutdown leaves an accurate barrier. Failure is
    // survivable: the next start rescans from the previous committed barrier.
    await this.enqueue(() => this.runCatchUpPass({ publish: true })).catch(() => undefined);
    this.stopped = true;
    this.started = false;
    this.queue = [];
    this.status.state = "stopped";
  }

  /**
   * At most one queued drain and one queued checkpoint exist at a time.
   *
   * Without this, a NATS outage turns every commit into another pending
   * closure on the work chain: the live queue stays bounded while the promise
   * chain behind it does not.
   */
  private scheduleDrain(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    void this.enqueue(async () => {
      this.drainScheduled = false;
      await this.drainQueue();
    }).catch(() => undefined);
  }

  private scheduleCheckpoint(): void {
    if (this.checkpointScheduled) return;
    this.checkpointScheduled = true;
    void this.enqueue(async () => {
      this.checkpointScheduled = false;
      await this.runCatchUpPass({ publish: true });
    }).catch(() => undefined);
  }

  private blockOnInvalidProgress(reason: string): void {
    this.blocked = true;
    this.started = false;
    this.failPass(
      `refusing to publish: ${reason} (${this.options.config.progressPath}). `
        + "Delete the file to restart from the configured start position, "
        + "accepting that records committed since the last checkpoint will not be published.",
      null,
    );
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.work.then(work, work);
    this.work = next.then(() => undefined, () => undefined);
    return next;
  }

  private async drainQueue(): Promise<void> {
    if (this.stopped || this.blocked) return;
    while (this.queue.length > 0) {
      const head = this.queue[0]!;
      try {
        await this.publishEntry(head.entry);
      } catch (error) {
        // Leave it queued: a catch-up pass will cover it from the journal, and
        // the barrier will not advance past it in the meantime.
        this.status.state = "degraded";
        this.status.detail = error instanceof Error ? error.message : String(error);
        return;
      }
      this.queue.shift();
    }
    if (this.status.state !== "degraded") this.status.state = "live";
  }

  private async publishEntry(entry: BrokerJournalEntry): Promise<void> {
    const event = streamEventForEntry(entry, this.options.publisherNodeId);
    if (!event) return;
    const receipt = await this.options.connection.publishEvent(
      jetStreamSubject({
        prefix: this.options.config.subjectPrefix,
        publisherNodeId: this.options.publisherNodeId,
        kind: event.kind,
        conversationId: event.conversationId,
      }),
      event,
    );
    this.status.publishedEvents += 1;
    if (receipt.duplicate) this.status.duplicateEvents += 1;
    this.status.lastPublishedAt = this.now();
  }

  /**
   * Barrier → rescan → publish → persist.
   *
   * The order matters. Persisting the barrier is the last step, so a crash
   * anywhere earlier resumes from the previous committed barrier and replays.
   *
   * Publication happens *inside* the replay visitor rather than into a
   * collected array: a long outage can leave an arbitrary number of records
   * behind the barrier, and buffering all of them would reintroduce exactly the
   * unbounded memory the live queue's cap exists to prevent.
   */
  private async runCatchUpPass(options: { publish: boolean }): Promise<void> {
    if (this.stopped || this.blocked) return;
    // Everything already handed to us is, by construction, behind the barrier
    // we are about to append: its journal append resolved before this capture
    // could be enqueued on the journal's write queue. Anything notified later
    // may fall either side, so it stays queued.
    const coveredThroughSeq = this.queueSeq;
    const barrier: BrokerJournalReplayBarrier = {
      id: randomUUID(),
      projectionId: JETSTREAM_PUBLISHER_PROJECTION_ID,
      projectionVersion: JETSTREAM_PUBLISHER_PROJECTION_VERSION,
      createdAt: this.now(),
    };
    let boundary: BrokerJournalReplayBoundary;
    try {
      boundary = await this.options.journal.captureReplayBoundary({ barrier });
    } catch (error) {
      this.failPass("failed to capture a journal replay barrier", error);
      return;
    }

    if (!options.publish) {
      // Explicit "start from now": commit the barrier without publishing the
      // history behind it.
      this.dropCoveredQueueEntries(coveredThroughSeq);
      this.commitBarrier(barrier.id);
      this.status.state = "live";
      return;
    }

    this.status.state = "catching_up";
    const afterBarrier = this.committedBarrierId
      ? {
          id: this.committedBarrierId,
          projectionId: JETSTREAM_PUBLISHER_PROJECTION_ID,
          projectionVersion: JETSTREAM_PUBLISHER_PROJECTION_VERSION,
        }
      : undefined;

    try {
      // `replay` invokes the visitor only for entries *after* the requested
      // barrier, so a missing barrier publishes nothing at all rather than
      // replaying the machine's whole history before we notice.
      const report = await this.options.journal.replay(
        async (entry) => {
          if (isPublishableEntry(entry)) await this.publishEntry(entry);
        },
        boundary,
        afterBarrier ? { afterBarrier } : {},
      );
      if (afterBarrier && !report.afterBarrierFound) {
        // The committed barrier is gone (a journal was replaced or truncated
        // out from under us). Refusing to guess is the safe move.
        this.failPass(
          `committed replay barrier ${this.committedBarrierId} is no longer in the journal; `
            + "publisher progress cannot be resumed without an explicit start position",
          null,
        );
        return;
      }
    } catch (error) {
      this.failPass("catch-up publish failed", error);
      return;
    }

    this.dropCoveredQueueEntries(coveredThroughSeq);
    this.commitBarrier(barrier.id);
    this.status.state = "live";
    this.status.detail = null;
    if (this.queue.length > 0) this.scheduleDrain();
  }

  private dropCoveredQueueEntries(coveredThroughSeq: number): void {
    this.queue = this.queue.filter((queued) => queued.seq > coveredThroughSeq);
  }

  private commitBarrier(barrierId: string): void {
    writeJetStreamPublisherProgress(this.options.config.progressPath, barrierId, this.now());
    this.committedBarrierId = barrierId;
    this.status.checkpointBarrierId = barrierId;
    this.status.lastCheckpointAt = this.now();
  }

  private failPass(message: string, error: unknown): void {
    this.status.failedPasses += 1;
    this.status.state = "degraded";
    this.status.detail = error ? `${message}: ${String(error)}` : message;
    this.options.warn?.(`[openscout-jetstream] ${this.status.detail}`);
  }
}

/**
 * Only canonical message records are published in this slice.
 *
 * Note what this excludes for free: `presence.updated` is not a journal entry
 * kind at all, so a journal-sourced publisher cannot leak presence into durable
 * storage even by mistake. That is structural, not a filter someone can drop.
 */
export function isPublishableEntry(
  entry: BrokerJournalEntry,
): entry is Extract<BrokerJournalEntry, { kind: "message.record" }> {
  return entry.kind === "message.record";
}

export function streamEventForEntry(
  entry: BrokerJournalEntry,
  publisherNodeId: string,
): ScoutStreamEvent | null {
  if (!isPublishableEntry(entry)) return null;
  const message = entry.message as MessageRecord;
  if (!message?.id || !message.conversationId) return null;
  return messagePostedStreamEvent({ message, publisherNodeId });
}
