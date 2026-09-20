import { describe, expect, mock, test } from "bun:test";

import {
  EMPTY_LEDGER,
  reduceLedger,
  turnFloor,
  turnTotal,
  type VoiceLedger,
  type VoiceLedgerEvent,
} from "../../lib/voice-turn-ledger.ts";

// @ts-expect-error Bun tests load React's runtime entrypoint directly to avoid local TS path aliases.
const React = await import("../../../node_modules/react/index.js");
// @ts-expect-error Bun tests load React's runtime entrypoint directly to avoid local TS path aliases.
const ReactJsxRuntime = await import("../../../node_modules/react/jsx-runtime.js");
// @ts-expect-error Bun tests load React's runtime entrypoint directly to avoid local TS path aliases.
const ReactJsxDevRuntime = await import("../../../node_modules/react/jsx-dev-runtime.js");
// @ts-expect-error Bun tests load React DOM's runtime entrypoint directly to avoid local TS path aliases.
const ReactDomServer = await import("../../../node_modules/react-dom/server.node.js");
const { createElement } = React;
const { renderToStaticMarkup } = ReactDomServer;

mock.module("react", () => React);
mock.module("react/jsx-runtime", () => ReactJsxRuntime);
mock.module("react/jsx-dev-runtime", () => ReactJsxDevRuntime);

const {
  VoiceTurnHero,
  VoiceTurnStageTrack,
  gptStageStops,
  localStageStops,
  voiceTurnQuoteWho,
} = await import("./VoiceTurnStage.tsx");
const { VoiceTurnSettle } = await import("./VoiceTurnView.tsx");

function play(events: VoiceLedgerEvent[]): VoiceLedger {
  return events.reduce(reduceLedger, EMPTY_LEDGER);
}

/* The fixture mirrors the study: 2.2s take, 0.2s transcribe, then the reply
   model works; later a 6.9s reply, 0.2s speech prep, and a spoken reply. */
const ORIGIN = 1_000_000;

function thinkingLedger(): VoiceLedger {
  return play([
    { t: "you-open", at: ORIGIN },
    { t: "you-close", at: ORIGIN + 2200, text: "and the voice branch?" },
    { t: "host-open", at: ORIGIN + 2200, label: "transcribe · parakeet" },
    { t: "host-close", at: ORIGIN + 2400 },
    { t: "bot-open", at: ORIGIN + 2400, label: "reply" },
  ]);
}

function speakingLedger(): VoiceLedger {
  return play([
    { t: "you-open", at: ORIGIN },
    { t: "you-close", at: ORIGIN + 2200, text: "and the voice branch?" },
    { t: "host-open", at: ORIGIN + 2200, label: "transcribe · parakeet" },
    { t: "host-close", at: ORIGIN + 2400 },
    { t: "bot-open", at: ORIGIN + 2400, label: "reply" },
    { t: "action", at: ORIGIN + 9600, label: "navigate /work" },
    { t: "prep-open", at: ORIGIN + 9300, label: "prepare" },
    { t: "prep-close", at: ORIGIN + 9500 },
    { t: "speak-open", at: ORIGIN + 9500, text: "On it." },
  ]);
}

describe("local stage stops", () => {
  test("no turn: every stop pending", () => {
    const stops = localStageStops(undefined, undefined, "marin");
    expect(stops.map((s) => s.state)).toEqual(["pending", "pending", "pending", "pending", "pending"]);
    expect(stops.map((s) => s.label)).toEqual(["you", "stt", "reply model", "marin", "speaker"]);
  });

  test("mid-reply: done stops carry durations, the reply model runs tenths", () => {
    const turn = thinkingLedger().turns[0]!;
    const stops = localStageStops(turn, 4.1, "marin");
    expect(stops[0]).toMatchObject({ key: "you", state: "done" });
    expect(stops[0]!.sec).toBeCloseTo(2.2, 5);
    expect(stops[1]).toMatchObject({ key: "stt", state: "done" });
    expect(stops[1]!.sec).toBeCloseTo(0.2, 5);
    expect(stops[2]!.state).toBe("active");
    expect(stops[2]!.sec).toBeCloseTo(1.7, 5);
    expect(stops[3]).toMatchObject({ key: "voice", label: "marin", state: "pending" });
    expect(stops[4]).toMatchObject({ key: "speaker", state: "pending" });
  });

  test("speaking: voice prep is done, the speaker stop is active, ticks count toward the reply stop", () => {
    const turn = speakingLedger().turns[0]!;
    const stops = localStageStops(turn, 10.6, null);
    expect(stops[2]!.state).toBe("done");
    // 2.4s → 9.3s of model work, plus the tool tick at 9.6s belonging to this stop.
    expect(stops[2]!.sec).toBeCloseTo(7.2, 5);
    expect(stops[3]).toMatchObject({ key: "voice", label: "voice", state: "done" });
    expect(stops[3]!.sec).toBeCloseTo(0.2, 5);
    expect(stops[4]!.state).toBe("active");
    expect(stops[4]!.sec).toBeCloseTo(1.1, 5);
  });

  test("a held turn without now renders done, never active", () => {
    const turn = speakingLedger().turns[0]!;
    const stops = localStageStops(turn, undefined, null);
    expect(stops.every((s) => s.state === "done" || s.state === "pending")).toBe(true);
  });
});

describe("gpt stage stops", () => {
  test("connecting keeps every stop pending for the sequential sweep", () => {
    const stops = gptStageStops({ state: "connecting", floorWho: "open", voiceName: "marin" });
    expect(stops.every((s) => s.state === "pending")).toBe(true);
    expect(stops[2]!.sky).toBe(true);
    expect(stops[3]!.sky).toBe(true);
    expect(stops[1]!.sky).toBeUndefined();
  });

  test("live opens the circuit and parks the active stop on the floor holder", () => {
    const byWho = (who: string) =>
      gptStageStops({ state: "live", floorWho: who, voiceName: null });
    expect(byWho("you").findIndex((s) => s.state === "active")).toBe(0);
    expect(byWho("Scoutbot").findIndex((s) => s.state === "active")).toBe(2);
    expect(byWho("Scout").findIndex((s) => s.state === "active")).toBe(2);
    expect(byWho("open").findIndex((s) => s.state === "active")).toBe(-1);
    expect(byWho("unknown").findIndex((s) => s.state === "active")).toBe(-1);
    expect(gptStageStops({ state: "live", floorWho: "Scout", speakOpen: true, voiceName: null })
      .findIndex((s) => s.state === "active")).toBe(4);
    for (const stops of [byWho("you"), byWho("Scoutbot")]) {
      expect(stops.filter((s) => s.state === "done")).toHaveLength(4);
      expect(stops.every((s) => s.sec === undefined)).toBe(true);
    }
  });

  test("idle and ended stay pending", () => {
    for (const state of ["idle", "ended", "error"]) {
      expect(gptStageStops({ state, floorWho: "open", voiceName: null }).every((s) => s.state === "pending")).toBe(true);
    }
  });
});

describe("stage track rendering", () => {
  test("connecting carries the modifier, live fills every link and blanks the clocks", () => {
    const connecting = renderToStaticMarkup(createElement(VoiceTurnStageTrack, {
      mode: "gpt-live",
      stops: gptStageStops({ state: "connecting", floorWho: "open", voiceName: "marin" }),
      connecting: true,
    }));
    expect(connecting).toContain("vp7-track--connecting");
    expect(connecting).toContain("openai realtime");

    const live = renderToStaticMarkup(createElement(VoiceTurnStageTrack, {
      mode: "gpt-live",
      stops: gptStageStops({ state: "live", floorWho: "Scoutbot", voiceName: "marin" }),
      continuous: true,
    }));
    expect(live.match(/vp7-link--filled/g)).toHaveLength(4);
    expect(live).toContain("vp7-stop--active");
    expect(live).not.toContain("vp7-link--filling");
  });

  test("a local turn in flight lights done stops and sweeps the active inbound link", () => {
    const markup = renderToStaticMarkup(createElement(VoiceTurnStageTrack, {
      mode: "local-live",
      stops: localStageStops(thinkingLedger().turns[0]!, 4.1, "marin"),
    }));
    expect(markup).toContain("vp7-stop--done");
    expect(markup).toContain("vp7-stop--active");
    expect(markup).toContain("vp7-link--filling");
    expect(markup).toContain("2.2s");
    expect(markup).toContain("1.7s");
    expect(markup).toContain('aria-label="Local Live path: you: done, 2.2s; stt: done, 0.2s; reply model: active, 1.7s; marin: pending; speaker: pending.');
    expect(markup).not.toContain("aria-live");
  });
});

describe("voice turn hero", () => {
  const turn = speakingLedger().turns[0]!;

  test("the take leads: quote, attribution, eyebrow with who · clock · story", () => {
    const markup = renderToStaticMarkup(createElement(VoiceTurnHero, {
      who: "Scout",
      whoTone: "wait",
      clock: "10.6s",
      story: "spoken reply · metered",
      quote: "and the voice branch?",
      quoteWho: voiceTurnQuoteWho(turn),
      turn,
      now: 10.6,
      live: true,
      onToggleLanes: () => {},
    }));
    expect(markup).toContain("vp7-hero-quote");
    expect(markup).toContain("and the voice branch?");
    expect(markup).toContain("— you");
    expect(markup).toContain("Scout");
    expect(markup).toContain("10.6s");
    expect(markup).toContain("spoken reply · metered");
    expect(markup).toContain("vp7-share");
    expect(markup).toContain("aria-pressed=\"false\"");
    expect(markup).toContain("vp7-share-seg--live");
    expect(markup).toContain("vp7-share-seg--you");
    expect(markup).toContain("vp7-share-seg--speak");
  });

  test("resting hero is the italic placeholder with the meter story", () => {
    const markup = renderToStaticMarkup(createElement(VoiceTurnHero, {
      who: "ready",
      story: "on-device STT · gpt-4o-mini-tts · marin · metered per reply",
      placeholder: "Tap, talk, send. The reply speaks.",
    }));
    expect(markup).toContain("vp7-hero-quote--rest");
    expect(markup).toContain("Tap, talk, send. The reply speaks.");
    expect(markup).toContain("ready");
    expect(markup).not.toContain("vp7-share");
  });

  test("a held turn keeps a static strip and an idle toggle", () => {
    const markup = renderToStaticMarkup(createElement(VoiceTurnHero, {
      who: "holding",
      quote: "and the voice branch?",
      turn,
      live: false,
      lanesOpen: true,
      onToggleLanes: () => {},
    }));
    expect(markup).toContain("aria-pressed=\"true\"");
    expect(markup).not.toContain("vp7-share-seg--live");
  });
});

describe("settle rail rows", () => {
  test("rows carry the mini strip and total; the live turn pins up top with a dot", () => {
    const first = play([
      { t: "you-open", at: ORIGIN - 60_000 },
      { t: "you-close", at: ORIGIN - 57_800, text: "ask blink to rerun the tests" },
      { t: "host-open", at: ORIGIN - 57_800 },
      { t: "host-close", at: ORIGIN - 57_600 },
      { t: "bot-open", at: ORIGIN - 57_600 },
      { t: "bot-close", at: ORIGIN - 54_000 },
      { t: "close", at: ORIGIN - 54_000 },
    ]);
    const both = [
      ...[
        { t: "you-open", at: ORIGIN },
        { t: "you-close", at: ORIGIN + 2200, text: "and the voice branch?" },
        { t: "host-open", at: ORIGIN + 2200 },
        { t: "host-close", at: ORIGIN + 2400 },
        { t: "bot-open", at: ORIGIN + 2400, label: "reply" },
      ] as VoiceLedgerEvent[],
    ].reduce(reduceLedger, first);
    const live = both.turns[1]!;
    const markup = renderToStaticMarkup(createElement(VoiceTurnSettle, {
      turns: both.turns,
      mode: "local-live",
      liveId: live.id,
      now: 4.1,
      onSelect: () => {},
    }));
    expect(markup).toContain("is-live");
    expect(markup).toContain("vtl-live-dot");
    expect(markup.match(/vtl-mini-strip/g)).toHaveLength(2);
    expect(markup.match(/vtl-settle-total/g)).toHaveLength(2);
    // The still-open turn reads its running total, not a frozen settle line.
    expect(markup).toContain("4.1s");
    expect(markup).not.toContain("vtl-settle-line");
    // Live row is first (pinned at the top of the reversed list).
    expect(markup.indexOf("vtl-live-dot")).toBeLessThan(markup.indexOf("ask blink to rerun the tests"));
  });
});

// Match the real GPT producer: transcript deltas carry finite start/end
// offsets; the context translates those offsets into wall-clock speech events.
// Exercise the reducer and the same endpoint fallback the page uses, rather
// than injecting a floor holder that these events cannot actually produce.
describe("GPT transcript ledger to stage/hero", () => {
  const speech = (speaker: "you" | "live", startMs: number, endMs: number, text: string): VoiceLedgerEvent => ({
    t: "speech", speaker, at: ORIGIN + startMs, end: ORIGIN + endMs, text,
  });

  test("finite input/output intervals leave current speech unknown, not falsely on you", () => {
    let ledger = EMPTY_LEDGER;
    for (const event of [
      speech("you", 0, 1200, "Check the fleet."),
      speech("live", 1500, 2200, "I will check."),
      speech("live", 2250, 3000, "One moment."),
    ]) {
      ledger = reduceLedger(ledger, event);
      const turn = ledger.turns.at(-1)!;
      expect(turn.spans.every((span) => span.end !== null)).toBe(true);
      const floor = turnFloor(turn, turnTotal(turn));
      expect(floor.who).toBe("open");
      const stops = gptStageStops({ state: "live", floorWho: floor.who, voiceName: "marin" });
      expect(stops.some((stop) => stop.state === "active")).toBe(false);
      const markup = renderToStaticMarkup(createElement(VoiceTurnStageTrack, {
        mode: "gpt-live", stops, continuous: true,
      }));
      expect(markup.match(/vp7-link--filled/g)).toHaveLength(4);
      expect(markup).toContain("current speaker not observed");
      expect(markup).not.toContain("vp7-stop--active");
    }
    // A real open lookup is still observed work and may light the cloud stop.
    ledger = reduceLedger(ledger, { t: "bot-open", at: ORIGIN + 3100 });
    const floor = turnFloor(ledger.turns.at(-1)!, 3.5);
    expect(gptStageStops({ state: "live", floorWho: floor.who, voiceName: null })
      .find((stop) => stop.state === "active")?.key).toBe("reply");
  });

  const hero = (ledger: VoiceLedger) => {
    const turn = ledger.turns.at(-1)!;
    return renderToStaticMarkup(createElement(VoiceTurnHero, {
      who: "open", quote: turn.quote, quoteWho: voiceTurnQuoteWho(turn), turn,
    }));
  };

  test("assistant-first greeting and mixed legacy quote are never attributed to you", () => {
    const greeting = play([speech("live", 0, 1200, "Hello, I am Scoutbot.")]);
    expect(greeting.turns[0]!.quote).toBe("Hello, I am Scoutbot.");
    expect(hero(greeting)).toContain("Hello, I am Scoutbot.");
    expect(hero(greeting)).not.toContain("vp7-quote-who");
    const mixed = reduceLedger(greeting, speech("you", 2000, 3000, "Check the fleet."));
    expect(mixed.turns).toHaveLength(1);
    expect(mixed.turns[0]!.quote).toContain("Check the fleet.");
    expect(hero(mixed)).not.toContain("vp7-quote-who");
  });

  test("user-first quote keeps its attribution while Scout replies", () => {
    const ledger = play([
      speech("you", 0, 1200, "Check the fleet."),
      speech("live", 1500, 2500, "I will check."),
    ]);
    expect(hero(ledger)).toContain("— you");
    expect(hero(ledger)).toContain("Check the fleet.");
    expect(hero(ledger)).not.toContain("I will check.");
  });

  test("a quote without provenance has no default speaker", () => {
    const markup = renderToStaticMarkup(createElement(VoiceTurnHero, {
      who: "holding", quote: "Unknown speaker",
    }));
    expect(markup).not.toContain("vp7-quote-who");
  });
});
