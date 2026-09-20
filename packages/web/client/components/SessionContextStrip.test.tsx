import { describe, expect, mock, test } from "bun:test";

// @ts-expect-error Bun tests load React's runtime entrypoint directly to avoid local TS path aliases.
const React = await import("../../node_modules/react/index.js");
// @ts-expect-error Bun tests load React's runtime entrypoint directly to avoid local TS path aliases.
const ReactJsxRuntime = await import("../../node_modules/react/jsx-runtime.js");
// @ts-expect-error Bun tests load React's runtime entrypoint directly to avoid local TS path aliases.
const ReactJsxDevRuntime = await import("../../node_modules/react/jsx-dev-runtime.js");
// @ts-expect-error Bun tests load React DOM's runtime entrypoint directly to avoid local TS path aliases.
const ReactDomServer = await import("../../node_modules/react-dom/server.node.js");

mock.module("react", () => React);
mock.module("react/jsx-runtime", () => ReactJsxRuntime);
mock.module("react/jsx-dev-runtime", () => ReactJsxDevRuntime);

const { createElement } = React;
const { renderToStaticMarkup } = ReactDomServer;
const { SessionContextStrip, sessionContextStripActions } = await import("./SessionContextStrip.tsx");

describe("SessionContextStrip", () => {
  test("shows harness and model as separate facts", () => {
    const html = renderToStaticMarkup(createElement(SessionContextStrip, {
      harness: "claude",
      model: "claude-sonnet-test",
      hostName: "devon-mini",
      workspaceRoot: "/work/openscout",
      navigate: () => undefined,
    }));

    expect(html).toContain("Claude");
    expect(html).toContain("claude-sonnet-test");
    expect(html).toContain("devon-mini");
  });

  test("falls back to Host not reported and Workspace not reported", () => {
    const html = renderToStaticMarkup(createElement(SessionContextStrip, {
      harness: "codex",
      navigate: () => undefined,
    }));

    expect(html).toContain("Host not reported");
    expect(html).toContain("Workspace not reported");
  });

  test("renders the full long workspace path with a copy action", () => {
    const workspace = "/Users/art/dev/openscout-worktrees/herdr-scout-agent-profile/packages/web";
    const html = renderToStaticMarkup(createElement(SessionContextStrip, {
      harness: "kimi",
      hostName: "devon-mini",
      workspaceRoot: workspace,
      navigate: () => undefined,
    }));

    expect(html).toContain(workspace);
    expect(html).toContain("Copy path");
  });

  test("links the exact session identity", () => {
    const html = renderToStaticMarkup(createElement(SessionContextStrip, {
      harness: "pi",
      hostName: "devon-mini",
      workspaceRoot: "/work/project",
      sessionId: "session-mu79evpc-kxbokv",
      machineId: "node-2",
      navigate: () => undefined,
    }));

    expect(html).toContain('aria-label="Open session session-mu79evpc-kxbokv"');
    expect(html).toContain('title="session-mu79evpc-kxbokv"');
  });

  test("omits the session action when no session is resolved", () => {
    const html = renderToStaticMarkup(createElement(SessionContextStrip, {
      harness: "pi",
      hostName: "devon-mini",
      workspaceRoot: "/work/project",
      navigate: () => undefined,
    }));

    expect(html).not.toContain("Open session");
  });

  test("resolves exact session and conversation routes for the click handlers", () => {
    const { sessionRoute, conversationRoute } = sessionContextStripActions({
      sessionId: "session-mu79evpc-kxbokv",
      conversationId: "chn-b82c0195fd2f40459dbaf3fee4d29c4f",
      machineId: "node-2",
    });

    expect(sessionRoute).toEqual({
      view: "sessions",
      sessionId: "session-mu79evpc-kxbokv",
      machineId: "node-2",
    });
    expect(conversationRoute).toEqual({
      view: "conversation",
      conversationId: "chn-b82c0195fd2f40459dbaf3fee4d29c4f",
      machineId: "node-2",
    });
  });

  test("shows the requested ref as selectable text instead of a self-link", () => {
    const html = renderToStaticMarkup(createElement(SessionContextStrip, {
      harness: "claude",
      hostName: "devon-mini",
      workspaceRoot: "/work/project",
      sessionId: "session-mu79evpc-kxbokv",
      showSessionAction: false,
      navigate: () => undefined,
    }));

    expect(html).not.toContain("Open session");
    expect(html).toContain("s-session-context-strip-identity");
    expect(html).toContain("session-mu79evpc-kxbokv");
  });

  test("marks the copy status region as a polite live region", () => {
    const html = renderToStaticMarkup(createElement(SessionContextStrip, {
      workspaceRoot: "/work/project",
      navigate: () => undefined,
    }));

    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Copy path");
  });
});
