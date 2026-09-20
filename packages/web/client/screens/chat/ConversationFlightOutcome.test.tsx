import { describe, expect, mock, test } from "bun:test";
import type { Flight } from "../../lib/types.ts";

// @ts-expect-error Bun tests load React's runtime entrypoint directly to avoid local TS path aliases.
const React = await import("../../../node_modules/react/index.js");
// @ts-expect-error Bun tests load React's runtime entrypoint directly to avoid local TS path aliases.
const ReactJsxRuntime = await import("../../../node_modules/react/jsx-runtime.js");
// @ts-expect-error Bun tests load React's runtime entrypoint directly to avoid local TS path aliases.
const ReactJsxDevRuntime = await import("../../../node_modules/react/jsx-dev-runtime.js");
// @ts-expect-error Bun tests load React DOM's runtime entrypoint directly to avoid local TS path aliases.
const ReactDomServer = await import("../../../node_modules/react-dom/server.node.js");
// @ts-expect-error Load the runtime used by avatar portals, not the typecheck alias.
const ReactDom = await import("../../../node_modules/react-dom/index.js");
mock.module("react-dom", () => ReactDom);

mock.module("react", () => React);
mock.module("react/jsx-runtime", () => ReactJsxRuntime);
mock.module("react/jsx-dev-runtime", () => ReactJsxDevRuntime);

const { createElement } = React;
const { renderToStaticMarkup } = ReactDomServer;
const { ConversationFlightOutcome } = await import("./ConversationStatus.tsx");

function flight(overrides: Partial<Flight> = {}): Flight {
  return {
    id: "flt-1",
    invocationId: "inv-1",
    agentId: "agent-1",
    agentName: "Agent One",
    conversationId: "chn-1",
    collaborationRecordId: null,
    state: "failed",
    summary: null,
    startedAt: 1_700_000_000_000,
    completedAt: 1_700_000_010_000,
    sessions: [],
    ...overrides,
  };
}

describe("conversation flight outcome", () => {
  test("announces a failed broker outcome instead of live activity", () => {
    const html = renderToStaticMarkup(createElement(ConversationFlightOutcome, {
      flight: flight({
        state: "failed",
        summary: "Stale running flight reconciled without a live broker task",
      }),
      onOpenSession: () => undefined,
    }));

    expect(html).toContain('role="status"');
    expect(html).toContain("Invocation failed");
    expect(html).toContain("Stale running flight reconciled without a live broker task");
    expect(html).toContain("Broker outcome");
    expect(html).toContain("Open session");
    expect(html).not.toContain("Waiting for matching Tail events");
  });

  test("labels cancelled and completed flights as broker outcomes", () => {
    const cancelled = renderToStaticMarkup(createElement(ConversationFlightOutcome, {
      flight: flight({ state: "cancelled" }),
    }));
    expect(cancelled).toContain("Invocation cancelled");

    const completed = renderToStaticMarkup(createElement(ConversationFlightOutcome, {
      flight: flight({ state: "completed", summary: "Turn finished" }),
    }));
    expect(completed).toContain("Invocation completed");
    expect(completed).toContain("Turn finished");
    expect(completed).toContain("Broker outcome");
  });

  test("omits the session action when no session can be resolved", () => {
    const html = renderToStaticMarkup(createElement(ConversationFlightOutcome, {
      flight: flight({ state: "failed" }),
    }));

    expect(html).not.toContain("Open session");
  });
});
