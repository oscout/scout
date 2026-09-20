import { describe, expect, test } from "bun:test";

import {
  EMPTY_LEDGER,
  actionTickLabel,
  formatVoiceQuote,
  isQuietVoiceTurn,
  reduceLedger,
  turnFloor,
  turnSettle,
  turnTotal,
  type VoiceLedger,
} from "./voice-turn-ledger.ts";

function play(events: Parameters<typeof reduceLedger>[1][]): VoiceLedger {
  return events.reduce(reduceLedger, EMPTY_LEDGER);
}

describe("voice turn ledger", () => {
  test("a GPT turn records you, Live, a lookup, a navigate, then Live again", () => {
    const origin = 1_000_000;
    const ledger = play([
      { t: "speech", speaker: "you", at: origin, end: origin + 1400, text: "open the PR" },
      { t: "speech", speaker: "live", at: origin + 1900, end: origin + 3100, text: "Checking the branch now." },
      { t: "bot-open", at: origin + 1950, label: "Scout lookup" },
      { t: "bot-close", at: origin + 5900 },
      { t: "action", at: origin + 5950, label: "navigate /work" },
      { t: "speech", speaker: "live", at: origin + 6400, end: origin + 9200, text: "Opened it." },
      { t: "close", at: origin + 9200 },
    ]);
    expect(ledger.turns).toHaveLength(1);
    const turn = ledger.turns[0]!;
    expect(turn.quote).toContain("open the PR");
    expect(turn.spans.some((s) => s.lane === "you")).toBe(true);
    expect(turn.spans.some((s) => s.lane === "live")).toBe(true);
    expect(turn.spans.some((s) => s.lane === "scoutbot" && s.end !== null)).toBe(true);
    expect(turn.ticks.map((t) => t.label)).toEqual(["navigate /work"]);
    expect(turnTotal(turn)).toBeGreaterThan(8);
    expect(turnSettle(turn)).toContain("navigate /work");
    expect(turnSettle(turn)).toContain("Scoutbot");
  });

  test("a second user utterance after a gap is a new turn", () => {
    const origin = 1_000_000;
    const ledger = play([
      { t: "speech", speaker: "you", at: origin, end: origin + 1000, text: "first" },
      { t: "close", at: origin + 1200 },
      { t: "speech", speaker: "you", at: origin + 4000, end: origin + 5200, text: "second" },
    ]);
    expect(ledger.turns).toHaveLength(2);
    expect(ledger.turns[0]!.quote).toContain("first");
    expect(ledger.turns[1]!.quote).toContain("second");
  });

  test("local serial phases land on host, scoutbot, voice, then a tick", () => {
    const origin = 2_000_000;
    const ledger = play([
      { t: "you-open", at: origin },
      { t: "you-close", at: origin + 2200, text: "and the voice branch?" },
      { t: "host-open", at: origin + 2200, label: "transcribe · parakeet" },
      { t: "host-close", at: origin + 2900 },
      { t: "bot-open", at: origin + 2900 },
      { t: "action", at: origin + 6400, label: "navigate /work" },
      { t: "bot-close", at: origin + 6400 },
      { t: "prep-open", at: origin + 6500, label: "prepare" },
      { t: "speak-open", at: origin + 7300, text: "The voice branch pushed at 16:52" },
      { t: "speak-close", at: origin + 11300 },
      { t: "close", at: origin + 11300 },
    ]);
    const turn = ledger.turns[0]!;
    expect(turn.spans.map((s) => s.lane)).toEqual(["you", "host", "scoutbot", "voice", "voice"]);
    expect(turn.ticks[0]!.label).toBe("navigate /work");
    expect(turnSettle(turn)).toContain("spoken");
  });

  test("actionTickLabel names navigate and ask", () => {
    expect(actionTickLabel({ type: "navigate", route: { view: "work" } })).toBe("navigate /work");
    expect(actionTickLabel({ type: "ask-agent", targetLabel: "blink" })).toBe("ask blink");
  });

  test("reset clears the call", () => {
    const ledger = play([
      { t: "you-open", at: 10 },
      { t: "reset" },
    ]);
    expect(ledger.turns).toHaveLength(0);
  });

  test("an open host is transcribing, not a Scoutbot lookup", () => {
    const origin = 3_000_000;
    const ledger = play([
      { t: "you-open", at: origin },
      { t: "you-close", at: origin + 1700, text: "" },
      { t: "host-open", at: origin + 1700, label: "transcribe" },
    ]);
    const turn = ledger.turns[0]!;
    expect(turnFloor(turn, 38.5).who).toBe("Scoutbot");
    expect(turnFloor(turn, 38.5).beneath).toBe("transcribing");
    expect(turnSettle(turn, 38.5)).toContain("transcribe");
    expect(turnSettle(turn, 38.5)).not.toContain("Scoutbot");
  });

  test("bot-open takes the floor after transcribe, named by its label", () => {
    const origin = 4_000_000;
    const ledger = play([
      { t: "you-open", at: origin },
      { t: "you-close", at: origin + 1000 },
      { t: "host-open", at: origin + 1000 },
      { t: "bot-open", at: origin + 1600 },
    ]);
    const floor = turnFloor(ledger.turns[0]!, 8);
    expect(floor.who).toBe("Scoutbot");
    expect(floor.beneath).toBe("Scout lookup");
    expect(turnSettle(ledger.turns[0]!, 8)).toContain("Scoutbot");
  });

  test("a reply-model bot span names the model on the floor", () => {
    const origin = 5_000_000;
    const ledger = play([
      { t: "you-open", at: origin },
      { t: "you-close", at: origin + 900 },
      { t: "bot-open", at: origin + 1200, label: "gpt-5.6-luna" },
    ]);
    const floor = turnFloor(ledger.turns[0]!, 7);
    expect(floor.who).toBe("Scoutbot");
    expect(floor.beneath).toBe("gpt-5.6-luna");
  });

  test("tts generation and playback split into separate spans and settle parts", () => {
    const origin = 6_000_000;
    const ledger = play([
      { t: "you-open", at: origin },
      { t: "you-close", at: origin + 800 },
      { t: "bot-open", at: origin + 900, label: "gpt-5.6-luna" },
      { t: "bot-close", at: origin + 3900 },
      { t: "prep-open", at: origin + 3900, label: "tts" },
      { t: "speak-open", at: origin + 5100, text: "It is on the voice branch." },
      { t: "speak-close", at: origin + 7000 },
      { t: "close", at: origin + 7000 },
    ]);
    const turn = ledger.turns[0]!;
    const prep = turn.spans.find((s) => s.tone === "prep")!;
    const speak = turn.spans.find((s) => s.tone === "speak")!;
    expect(prep.end).toBeCloseTo(5.1, 3);
    expect(speak.start).toBeCloseTo(5.1, 3);
    expect(turnSettle(turn)).toContain("tts 1.2s");
    expect(turnSettle(turn)).toContain("spoken 1.9s");
  });

  test("the floor is held while speech is generated, not just while it plays", () => {
    const origin = 7_000_000;
    const ledger = play([
      { t: "you-open", at: origin },
      { t: "you-close", at: origin + 800 },
      { t: "bot-open", at: origin + 900 },
      { t: "prep-open", at: origin + 2000, label: "tts" },
    ]);
    const floor = turnFloor(ledger.turns[0]!, 3);
    expect(floor.who).toBe("Scout");
    expect(floor.beneath).toBe("tts");
  });

  test("discarding a take during transcribe seals the turn without a scoutbot span", () => {
    const origin = 8_000_000;
    const ledger = play([
      { t: "you-open", at: origin },
      { t: "you-close", at: origin + 1400 },
      { t: "host-open", at: origin + 1400, label: "transcribe" },
      { t: "host-close", at: origin + 2100 },
      { t: "close", at: origin + 2100 },
    ]);
    const turn = ledger.turns[0]!;
    expect(turn.spans.every((s) => s.end !== null)).toBe(true);
    expect(turn.spans.some((s) => s.lane === "scoutbot")).toBe(false);
    expect(turn.spans.some((s) => s.lane === "voice")).toBe(false);
    const settle = turnSettle(turn);
    expect(settle).toContain("transcribe");
    expect(settle).not.toContain("Scoutbot");
    expect(settle).not.toContain("spoken");
  });

  test("cancelling an in-flight reply seals the scoutbot span and never speaks", () => {
    const origin = 9_000_000;
    const ledger = play([
      { t: "you-open", at: origin },
      { t: "you-close", at: origin + 900 },
      { t: "host-open", at: origin + 900, label: "transcribe" },
      { t: "host-close", at: origin + 1500 },
      { t: "bot-open", at: origin + 1600, label: "gpt-5.6-luna" },
      { t: "bot-close", at: origin + 7400 },
      { t: "close", at: origin + 7400 },
    ]);
    const turn = ledger.turns[0]!;
    const bot = turn.spans.find((s) => s.lane === "scoutbot")!;
    expect(bot.end).toBeCloseTo(7.4, 3);
    expect(turn.spans.some((s) => s.lane === "voice")).toBe(false);
    const settle = turnSettle(turn);
    expect(settle).toContain("Scoutbot 5.8s");
    expect(settle).not.toContain("tts");
    expect(settle).not.toContain("spoken");
  });

  test("stopping speech mid-preparation seals the prep span with no playback", () => {
    const origin = 10_000_000;
    const ledger = play([
      { t: "you-open", at: origin },
      { t: "you-close", at: origin + 900 },
      { t: "bot-open", at: origin + 1000, label: "gpt-5.6-luna" },
      { t: "bot-close", at: origin + 3000 },
      { t: "prep-open", at: origin + 3100, label: "tts" },
      { t: "speak-close", at: origin + 4200 },
      { t: "close", at: origin + 4200 },
    ]);
    const turn = ledger.turns[0]!;
    const prep = turn.spans.find((s) => s.tone === "prep")!;
    expect(prep.end).toBeCloseTo(4.2, 3);
    expect(turn.spans.some((s) => s.tone === "speak")).toBe(false);
    const settle = turnSettle(turn);
    expect(settle).toContain("tts 1.1s");
    expect(settle).not.toContain("spoken");
  });

  test("quote fragments join with a space and do not stutter", () => {
    const origin = 11_000_000;
    const ledger = play([
      { t: "speech", speaker: "you", at: origin, end: origin + 400, text: "Devin" },
      { t: "speech", speaker: "you", at: origin + 500, end: origin + 900, text: "Devin" },
      { t: "speech", speaker: "you", at: origin + 1000, end: origin + 1800, text: ", um, tell" },
    ]);
    expect(ledger.turns[0]!.quote).toBe("Devin um, tell");
  });

  test("a longer revision replaces a shorter quote", () => {
    const origin = 12_000_000;
    const ledger = play([
      { t: "speech", speaker: "you", at: origin, end: origin + 400, text: "Hey" },
      { t: "speech", speaker: "you", at: origin + 500, end: origin + 1400, text: "Hey, uh that's great" },
    ]);
    expect(ledger.turns[0]!.quote).toBe("Hey, uh that's great");
  });

  test("formatVoiceQuote strips leading commas and splits glued caps", () => {
    expect(formatVoiceQuote(", um, um, tell")).toBe("um, tell");
    expect(formatVoiceQuote("JustSayHi")).toBe("Just Say Hi");
    expect(formatVoiceQuote("that.Just say hi")).toBe("that. Just say hi");
  });

  test("filler micro-turns stay off the call list", () => {
    const origin = 13_000_000;
    const ledger = play([
      { t: "speech", speaker: "you", at: origin, end: origin + 200, text: "11" },
    ]);
    expect(isQuietVoiceTurn(ledger.turns[0]!)).toBe(true);
  });
});
