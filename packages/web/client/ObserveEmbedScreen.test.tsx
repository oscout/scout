import { describe, expect, mock, test } from "bun:test";

// @ts-expect-error Bun tests load React's runtime entrypoint directly to avoid local TS path aliases.
const React = await import("../node_modules/react/index.js");
// @ts-expect-error Bun tests load React's runtime entrypoint directly to avoid local TS path aliases.
const ReactJsxRuntime = await import("../node_modules/react/jsx-runtime.js");
// @ts-expect-error Bun tests load React's runtime entrypoint directly to avoid local TS path aliases.
const ReactJsxDevRuntime = await import("../node_modules/react/jsx-dev-runtime.js");
// @ts-expect-error Bun tests load React DOM's runtime entrypoint directly to avoid local TS path aliases.
const ReactDomServer = await import("../node_modules/react-dom/server.node.js");

mock.module("react", () => React);
mock.module("react/jsx-runtime", () => ReactJsxRuntime);
mock.module("react/jsx-dev-runtime", () => ReactJsxDevRuntime);
mock.module(new URL("./screens/sessions/SessionObserve.tsx", import.meta.url).pathname, () => ({
  SessionObserve: () => null,
}));

const { createElement } = React;
const { renderToStaticMarkup } = ReactDomServer;
const { InitiatingAsk } = await import("./screens/ObserveEmbedScreen.tsx");

describe("InitiatingAsk", () => {
  test("renders the originating ask and canonical conversation and flight links", () => {
    const html = renderToStaticMarkup(createElement(InitiatingAsk, {
      ask: {
        task: "Inspect the observe surface and make its provenance clear.",
        requesterId: "operator",
        requesterName: "Arach",
        requestedAt: Date.parse("2026-07-25T16:30:00.000Z"),
        invocationId: "inv-1",
        flightId: "flt-1",
        conversationId: "chn-design",
        messageId: "msg-ask",
      },
      sessionId: "session-1",
    }));

    expect(html).toContain("Inspect the observe surface and make its provenance clear.");
    expect(html).toContain(">Ask<");
    expect(html).not.toContain("Initiating ask");
    expect(html).toContain("Arach");
    expect(html).toContain('href="/messages/chn-design#msg-msg-ask"');
    expect(html).toContain('href="/flights/flt-1/observe?session=session-1"');
  });

  test("renders an honest unavailable state without fabricated links", () => {
    const html = renderToStaticMarkup(createElement(InitiatingAsk, {
      ask: null,
      sessionId: "session-1",
    }));

    expect(html).toContain("Not available for this observed session.");
    expect(html).not.toContain("href=");
  });

  test("offers expansion for long asks", () => {
    const html = renderToStaticMarkup(createElement(InitiatingAsk, {
      ask: {
        task: "x".repeat(241),
        requesterId: "operator",
        requesterName: "Arach",
        requestedAt: Date.parse("2026-07-25T16:30:00.000Z"),
        invocationId: "inv-1",
        flightId: "flt-1",
        conversationId: null,
        messageId: null,
      },
      sessionId: null,
    }));

    expect(html).toContain("Show full ask");
    expect(html).toContain('aria-expanded="false"');
  });
});
