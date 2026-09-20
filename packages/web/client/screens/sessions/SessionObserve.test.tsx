import { describe, expect, mock, test } from "bun:test";

import { describeObserveEvidence } from "../../lib/observe-fidelity.ts";

// @ts-expect-error Bun tests load React's runtime entrypoint directly to avoid local TS path aliases.
const React = await import("../../../node_modules/react/index.js");
// @ts-expect-error Bun tests load React's runtime entrypoint directly to avoid local TS path aliases.
const ReactJsxRuntime = await import("../../../node_modules/react/jsx-runtime.js");
// @ts-expect-error Bun tests load React's runtime entrypoint directly to avoid local TS path aliases.
const ReactJsxDevRuntime = await import("../../../node_modules/react/jsx-dev-runtime.js");
// @ts-expect-error Bun tests load React DOM's runtime entrypoint directly to avoid local TS path aliases.
const ReactDomServer = await import("../../../node_modules/react-dom/server.node.js");

mock.module("react", () => React);
mock.module("react/jsx-runtime", () => ReactJsxRuntime);
mock.module("react/jsx-dev-runtime", () => ReactJsxDevRuntime);
mock.module("react-dom", () => ({ createPortal: (children: unknown) => children }));
mock.module("../../lib/api.ts", () => ({
  api: async () => {
    throw new Error("Unexpected API call during static observe rendering.");
  },
  peekApiGet: () => null,
}));
mock.module("../../lib/sse.ts", () => ({ useBrokerEvents: () => undefined }));
mock.module("../../scout/Provider.tsx", () => ({
  useScout: () => ({ navigate: () => undefined }),
  useOptionalScout: () => ({ navigate: () => undefined }),
}));
const { createElement } = React;
const { renderToStaticMarkup } = ReactDomServer;
const {
  SessionObserveEmbedStatus,
  SessionObserveReceiptView,
} = await import("./SessionObserveEvidence.tsx");
const { SessionEmbedObserveContent } = await import("./SessionEmbedScreen.tsx");

const brokerReceipts = {
  events: [
    {
      id: "spinoza-2:registered",
      t: 0,
      kind: "boot" as const,
      text: "Session registered - Spinoza-2",
      detail: "codex - gpt-5.6-sol",
    },
    {
      id: "spinoza-2:handoff",
      t: 1,
      kind: "system" as const,
      text: "Harness session attached; waiting for trace events.",
      detail: "broker endpoint is live",
    },
  ],
  files: [],
  contextUsage: [],
  live: true,
};

describe("session observe evidence presentation", () => {
  test("does not count or mark synthetic broker receipts live in the embed header", () => {
    const evidence = describeObserveEvidence({
      source: "broker",
      fidelity: "synthetic",
      live: true,
      eventCount: brokerReceipts.events.length,
    });
    const html = renderToStaticMarkup(createElement(SessionObserveEmbedStatus, {
      source: "broker",
      fidelity: "synthetic",
      sessionId: "session-spinoza-2",
      evidence,
    }));

    expect(html).toContain("No trace events");
    expect(html).not.toContain("2 events");
    expect(html).not.toContain("s-observe-embed-status-live");
  });

  test("renders synthetic broker setup records as marker-less receipts", () => {
    const html = renderToStaticMarkup(createElement(SessionObserveReceiptView, {
      events: brokerReceipts.events,
    }));

    expect(html).toContain('aria-label="Session setup receipts"');
    expect(html).toContain("No observed trace activity");
    expect(html).toContain("Session registered - Spinoza-2");
    expect(html).toContain("Harness session attached; waiting for trace events.");
    expect(html).not.toContain("s-observe-row-bead");
    expect(html).not.toContain("s-observe-transport");
  });

  test("propagates broker synthetic fidelity through the resolved session embed", () => {
    const html = renderToStaticMarkup(createElement(SessionEmbedObserveContent, {
      lookup: {
        kind: "observe",
        refId: "session-spinoza-2",
        session: null,
        observe: {
          kind: "broker",
          refId: "session-spinoza-2",
          agentId: "session-spinoza-2",
          source: "broker",
          fidelity: "synthetic",
          historyPath: null,
          sessionId: "session-spinoza-2",
          updatedAt: Date.now(),
          data: brokerReceipts,
        },
      },
    }));

    expect(html).toContain("No trace events");
    expect(html).toContain('aria-label="Session setup receipts"');
    expect(html).not.toContain("2 events");
    expect(html).not.toContain("s-observe-embed-status-live");
    expect(html).not.toContain("s-observe-transport");
  });
});

const nativeCodexTurns = {
  events: [
    {
      id: "ask-1",
      t: 1,
      kind: "ask" as const,
      text: "Work on the native Mac app session presentation.",
    },
    {
      id: "read-1",
      t: 2,
      kind: "tool" as const,
      tool: "Read",
      arg: "ScoutObserveView.swift",
      text: "Read · ScoutObserveView.swift",
    },
    {
      id: "think-1",
      t: 3,
      kind: "think" as const,
      text: "This is an observed native session, not a Scout-managed chat.",
    },
    {
      id: "msg-1",
      t: 4,
      kind: "message" as const,
      text: "I'll present this as a conversation, with a way to inspect the trace.",
    },
  ],
  files: [],
  contextUsage: [],
  live: true,
  metadata: {
    session: {
      adapterType: "codex",
      model: "gpt-5.6-sol",
    },
  },
};

describe("observed native session conversation presentation", () => {
  test("labels the embed as a native session and defaults to conversation turns", () => {
    const html = renderToStaticMarkup(createElement(SessionEmbedObserveContent, {
      lookup: {
        kind: "observe",
        refId: "codex-native-1",
        session: null,
        observe: {
          kind: "history",
          refId: "codex-native-1",
          agentId: null,
          source: "history",
          fidelity: "timestamped",
          historyPath: "/tmp/codex.jsonl",
          sessionId: "codex-native-1",
          updatedAt: Date.now(),
          data: nativeCodexTurns,
        },
      },
    }));

    expect(html).toContain("Native session");
    expect(html).toContain("s-observe--conversation");
    expect(html).toContain("s-observe-ask--conversation");
    expect(html).toContain("s-observe-message--conversation");
    expect(html).toContain("Work on the native Mac app session presentation.");
    expect(html).toContain("present this as a conversation, with a way to inspect the trace.");
    expect(html).toContain("s-observe-ask-author");
    expect(html).toContain(">You<");
    expect(html).toContain("aria-label=\"Session presentation\"");
    expect(html).toContain("Conversation");
    expect(html).toContain("Trace");
    expect(html).toContain("1 tool · 1 reasoning update");
    expect(html).toContain("Expand 2 technical events");
    expect(html).not.toContain("s-observe-spine");
    expect(html).not.toContain("s-observe-transport");
  });
});
