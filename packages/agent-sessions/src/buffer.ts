// OutboundBuffer — a fixed-size ring buffer of sequenced session events.
//
// Every event emitted by an adapter gets assigned a monotonic sequence number
// and stored in this buffer.  When a client reconnects, it provides its
// last-seen seq and the embedding runtime replays everything after that point.
// This gives us seamless reconnection without persistence.

import type { AgentSessionStreamEvent } from "./protocol/index.js";

// ---------------------------------------------------------------------------
// Sequenced event — a session event annotated with ordering metadata
// ---------------------------------------------------------------------------

export interface SequencedEvent {
  /** Monotonic sequence number (starts at 1, never resets). */
  seq: number;
  /** The original session event. */
  event: AgentSessionStreamEvent;
  /** Unix epoch milliseconds when the event was buffered. */
  timestamp: number;
}

// ---------------------------------------------------------------------------
// OutboundBuffer
// ---------------------------------------------------------------------------

const DEFAULT_CAPACITY = 500;

export class OutboundBuffer {
  /** Fixed-size storage array. Slots are reused in a circular fashion. */
  private ring: (SequencedEvent | undefined)[];
  /** Maximum number of events the buffer can hold. */
  private capacity: number;
  /** Index of the next write position in the ring. */
  private head = 0;
  /** Total number of events currently stored. */
  private count = 0;
  /** Next sequence number to assign. */
  private nextSeq = 1;

  constructor(capacity: number = DEFAULT_CAPACITY) {
    if (capacity < 1) {
      throw new Error("Buffer capacity must be at least 1");
    }
    this.capacity = capacity;
    this.ring = new Array(capacity);
  }

  /**
   * Push an event into the buffer, assigning it the next sequence number.
   * If the buffer is full, the oldest event is evicted.
   *
   * @returns The assigned sequence number.
   */
  push(event: AgentSessionStreamEvent): number {
    const seq = this.nextSeq++;
    const entry: SequencedEvent = {
      seq,
      event,
      timestamp: Date.now(),
    };

    this.ring[this.head] = entry;
    this.head = (this.head + 1) % this.capacity;

    if (this.count < this.capacity) {
      this.count++;
    }

    return seq;
  }

  /**
   * Return all buffered events whose seq is strictly greater than `afterSeq`,
   * in sequence order.
   *
   * - afterSeq = 0 returns everything in the buffer.
   * - afterSeq >= currentSeq returns an empty array.
   * - afterSeq older than the oldest buffered event returns everything available.
   */
  replay(afterSeq: number): SequencedEvent[] {
    if (this.count === 0) return [];

    const oldest = this.oldestSeq();
    const current = this.currentSeq();

    // Nothing to replay if the client is already caught up.
    if (afterSeq >= current) return [];

    // Determine where to start reading.  If the client's last seq is older
    // than our oldest buffered event, give them everything we have.
    const effectiveStart = afterSeq < oldest ? oldest : afterSeq + 1;

    // Calculate how many events to skip from the tail of the ring.
    const skip = effectiveStart - oldest;
    const resultCount = this.count - skip;

    if (resultCount <= 0) return [];

    // The tail is where the oldest entry lives.
    const tail = (this.head - this.count + this.capacity) % this.capacity;
    const startIndex = (tail + skip) % this.capacity;

    const result: SequencedEvent[] = new Array(resultCount);
    for (let i = 0; i < resultCount; i++) {
      const idx = (startIndex + i) % this.capacity;
      result[i] = this.ring[idx]!;
    }

    return result;
  }

  /** The highest sequence number that has been assigned (0 if empty). */
  currentSeq(): number {
    return this.nextSeq - 1;
  }

  /** The sequence number of the oldest buffered event (0 if empty). */
  oldestSeq(): number {
    if (this.count === 0) return 0;
    const tail = (this.head - this.count + this.capacity) % this.capacity;
    return this.ring[tail]!.seq;
  }

  /** Discard all buffered events.  Sequence numbers are NOT reset. */
  clear(): void {
    this.ring = new Array(this.capacity);
    this.head = 0;
    this.count = 0;
  }
}
