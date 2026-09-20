import { describe, expect, mock, test } from "bun:test";

import type { ScoutbotAssistantSessionState } from "./scoutbot-model.ts";

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

type VoiceContext = {
  enabled: boolean;
  state: string;
  error: string | null;
  trace: never[];
  chatState: ScoutbotAssistantSessionState | null;
  chatStatus: "idle" | "loading" | "ready" | "failed";
  chatError: string | null;
  sessionAction: null;
  startCall: () => Promise<void>;
  endCall: () => Promise<boolean>;
  startNewChat: () => Promise<void>;
  switchChat: (id: string) => Promise<void>;
  updatePreferredModel: (model: string) => Promise<string>;
  clearTrace: () => void;
  openVoiceSettings: () => void;
};

let contextValue: VoiceContext;

mock.module("./ScoutbotRealtimeVoiceContext.tsx", () => ({
  useScoutbotRealtimeVoice: () => contextValue,
}));

const { ScoutbotRealtimeVoiceCall } = await import("./ScoutbotRealtimeVoiceCall.tsx");

function baseContext(overrides: Partial<VoiceContext> = {}): VoiceContext {
  return {
    enabled: false,
    state: "idle",
    error: null,
    trace: [],
    chatState: null,
    chatStatus: "loading",
    chatError: null,
    sessionAction: null,
    startCall: async () => {},
    endCall: async () => true,
    startNewChat: async () => {},
    switchChat: async () => {},
    updatePreferredModel: async (model: string) => model,
    clearTrace: () => {},
    openVoiceSettings: () => {},
    ...overrides,
  };
}

function readyChat(title: string, model: string): ScoutbotAssistantSessionState {
  return {
    session: {
      id: "session-live",
      title,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_001_000,
      model,
      messageCount: 0,
      messages: [],
    },
    sessions: [{
      id: "session-live",
      title,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_001_000,
      model,
      messageCount: 0,
    }],
    config: { model, provider: "openai" },
  } as unknown as ScoutbotAssistantSessionState;
}

function render(
  overrides: Partial<VoiceContext> = {},
  props: { instrument?: boolean; meterLine?: string; clock?: string; layout?: "compact" | "page" } = {},
): string {
  contextValue = baseContext(overrides);
  return renderToStaticMarkup(
    createElement(ScoutbotRealtimeVoiceCall, { dictationActive: false, ...props }),
  );
}

describe("ScoutbotRealtimeVoiceCall live chat states", () => {
  test("says loading only while the session request is in flight", () => {
    const markup = render({ chatStatus: "loading" });
    expect(markup).toContain("Loading chat…");
    expect(markup).not.toContain("Chat unavailable");
  });

  test("names the failure instead of loading forever", () => {
    const markup = render({
      chatStatus: "failed",
      chatError: "unknown api route: /api/scoutbot/session",
    });
    expect(markup).toContain("Chat unavailable");
    expect(markup).toContain("unknown api route: /api/scoutbot/session");
    expect(markup).not.toContain("Loading chat…");
  });

  test("renders the chat and its reply model while live voice is still off", () => {
    const markup = render({
      enabled: false,
      chatStatus: "ready",
      chatState: readyChat("Dispatch failures", "gpt-5.6-luna"),
    });
    expect(markup).toContain("Dispatch failures");
    expect(markup).toContain("gpt-5.6-luna");
    expect(markup).not.toContain("Loading chat…");
  });

  test("falls back to an honest label for a resolved but untitled chat", () => {
    const markup = render({
      chatStatus: "ready",
      chatState: readyChat("", "gpt-5.6-luna"),
    });
    expect(markup).toContain("Untitled chat");
    expect(markup).not.toContain("Loading chat…");
  });
});

describe("ScoutbotRealtimeVoiceCall instrument layout", () => {
  test("shows the plate and activity together without a tab bar", () => {
    const markup = render({
      enabled: true,
      state: "idle",
      chatStatus: "ready",
      chatState: readyChat("Dispatch failures", "gpt-5.6-luna"),
    }, {
      instrument: true,
      layout: "page",
      meterLine: "OpenAI gpt-realtime · marin · metered",
    });
    expect(markup).toContain("Start live voice");
    expect(markup).toContain("OpenAI gpt-realtime · marin · metered");
    expect(markup).toContain("the meter starts on connect");
    expect(markup).toContain("Session activity");
    expect(markup).not.toContain("Live conversation");
    expect(markup).not.toContain("Live voice views");
    expect(markup).not.toContain("Microphone and spoken replies are active.");
  });

  test("puts the elapsed clock on End live voice", () => {
    const markup = render({
      enabled: true,
      state: "live",
      chatStatus: "ready",
      chatState: readyChat("Dispatch failures", "gpt-5.6-luna"),
    }, {
      instrument: true,
      layout: "page",
      meterLine: "OpenAI gpt-realtime · marin · metered",
      clock: "00:12",
    });
    expect(markup).toContain("End live voice");
    expect(markup).toContain("00:12");
    expect(markup).toContain("voice-cta-clock");
    expect(markup).not.toContain("the meter starts on connect");
  });

  test("writes a receipt row when the call has ended", () => {
    const markup = render({
      enabled: true,
      state: "ended",
      chatStatus: "ready",
      chatState: readyChat("Dispatch failures", "gpt-5.6-luna"),
    }, {
      instrument: true,
      layout: "page",
      clock: "01:04",
    });
    expect(markup).toContain("call · 01:04 · metered · ended");
  });
});
