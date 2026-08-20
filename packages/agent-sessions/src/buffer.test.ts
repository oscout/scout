import { describe, expect, test } from "bun:test";

import { OutboundBuffer } from "./buffer.ts";
import type { AgentSessionStreamEvent } from "./protocol/index.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid AgentSessionStreamEvent for testing purposes. */
function makeEvent(id: number): AgentSessionStreamEvent {
  return {
    event: "session:closed",
    sessionId: `session-${id}`,
  };
}

/** Push n events and return the sequence numbers assigned. */
function pushN(buf: OutboundBuffer, n: number, startId = 1): number[] {
  const seqs: number[] = [];
  for (let i = 0; i < n; i++) {
    seqs.push(buf.push(makeEvent(startId + i)));
  }
  return seqs;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe("OutboundBuffer — construction", () => {
  test("capacity < 1 throws", () => {
    expect(() => new OutboundBuffer(0)).toThrow("Buffer capacity must be at least 1");
    expect(() => new OutboundBuffer(-5)).toThrow("Buffer capacity must be at least 1");
  });

  test("default construction succeeds (capacity 500)", () => {
    const buf = new OutboundBuffer();
    expect(buf.currentSeq()).toBe(0);
    expect(buf.oldestSeq()).toBe(0);
  });

  test("capacity = 1 is accepted", () => {
    const buf = new OutboundBuffer(1);
    expect(buf.currentSeq()).toBe(0);
    expect(buf.oldestSeq()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Sequence accessors on empty buffer
// ---------------------------------------------------------------------------

describe("OutboundBuffer — empty buffer accessors", () => {
  test("currentSeq returns 0 when empty", () => {
    const buf = new OutboundBuffer(10);
    expect(buf.currentSeq()).toBe(0);
  });

  test("oldestSeq returns 0 when empty", () => {
    const buf = new OutboundBuffer(10);
    expect(buf.oldestSeq()).toBe(0);
  });

  test("replay on empty buffer returns []", () => {
    const buf = new OutboundBuffer(10);
    expect(buf.replay(0)).toEqual([]);
    expect(buf.replay(5)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// push — sequence numbering
// ---------------------------------------------------------------------------

describe("OutboundBuffer — push assigns monotonic seq", () => {
  test("first push returns seq 1", () => {
    const buf = new OutboundBuffer(10);
    expect(buf.push(makeEvent(1))).toBe(1);
  });

  test("each push increments seq by 1", () => {
    const buf = new OutboundBuffer(10);
    const seqs = pushN(buf, 5);
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
  });

  test("currentSeq reflects the last pushed seq", () => {
    const buf = new OutboundBuffer(10);
    pushN(buf, 3);
    expect(buf.currentSeq()).toBe(3);
  });

  test("oldestSeq = 1 after first push", () => {
    const buf = new OutboundBuffer(10);
    buf.push(makeEvent(1));
    expect(buf.oldestSeq()).toBe(1);
  });

  test("oldestSeq stays at 1 while buffer is not full", () => {
    const buf = new OutboundBuffer(10);
    pushN(buf, 7);
    expect(buf.oldestSeq()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// replay — core semantics
// ---------------------------------------------------------------------------

describe("OutboundBuffer — replay semantics", () => {
  test("replay(0) returns all buffered events", () => {
    const buf = new OutboundBuffer(10);
    pushN(buf, 5);
    const result = buf.replay(0);
    expect(result.length).toBe(5);
    expect(result.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  test("replay from a mid-point returns only later events", () => {
    const buf = new OutboundBuffer(10);
    pushN(buf, 5);
    const result = buf.replay(3);
    expect(result.length).toBe(2);
    expect(result.map((e) => e.seq)).toEqual([4, 5]);
  });

  test("replay(afterSeq = currentSeq) returns empty (caught up)", () => {
    const buf = new OutboundBuffer(10);
    pushN(buf, 5);
    expect(buf.replay(5)).toEqual([]);
  });

  test("replay(afterSeq > currentSeq) returns empty (beyond current)", () => {
    const buf = new OutboundBuffer(10);
    pushN(buf, 5);
    expect(buf.replay(99)).toEqual([]);
  });

  test("replay results carry the original event payload", () => {
    const buf = new OutboundBuffer(10);
    const ev = makeEvent(42);
    buf.push(ev);
    const result = buf.replay(0);
    expect(result.length).toBe(1);
    expect(result[0].event).toEqual(ev);
  });

  test("replay results carry a numeric seq and a timestamp", () => {
    const buf = new OutboundBuffer(10);
    buf.push(makeEvent(1));
    const result = buf.replay(0);
    expect(typeof result[0].seq).toBe("number");
    expect(typeof result[0].timestamp).toBe("number");
  });

  test("replay returns events in ascending seq order", () => {
    const buf = new OutboundBuffer(10);
    pushN(buf, 8);
    const seqs = buf.replay(0).map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  test("replay(1) returns events from seq 2 onwards", () => {
    const buf = new OutboundBuffer(10);
    pushN(buf, 4);
    const result = buf.replay(1);
    expect(result.map((e) => e.seq)).toEqual([2, 3, 4]);
  });
});

// ---------------------------------------------------------------------------
// Eviction — ring-buffer wrapping
// ---------------------------------------------------------------------------

describe("OutboundBuffer — eviction (capacity exceeded)", () => {
  test("oldest entry is evicted when buffer is full", () => {
    const buf = new OutboundBuffer(3);
    pushN(buf, 4); // push 4 into a capacity-3 buffer; seq 1 evicted
    expect(buf.oldestSeq()).toBe(2);
    expect(buf.currentSeq()).toBe(4);
  });

  test("replay(0) after eviction returns only buffered events", () => {
    const buf = new OutboundBuffer(3);
    pushN(buf, 5); // seqs 1,2 evicted; 3,4,5 remain
    const result = buf.replay(0);
    expect(result.map((e) => e.seq)).toEqual([3, 4, 5]);
  });

  test("replay of an evicted seq returns everything available (oldest-floor behaviour)", () => {
    const buf = new OutboundBuffer(3);
    pushN(buf, 5); // seqs 1,2 evicted; 3,4,5 remain
    // Asking for events after seq 1 (evicted) should return from oldest available
    const result = buf.replay(1);
    expect(result.map((e) => e.seq)).toEqual([3, 4, 5]);
  });

  test("replay of seq just before oldest returns everything", () => {
    const buf = new OutboundBuffer(3);
    pushN(buf, 5); // oldest = 3
    const result = buf.replay(2); // afterSeq=2 < oldest=3 → return everything
    expect(result.map((e) => e.seq)).toEqual([3, 4, 5]);
  });

  test("oldestSeq advances by 1 for each eviction", () => {
    const buf = new OutboundBuffer(3);
    pushN(buf, 3); // full: oldest=1
    expect(buf.oldestSeq()).toBe(1);
    buf.push(makeEvent(99)); // evicts seq 1
    expect(buf.oldestSeq()).toBe(2);
    buf.push(makeEvent(100)); // evicts seq 2
    expect(buf.oldestSeq()).toBe(3);
  });

  test("capacity=1: each push evicts the previous", () => {
    const buf = new OutboundBuffer(1);
    buf.push(makeEvent(1));
    buf.push(makeEvent(2));
    buf.push(makeEvent(3));
    expect(buf.oldestSeq()).toBe(3);
    expect(buf.currentSeq()).toBe(3);
    const result = buf.replay(0);
    expect(result.map((e) => e.seq)).toEqual([3]);
  });

  test("replay from within still-buffered range works across the ring wrap", () => {
    const buf = new OutboundBuffer(4);
    pushN(buf, 6); // seqs 1,2 evicted; ring contains 3,4,5,6
    const result = buf.replay(4);
    expect(result.map((e) => e.seq)).toEqual([5, 6]);
  });
});

// ---------------------------------------------------------------------------
// clear() — reset without seq reset
// ---------------------------------------------------------------------------

describe("OutboundBuffer — clear()", () => {
  test("clear empties the buffer", () => {
    const buf = new OutboundBuffer(10);
    pushN(buf, 5);
    buf.clear();
    expect(buf.replay(0)).toEqual([]);
  });

  test("count is 0 after clear: replay returns []", () => {
    const buf = new OutboundBuffer(10);
    pushN(buf, 5);
    buf.clear();
    expect(buf.replay(0)).toEqual([]);
    expect(buf.replay(3)).toEqual([]);
  });

  test("oldestSeq returns 0 after clear", () => {
    const buf = new OutboundBuffer(10);
    pushN(buf, 5);
    buf.clear();
    expect(buf.oldestSeq()).toBe(0);
  });

  test("currentSeq is preserved (seq numbers NOT reset) after clear", () => {
    const buf = new OutboundBuffer(10);
    pushN(buf, 5);
    buf.clear();
    // nextSeq is still 6, so currentSeq = 5 (unchanged)
    expect(buf.currentSeq()).toBe(5);
  });

  test("push after clear resumes from the next seq, not from 1", () => {
    const buf = new OutboundBuffer(10);
    pushN(buf, 5); // seqs 1-5
    buf.clear();
    const seq = buf.push(makeEvent(99));
    expect(seq).toBe(6); // monotonic: never restarts
    expect(buf.oldestSeq()).toBe(6);
    expect(buf.currentSeq()).toBe(6);
  });

  test("replay after clear+push returns only post-clear events", () => {
    const buf = new OutboundBuffer(10);
    pushN(buf, 5);
    buf.clear();
    pushN(buf, 3, 100); // seqs 6,7,8
    const result = buf.replay(0);
    expect(result.map((e) => e.seq)).toEqual([6, 7, 8]);
  });

  test("replay(afterSeq) with old pre-clear seq returns all post-clear events (oldest-floor)", () => {
    const buf = new OutboundBuffer(10);
    pushN(buf, 5);
    buf.clear();
    pushN(buf, 3, 100); // seqs 6,7,8; oldest = 6
    // Asking for after seq 2 (pre-clear, evicted) → oldest-floor → all
    const result = buf.replay(2);
    expect(result.map((e) => e.seq)).toEqual([6, 7, 8]);
  });
});

// ---------------------------------------------------------------------------
// Table-driven: replay edge-cases across various sizes
// ---------------------------------------------------------------------------

describe("OutboundBuffer — table: replay edge-cases", () => {
  const cases: Array<{
    label: string;
    capacity: number;
    pushCount: number;
    afterSeq: number;
    expectedSeqs: number[];
  }> = [
    // exactly caught up
    { label: "caught-up exactly", capacity: 5, pushCount: 5, afterSeq: 5, expectedSeqs: [] },
    // one behind
    { label: "one behind", capacity: 5, pushCount: 5, afterSeq: 4, expectedSeqs: [5] },
    // full replay
    { label: "full replay (afterSeq=0)", capacity: 5, pushCount: 5, afterSeq: 0, expectedSeqs: [1, 2, 3, 4, 5] },
    // buffer has only 1 event
    { label: "single event, replay(0)", capacity: 5, pushCount: 1, afterSeq: 0, expectedSeqs: [1] },
    // with eviction, afterSeq = 0
    { label: "eviction, replay(0)", capacity: 3, pushCount: 5, afterSeq: 0, expectedSeqs: [3, 4, 5] },
    // with eviction, afterSeq = evicted
    { label: "eviction, afterSeq evicted", capacity: 3, pushCount: 5, afterSeq: 1, expectedSeqs: [3, 4, 5] },
    // with eviction, afterSeq within window
    { label: "eviction, afterSeq mid-window", capacity: 3, pushCount: 5, afterSeq: 3, expectedSeqs: [4, 5] },
    // far beyond
    { label: "far beyond currentSeq", capacity: 5, pushCount: 3, afterSeq: 100, expectedSeqs: [] },
  ];

  for (const { label, capacity, pushCount, afterSeq, expectedSeqs } of cases) {
    test(label, () => {
      const buf = new OutboundBuffer(capacity);
      pushN(buf, pushCount);
      const result = buf.replay(afterSeq);
      expect(result.map((e) => e.seq)).toEqual(expectedSeqs);
    });
  }
});
