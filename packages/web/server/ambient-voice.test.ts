import { describe, expect, test } from "bun:test";
import {
  AMBIENT_BUFFER_MS,
  AmbientTranscriptBuffer,
  detectAmbientSubmit,
  selectAmbientExcerpt,
  type AmbientSegment,
} from "./ambient-voice.ts";

const S = 1_000;

describe("detectAmbientSubmit", () => {
  test("submits on Scout plus a hand-off verb at the end, in either order", () => {
    expect(detectAmbientSubmit("Okay Scout, send it.")).toMatchObject({ command: "" });
    expect(detectAmbientSubmit("scout go")).toMatchObject({ command: "" });
    expect(detectAmbientSubmit("Over to you, Scout.")).toMatchObject({ command: "" });
    expect(detectAmbientSubmit("Make that a ticket for the web lane. Okay Scout, take it from here."))
      .toMatchObject({ command: "Make that a ticket for the web lane." });
  });

  test("talking about Scout, or a verb mid-sentence, is not a submit", () => {
    expect(detectAmbientSubmit("Scout is doing great today")).toBeNull();
    expect(detectAmbientSubmit("I think Scout should go ahead with the release tomorrow")).toBeNull();
    expect(detectAmbientSubmit("send it to the team")).toBeNull();
    expect(detectAmbientSubmit("the scouting report, go")).toBeNull();
  });

  test("a submit mid-segment counts, and what follows it is kept for next time", () => {
    expect(detectAmbientSubmit("Okay, Scout, send it. Hey, I'd like to see if this works."))
      .toMatchObject({ command: "", after: "Hey, I'd like to see if this works." });
    expect(detectAmbientSubmit("open the homepage? Okay, scout, send it. Okay, Scout, send it."))
      .toMatchObject({ command: "open the homepage?", after: "" });
    expect(detectAmbientSubmit("Scout, go ahead with the release")).toBeNull();
  });

  test("reads an anchor or a lookback from the words before the phrase", () => {
    expect(detectAmbientSubmit("Summarize everything since I said the release plan. Scout, go.")?.anchor)
      .toBe("the release plan");
    expect(detectAmbientSubmit("Take the last two minutes and file it. Okay Scout, send it")?.lookbackMs)
      .toBe(120 * S);
    expect(detectAmbientSubmit("use the last 30 seconds, scout go")?.lookbackMs).toBe(30 * S);
    expect(detectAmbientSubmit("the last hundred minutes please. Scout, go")?.lookbackMs ?? null).toBeNull();
  });
});

describe("selectAmbientExcerpt", () => {
  const talk: AmbientSegment[] = [
    { text: "unrelated chatter about lunch", at: 0 },
    { text: "ok so the release plan is to cut Friday", at: 60 * S },
    { text: "and the web tests need to be green first", at: 70 * S },
    { text: "also ping the iOS lane", at: 80 * S },
  ];
  const plain = { command: "", anchor: null, lookbackMs: null };

  test("by default takes continuous talk back to the last long pause", () => {
    const excerpt = selectAmbientExcerpt({ segments: talk, submit: plain, now: 85 * S });
    expect(excerpt).toMatchObject({ reason: "pause", segmentCount: 3, startedAt: 60 * S });
  });

  test("the cap bounds a long unbroken monologue", () => {
    const monologue = Array.from({ length: 30 }, (_, i) => ({ text: `line ${i}`, at: i * 10 * S }));
    const excerpt = selectAmbientExcerpt({ segments: monologue, submit: plain, now: 300 * S });
    expect(excerpt?.reason).toBe("cap");
    expect(excerpt!.startedAt).toBeGreaterThanOrEqual(180 * S);
  });

  test("an anchor starts at the latest segment that mentions it", () => {
    const excerpt = selectAmbientExcerpt({
      segments: talk,
      submit: { ...plain, anchor: "release plan" },
      now: 200 * S,
    });
    expect(excerpt).toMatchObject({ reason: "anchor", startedAt: 60 * S, segmentCount: 3 });
  });

  test("a lookback counts back from now", () => {
    const excerpt = selectAmbientExcerpt({ segments: talk, submit: { ...plain, lookbackMs: 20 * S }, now: 85 * S });
    expect(excerpt).toMatchObject({ reason: "lookback", startedAt: 70 * S });
  });

  test("an anchor that isn't found falls back to the default cut", () => {
    const excerpt = selectAmbientExcerpt({ segments: talk, submit: { ...plain, anchor: "quantum bananas" }, now: 85 * S });
    expect(excerpt?.reason).toBe("pause");
  });
});

describe("AmbientTranscriptBuffer", () => {
  test("a submit sends the lead-in with the excerpt and never resends it", () => {
    const buffer = new AmbientTranscriptBuffer();
    expect(buffer.push({ text: "the flaky test is in routes", at: 0 })).toBeNull();
    const first = buffer.push({ text: "file a ticket for it, okay Scout, send it", at: 5 * S });
    expect(first?.excerpt?.text).toBe("the flaky test is in routes file a ticket for it");

    const second = buffer.push({ text: "Scout, go", at: 8 * S });
    expect(second?.excerpt).toBeNull();
  });

  test("a submit split across two finalized segments still fires", () => {
    const buffer = new AmbientTranscriptBuffer();
    buffer.push({ text: "open the homepage", at: 0 });
    expect(buffer.push({ text: "Okay, Scout,", at: 2 * S })).toBeNull();
    const result = buffer.push({ text: "send it.", at: 3 * S });
    expect(result?.excerpt?.text).toBe("open the homepage");
  });

  test("the live transcript submits at once, and its final segment isn't sent again", () => {
    const buffer = new AmbientTranscriptBuffer();
    buffer.push({ text: "the flaky test is in routes", at: 0 });
    expect(buffer.pushPartial({ text: "file a ticket, okay Scout, send", at: 2 * S })?.excerpt?.text)
      .toBe("the flaky test is in routes file a ticket");
    expect(buffer.pushPartial({ text: "file a ticket, okay Scout, send it", at: 2.5 * S })).toBeNull();
    expect(buffer.push({ text: "file a ticket, okay Scout, send it. Next thing", at: 3 * S })).toBeNull();
    expect(buffer.snapshot().segmentCount).toBe(3);
    expect(buffer.push({ text: "Scout, go", at: 4 * S })?.excerpt?.text).toBe("Next thing");
  });

  test("keeps only the rolling window", () => {
    const buffer = new AmbientTranscriptBuffer();
    buffer.push({ text: "old", at: 0 });
    buffer.push({ text: "new", at: AMBIENT_BUFFER_MS + 1 });
    expect(buffer.snapshot().segmentCount).toBe(1);
  });
});
