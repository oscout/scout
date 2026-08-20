import { describe, expect, mock, test } from "bun:test";
import type { MissionLog } from "../client/screens/ops/mission-wall.ts";

// @ts-expect-error Bun tests load React's runtime entrypoint directly to avoid local TS path aliases.
const React = await import("../node_modules/react/index.js");
// @ts-expect-error Bun tests load React's JSX runtime directly to avoid local TS path aliases.
const ReactJsxRuntime = await import("../node_modules/react/jsx-runtime.js");
// @ts-expect-error Bun tests load React's JSX dev runtime directly to avoid local TS path aliases.
const ReactJsxDevRuntime = await import("../node_modules/react/jsx-dev-runtime.js");
// @ts-expect-error Bun tests load React DOM's server entrypoint directly to avoid local TS path aliases.
const ReactDomServer = await import("../node_modules/react-dom/server.node.js");
const { createElement } = React;
const { renderToStaticMarkup } = ReactDomServer;

mock.module("react", () => React);
mock.module("react/jsx-runtime", () => ReactJsxRuntime);
mock.module("react/jsx-dev-runtime", () => ReactJsxDevRuntime);

const { MissionLogPane } = await import(
  "../client/screens/ops/MissionLogPane.tsx"
);

const LOG: MissionLog = {
  id: "session-123",
  sessionId: "session-123",
  source: "codex",
  attribution: "scout-managed",
  project: "openscout",
  cwd: "/workspace/openscout",
  logPath: "/logs/session-123.jsonl",
  agent: {
    id: "agent-1",
    name: "Alpha",
    handle: "alpha",
    state: "working",
    project: "openscout",
    branch: "codex/review",
    harness: "codex",
    model: "gpt-5",
    sessionIds: ["session-123"],
  },
  lines: [],
  lastActiveAt: 1,
  live: true,
};

describe("MissionLogPane", () => {
  test("exposes separate keyboard controls for focusing and opening the log", () => {
    const html = renderToStaticMarkup(
      createElement(MissionLogPane, {
        log: LOG,
        selected: false,
        revealed: false,
        onOpen: () => {},
        onToggleSelected: () => {},
        onOpenLog: () => {},
      }),
    );

    expect(html).toContain('class="s-wall-pane-title"');
    expect(html).toContain('aria-label="Focus @alpha"');
    expect(html).toContain('class="s-wall-pane-file"');
    expect(html.match(/<button/g)?.length).toBe(2);
  });
});
