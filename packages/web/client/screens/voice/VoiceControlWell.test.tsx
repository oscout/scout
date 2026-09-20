import { describe, expect, mock, test } from "bun:test";

import type { ScoutbotSpeechIdentity } from "../../scout/scoutbot/scoutbot-voice-profiles.ts";

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
  VoiceControlWell,
  gptLiveWellSpec,
  localLiveWellSpec,
} = await import("./VoiceControlWell.tsx");

const GPT_SPEC_INPUT = {
  enabled: true,
  state: "idle" as const,
  error: null,
  meterLine: "OpenAI gpt-live-1 · marin · metered",
  inputLabel: "ATR2500x-USB Microphone",
  micMuted: false,
  playbackMuted: false,
};

const TTS_IDENTITY: ScoutbotSpeechIdentity = {
  selectionId: "us-woman",
  voiceLabel: "Marin",
  provider: "openai",
  providerLabel: "OpenAI",
  modelId: "gpt-4o-mini-tts",
  voiceId: "marin",
  metered: true,
};

const LOCAL_SPEC_INPUT = {
  phase: "ready" as const,
  voiceReplies: true,
  inputLabel: "ATR2500x-USB Microphone",
  inputWarn: false,
  speechIdentity: TTS_IDENTITY,
  assistantModel: "gpt-5.6-luna",
};

function renderWell(
  spec: ReturnType<typeof gptLiveWellSpec> | ReturnType<typeof localLiveWellSpec>,
  layout?: "card" | "row",
) {
  return renderToStaticMarkup(
    createElement(VoiceControlWell, {
      spec,
      layout,
      onCta: () => {},
      onFlag: () => {},
      onTail: () => {},
    }),
  );
}

describe("shared control well skeleton", () => {
  test("both modes render the same six slots", () => {
    for (const markup of [
      renderWell(gptLiveWellSpec(GPT_SPEC_INPUT)),
      renderWell(localLiveWellSpec(LOCAL_SPEC_INPUT)),
    ]) {
      for (const slot of [
        "voice-well-title",
        "voice-well-sub",
        "voice-well-cta",
        "voice-well-note",
        "voice-well-flags",
        "voice-well-tail",
      ]) {
        expect(markup).toContain(slot);
      }
      expect(markup).toContain("input · ATR2500x-USB Microphone");
      expect(markup).toContain("New chat");
      expect(markup).toContain("Voice settings");
    }
  });
});

describe("control row layout (performing)", () => {
  test("row drops the title/sub but keeps every working slot", () => {
    const markup = renderWell(localLiveWellSpec({ ...LOCAL_SPEC_INPUT, phase: "thinking" }), "row");
    expect(markup).toContain("voice-well--row");
    expect(markup).not.toContain("voice-well-title");
    expect(markup).not.toContain("voice-well-sub");
    expect(markup).toContain("input · ATR2500x-USB Microphone");
    expect(markup).toContain("Spoken replies");
    expect(markup).toContain("the reply is paid, not the take");
    expect(markup).toContain("gpt-5.6-luna is replying");
    expect(markup).toContain("New chat");
    expect(markup).toContain("Voice settings");
    expect(markup).toContain("Cancel turn");
  });

  test("egress goes quiet in the row: Cancel/Stop render ghost, commitments stay solid", () => {
    const cancel = renderWell(localLiveWellSpec({ ...LOCAL_SPEC_INPUT, phase: "thinking" }), "row");
    expect(cancel).toContain("voice-well-cta--ghost");
    const stop = renderWell(localLiveWellSpec({ ...LOCAL_SPEC_INPUT, phase: "speaking" }), "row");
    expect(stop).toContain("voice-well-cta--ghost");
    const send = renderWell(localLiveWellSpec({
      ...LOCAL_SPEC_INPUT,
      phase: "listening",
      recordingClock: "3.4s",
    }), "row");
    expect(send).toContain("voice-well-cta--start");
    expect(send).toContain("3.4s");
    const end = renderWell(gptLiveWellSpec({ ...GPT_SPEC_INPUT, state: "live", clock: "01:04" }), "row");
    expect(end).toContain("voice-well-cta--end");
    expect(end).toContain("01:04");
  });

  test("connecting is a busy ghost, not a solid action", () => {
    const markup = renderWell(gptLiveWellSpec({ ...GPT_SPEC_INPUT, state: "connecting" }), "row");
    expect(markup).toContain("voice-well-cta--ghost");
    expect(markup).toContain("aria-busy=\"true\"");
    expect(markup).toContain("mic consent → SDP answer → Live readiness");
  });

  test("the error note keeps its alert role in the row", () => {
    const markup = renderWell(gptLiveWellSpec({
      ...GPT_SPEC_INPUT,
      state: "error",
      error: "Live session did not become ready in time.",
    }), "row");
    expect(markup).toContain("role=\"alert\"");
    expect(markup).toContain("voice-well-note--error");
  });

  test("card stays the default layout", () => {
    const markup = renderWell(localLiveWellSpec({ ...LOCAL_SPEC_INPUT, phase: "thinking" }));
    expect(markup).not.toContain("voice-well--row");
    expect(markup).toContain("voice-well-title");
    expect(markup).toContain("voice-well-cta--end");
    expect(markup).not.toContain("voice-well-cta--ghost");
  });
});

describe("GPT Live well", () => {
  test("rest face: start CTA, consent line, armable gates", () => {
    const markup = renderWell(gptLiveWellSpec(GPT_SPEC_INPUT));
    expect(markup).toContain("Live conversation");
    expect(markup).toContain("OpenAI gpt-live-1 · marin · metered");
    expect(markup).toContain("Start live voice");
    expect(markup).toContain("the meter starts on connect");
    expect(markup).toContain("Mute mic");
    expect(markup).toContain("Quiet");
    expect(markup).not.toContain("armed now");
  });

  test("connecting face: Cancel connection with staged note", () => {
    const markup = renderWell(gptLiveWellSpec({ ...GPT_SPEC_INPUT, state: "connecting" }));
    expect(markup).toContain("Cancel connection");
    expect(markup).toContain("mic consent → SDP answer → Live readiness");
    expect(markup).not.toContain("Start live voice");
  });

  test("live face: End live voice carries the session clock", () => {
    const markup = renderWell(gptLiveWellSpec({
      ...GPT_SPEC_INPUT,
      state: "live",
      clock: "01:04",
    }));
    expect(markup).toContain("End live voice");
    expect(markup).toContain("01:04");
    expect(markup).toContain("voice-well-cta-clock");
    expect(markup).toContain("the meter is running");
  });

  test("error face returns to Start with the error on the note line", () => {
    const markup = renderWell(gptLiveWellSpec({
      ...GPT_SPEC_INPUT,
      state: "error",
      error: "Live session did not become ready in time.",
    }));
    expect(markup).toContain("Start live voice");
    expect(markup).toContain("Live session did not become ready in time.");
    expect(markup).toContain("voice-well-note--error");
  });

  test("armed flags announce they apply on connect", () => {
    const markup = renderWell(gptLiveWellSpec({ ...GPT_SPEC_INPUT, micMuted: true }));
    expect(markup).toContain("armed now · applies on connect");
  });

  test("disabled live voice offers Open voice settings", () => {
    const markup = renderWell(gptLiveWellSpec({ ...GPT_SPEC_INPUT, enabled: false }));
    expect(markup).toContain("Open voice settings");
    expect(markup).not.toContain("Start live voice");
  });

  test("dictation gate disables the CTA and explains", () => {
    const markup = renderWell(gptLiveWellSpec({ ...GPT_SPEC_INPUT, dictationActive: true }));
    expect(markup).toContain("Dictation owns the microphone");
  });
});

describe("Local Live well", () => {
  test("rest face: start turn CTA, local consent, spoken-replies flag", () => {
    const markup = renderWell(localLiveWellSpec(LOCAL_SPEC_INPUT));
    expect(markup).toContain("Turn-based conversation");
    expect(markup).toContain("OpenAI gpt-4o-mini-tts · voice Marin · metered per reply");
    expect(markup).toContain("Start voice turn");
    expect(markup).toContain("audio stays on this Mac · reply text still hits gpt-5.6-luna");
    expect(markup).toContain("Spoken replies");
    expect(markup).not.toContain("Discard");
  });

  test("recording face: Send turn carries the elapsed take clock", () => {
    const markup = renderWell(localLiveWellSpec({
      ...LOCAL_SPEC_INPUT,
      phase: "listening",
      recordingClock: "3.4s",
    }));
    expect(markup).toContain("Send turn");
    expect(markup).toContain("3.4s");
    expect(markup).toContain("voice-well-cta-clock");
    expect(markup).toContain("Discard");
    expect(markup).toContain("nothing is sent until Send");
  });

  test("transcribing face: enabled Cancel turn, phase stays on the note line", () => {
    const markup = renderWell(localLiveWellSpec({ ...LOCAL_SPEC_INPUT, phase: "processing" }));
    expect(markup).toContain("Cancel turn");
    expect(markup).toContain("turning speech into text");
    expect(markup).not.toContain("Send turn");
    expect(markup).not.toContain("aria-busy");
  });

  test("thinking face: enabled Cancel turn, note names the reply model", () => {
    const markup = renderWell(localLiveWellSpec({ ...LOCAL_SPEC_INPUT, phase: "thinking" }));
    expect(markup).toContain("Cancel turn");
    expect(markup).toContain("gpt-5.6-luna is replying");
    expect(markup).not.toContain("Send turn");
  });

  test("speaking face: Stop spoken reply", () => {
    const markup = renderWell(localLiveWellSpec({ ...LOCAL_SPEC_INPUT, phase: "speaking" }));
    expect(markup).toContain("Stop spoken reply");
    expect(markup).toContain("spoken reply · metered");
  });

  test("checking face: disabled CTA names the check", () => {
    const markup = renderWell(localLiveWellSpec({ ...LOCAL_SPEC_INPUT, phase: "checking" }));
    expect(markup).toContain("Checking voice…");
  });

  test("unavailable face: retry CTA and warned input", () => {
    const markup = renderWell(localLiveWellSpec({
      ...LOCAL_SPEC_INPUT,
      phase: "unavailable",
      inputLabel: "none — voice unavailable",
      inputWarn: true,
    }));
    expect(markup).toContain("Retry voice connection");
    expect(markup).toContain("input · none — voice unavailable");
    expect(markup).toContain("voice-well-input--warn");
    expect(markup).toContain("voice is offline · nothing can record");
  });

  test("spoken-replies off tells the text-only truth", () => {
    const markup = renderWell(localLiveWellSpec({ ...LOCAL_SPEC_INPUT, voiceReplies: false }));
    expect(markup).toContain("reply lands as text · nothing metered");
  });

  test("no standalone phase label duplicates the floor vocabulary", () => {
    for (const phase of ["ready", "listening", "processing", "thinking", "speaking"] as const) {
      const markup = renderWell(localLiveWellSpec({ ...LOCAL_SPEC_INPUT, phase }));
      for (const word of ["Ready to listen", "Listening", "Scout is speaking"]) {
        if (markup.includes("Scout is thinking…") && word === "Scout is speaking") continue;
        expect(markup).not.toContain(`dvp-phase`);
        expect(markup).not.toContain(`>${word}<`);
      }
    }
  });
});
