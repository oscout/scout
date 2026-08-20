import { describe, expect, mock, test } from "bun:test";
import type { FleetActivity } from "../../lib/types.ts";

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
mock.module("motion/react", () => ({
  LazyMotion: ({ children }: { children: unknown }) => children,
  m: {},
  useReducedMotion: () => true,
}));
mock.module(new URL("../../scout/Provider.tsx", import.meta.url).pathname, () => ({
  useScout: () => ({ route: { view: "inbox" }, navigate: () => undefined }),
}));

const { createElement } = React;
const { renderToStaticMarkup } = ReactDomServer;
const {
  WorkingTurnActions,
  WorkingTurnActivityPreview,
} = await import("./ConversationPanels.tsx");

const activity = (id: string, summary: string, ts: number): FleetActivity => ({
  id,
  kind: "tool",
  ts,
  actorName: "Zeno",
  title: null,
  summary,
  conversationId: "conversation-1",
  workspaceRoot: "/workspace/openscout",
  agentId: "agent-1",
  agentName: "Zeno",
  flightId: "flight-1",
  invocationId: "invocation-1",
  sessionId: "session-1",
  messageId: null,
  recordId: null,
  actorId: "agent-1",
});

describe("working turn preview", () => {
  test("keeps live trace, terminal, and steer within reach", () => {
    const html = renderToStaticMarkup(createElement(WorkingTurnActions, {
      onOpenTrace: () => undefined,
      onOpenTerminal: () => undefined,
      onSteer: () => undefined,
      compact: true,
    }));

    expect(html).toContain('aria-label="Working turn actions"');
    expect(html).toContain("Live trace");
    expect(html).toContain("Terminal");
    expect(html).toContain("Steer…");
    expect(html).toContain("s-thread-working-actions--compact");
  });

  test("shows only the latest bounded trace preview", () => {
    const html = renderToStaticMarkup(createElement(WorkingTurnActivityPreview, {
      events: [
        activity("event-1", "Reading the conversation surface", 1_700_000_003_000),
        activity("event-2", "Inspecting terminal routes", 1_700_000_002_000),
        activity("event-3", "Older event", 1_700_000_001_000),
      ],
      limit: 2,
      compact: true,
    }));

    expect(html).toContain('aria-label="Latest run activity"');
    expect(html).toContain("Reading the conversation surface");
    expect(html).toContain("Inspecting terminal routes");
    expect(html).not.toContain("Older event");
  });
});
