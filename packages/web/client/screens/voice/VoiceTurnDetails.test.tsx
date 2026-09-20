import { describe, expect, mock, test } from "bun:test";

import type { VoiceTurn } from "../../lib/voice-turn-ledger.ts";

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

const { VoiceTurnDetails } = await import("./VoiceTurnDetails.tsx");

const ORIGIN = 1_789_793_202_223;

function makeTurn(overrides: Partial<VoiceTurn> = {}): VoiceTurn {
  return {
    id: "turn-1789793202223",
    origin: ORIGIN,
    quote: "Um, the live voice.",
    spans: [
      { id: "you-1", lane: "you", tone: "you", start: 0, end: 4.1 },
      { id: "host-1", lane: "host", tone: "host", start: 4.1, end: 4.2, label: "on-device stt" },
      { id: "bot-1", lane: "scoutbot", tone: "model", start: 4.2, end: 42.921, label: "gpt-5.6-luna" },
      { id: "speak-1", lane: "voice", tone: "speak", start: 42.95, end: null, label: "marin" },
    ],
    ticks: [{ id: "tick-1", lane: "scout", at: 5, label: "fleet state lookup" }],
    ...overrides,
  };
}

describe("voice turn details", () => {
  test("collapsed disclosure shows the span ledger at ms precision", () => {
    const html = renderToStaticMarkup(createElement(VoiceTurnDetails, { turn: makeTurn() }));
    expect(html).toContain("technical details");
    expect(html).toContain("turn-1789793202223");
    expect(html).toContain("38,721 ms");
    expect(html).toContain("gpt-5.6-luna");
    expect(html).toContain("fleet state lookup");
    expect(html).toContain("Um, the live voice.");
  });

  test("an open span reports open and a running duration against now", () => {
    const html = renderToStaticMarkup(
      createElement(VoiceTurnDetails, { turn: makeTurn(), now: 111.691 }),
    );
    expect(html).toContain('class="is-open"');
    expect(html).toContain("<td>open</td>");
    expect(html).toContain("68,741 ms (running)");
  });

  test("a fully closed turn never claims an open end", () => {
    const turn = makeTurn({
      spans: makeTurn().spans.map((s) => ({ ...s, end: s.end ?? 111.691 })),
    });
    const html = renderToStaticMarkup(createElement(VoiceTurnDetails, { turn, now: 200 }));
    expect(html).toContain("68,741 ms");
    expect(html).not.toContain("(running)");
  });

  test("key moments are lapped from the ledger before any fetch", () => {
    const html = renderToStaticMarkup(createElement(VoiceTurnDetails, { turn: makeTurn() }));
    expect(html).toContain("key moments");
    expect(html).toContain("transcript");
    expect(html).toContain("llm call");
    expect(html).toContain("reply");
    expect(html).toContain("tts call");
    // The reply lap delta is the model leg, and the open speak span never
    // produces a tts-done row.
    expect(html).toContain("+38,721 ms");
    expect(html).not.toContain("tts done");
  });

  test("opened disclosure mounts the fetched blocks in loading state", () => {
    const html = renderToStaticMarkup(
      createElement(VoiceTurnDetails, { turn: makeTurn(), startOpen: true }),
    );
    expect(html).toContain("scoutbot session");
    expect(html).toContain("host voice sessions");
    expect(html).toContain("loading…");
  });
});
