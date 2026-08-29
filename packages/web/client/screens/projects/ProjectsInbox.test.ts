import { describe, expect, mock, test } from "bun:test";

import type { InboxSession } from "./projects-inbox-model.ts";
import { formatTerminalSurfaceId } from "@openscout/protocol";
import type { TerminalSessionRecord } from "@openscout/protocol";
import {
  nativeTerminalDeepLink,
  resolveProjectSessionTmuxTarget,
} from "./project-session-terminal.ts";

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
mock.module("react-dom", () => ({ createPortal: (children: unknown) => children }));

const session: InboxSession = {
  id: "pomo:session:test-session",
  kind: "session",
  projectSlug: "pomo",
  projectTitle: "Pomo",
  projectRoot: "/workspace/pomo",
  workspaceRoot: "/workspace/pomo",
  agentId: null,
  agentName: "Codex session",
  harness: "codex",
  branch: null,
  work: "Verify the sessions route",
  group: "recent",
  needs: false,
  working: false,
  lastActivityAt: 1_700_000_000_000,
  latestReplyAt: null,
  latestReplyPreview: null,
  sessionCount: 1,
  contextPct: null,
  conversationId: null,
  sessionId: "test-session",
  route: { view: "sessions", sessionId: "test-session" },
};

const defaultProject = {
  slug: "pomo",
  title: "Pomo",
  root: "/workspace/pomo",
  agentCount: 0,
  sessionCount: 1,
  liveSessionCount: 0,
  worktreeCount: 0,
  worktrees: [],
  needs: 0,
  working: 0,
  threadCount: 1,
  lastActivityAt: session.lastActivityAt,
  branches: [],
};
let mockProjects = [defaultProject];
let mockSessions = [session];

mock.module("./useProjectsInbox.ts", () => ({
  refreshProjectsInbox: () => undefined,
  useProjectsInbox: () => ({
    model: {
      projects: mockProjects,
      threads: [],
      sessions: mockSessions,
    },
    agents: [],
    nowMs: 1_700_000_060_000,
    loading: false,
    error: null,
  }),
}));
mock.module("../sessions/SessionRefScreen.tsx", () => ({
  SessionRefScreen: ({ sessionRef }: { sessionRef: string }) => createElement(
    "div",
    { "data-session-ref": sessionRef },
    `Resolved ${sessionRef}`,
  ),
}));

const { ProjectsInbox, ThreadRow } = await import("./ProjectsInbox.tsx");
const {
  ProjectsRail,
  filterAndSortProjectGroups,
  recentReplySessionsForRail,
} = await import("./ProjectsRail.tsx");

describe("ProjectsInbox ThreadRow", () => {
  test("surfaces an observed harness reply ahead of generic project sessions", () => {
    session.latestReplyAt = 1_700_000_050_000;
    session.latestReplyPreview = "The exact Codex task is ready for your steer.";
    const html = renderToStaticMarkup(createElement(ProjectsRail, {
      route: { view: "agents-v2" },
      navigate: () => undefined,
    }));
    session.latestReplyAt = null;
    session.latestReplyPreview = null;

    expect(html).toContain("Latest replies");
    expect(html).toContain("Codex replied · The exact Codex task is ready for your...");
    expect(html).toContain("Latest harness replies");
  });

  test("filters latest replies with the active rail query", () => {
    const openscoutReply: InboxSession = {
      ...session,
      id: "openscout-reply",
      projectSlug: "openscout",
      projectTitle: "Openscout",
      latestReplyAt: 1_700_000_050_000,
      latestReplyPreview: "The OpenScout response",
    };
    const blinkReply: InboxSession = {
      ...session,
      id: "blink-reply",
      projectSlug: "blink",
      projectTitle: "Blink",
      latestReplyAt: 1_700_000_060_000,
      latestReplyPreview: "The Blink response",
    };

    expect(recentReplySessionsForRail([blinkReply, openscoutReply], "openscout"))
      .toEqual([openscoutReply]);
    expect(recentReplySessionsForRail([openscoutReply], "verify the sessions route"))
      .toEqual([openscoutReply]);
    expect(recentReplySessionsForRail([openscoutReply], "test-session"))
      .toEqual([openscoutReply]);
  });

  test("keeps a fifth-ranked exact session match visible in the project preview", () => {
    const newerSessions = Array.from({ length: 4 }, (_, index): InboxSession => ({
      ...session,
      id: `pomo:session:newer-${index}`,
      sessionId: `newer-${index}`,
      work: `Unrelated newer session ${index}`,
      lastActivityAt: session.lastActivityAt + 10_000 - index,
    }));
    const exactMatch: InboxSession = {
      ...session,
      id: "pomo:session:find-this-exact-response",
      sessionId: "find-this-exact-response",
      work: "The response I need to steer",
      lastActivityAt: session.lastActivityAt - 10_000,
    };

    const groups = filterAndSortProjectGroups([{
      project: { ...defaultProject, sessionCount: 5 },
      sessions: [...newerSessions, exactMatch],
      lastActivityAt: newerSessions[0]!.lastActivityAt,
    }], "find-this-exact-response", "recent");

    expect(groups).toHaveLength(1);
    expect(groups[0]?.sessions).toEqual([exactMatch]);
  });

  test("fails closed for legacy session ids that collide across project groups", () => {
    const codexSession: InboxSession = { ...session, source: "codex" };
    const claudeSession: InboxSession = {
      ...session,
      id: "blink:session:test-session",
      projectSlug: "blink",
      projectTitle: "Blink",
      projectRoot: "/workspace/blink",
      workspaceRoot: "/workspace/blink",
      harness: "claude",
      source: "claude",
      agentName: "Claude session",
    };
    mockProjects = [
      defaultProject,
      {
        ...defaultProject,
        slug: "blink",
        title: "Blink",
        root: "/workspace/blink",
      },
    ];
    mockSessions = [codexSession, claudeSession];

    try {
      const html = renderToStaticMarkup(createElement(ProjectsRail, {
        route: { view: "agents-v2", sessionId: "session:test-session" },
        navigate: () => undefined,
      }));
      expect(html.match(/data-selected="true"/gu) ?? []).toHaveLength(0);
    } finally {
      mockProjects = [defaultProject];
      mockSessions = [session];
    }
  });

  test("renders a project session row with its open affordance", () => {
    const html = renderToStaticMarkup(createElement(ThreadRow, {
      thread: session,
      crossProject: false,
      selected: false,
      cursor: false,
      nowMs: 1_700_000_060_000,
      onSelect: () => undefined,
      onOpen: () => undefined,
      rowRef: () => undefined,
    }));

    expect(html).toContain("Verify the sessions route");
    expect(html).toContain("Open");
    expect(html).toContain("lucide-chevron-right");
  });

  test("opens a scoped session deep link instead of leaving the index visible", () => {
    const html = renderToStaticMarkup(createElement(ProjectsInbox, {
      route: {
        view: "agents-v2",
        projectSlug: "pomo",
        indexView: "sessions",
        sessionId: "test-session",
      },
      navigate: () => undefined,
    }));

    expect(html).toContain('aria-label="Selected session"');
    expect(html).toContain('data-session-ref="test-session"');
    expect(html).toContain("Resolved test-session");
  });

  test("resolves a historical session agent to its discovered tmux surface", () => {
    const terminalSessions = [{
      id: "discovered.tmux.pomo",
      agentId: null,
      harness: "tmux",
      cwd: "/workspace/pomo",
      sourceSessionId: null,
      surfaces: [{
        backend: "tmux",
        sessionName: "session-ms0hf3f7-3ngln1",
        paneId: null,
        socketDir: null,
        attachCommand: ["tmux", "attach", "-t", "session-ms0hf3f7-3ngln1"],
        observeCommand: null,
        relay: null,
        state: "live",
      }],
      metadata: { registryState: "discovered" },
    }] as TerminalSessionRecord[];

    const target = resolveProjectSessionTmuxTarget(terminalSessions, {
      agentId: "session-ms0hf3f7-3ngln1.main.arts-mac-mini-local",
      sessionRefs: ["chn-0050e6389d0d48bab991d5cb9a3c4ecd"],
    });

    expect(target).toEqual({
      terminalSessionId: "discovered.tmux.pomo",
      terminalSurfaceKey: formatTerminalSurfaceId({ backend: "tmux", hostSession: "session-ms0hf3f7-3ngln1" }),
      sessionName: "session-ms0hf3f7-3ngln1",
    });
    // The deep link carries the LEGACY key, not the opaque handle. macOS's
    // handler accepts only `tmux:`/`zellij:` prefixes and returns nil for
    // anything else, so an opaque handle here is a link that silently does
    // nothing — and macOS cannot be updated in step with a web release.
    expect(nativeTerminalDeepLink(target!, "takeover")).toBe(
      "scout://terminal?session=discovered.tmux.pomo&surface=tmux%3Asession-ms0hf3f7-3ngln1&mode=takeover",
    );
    expect(decodeURIComponent(nativeTerminalDeepLink(target!, "takeover")!))
      .toContain("surface=tmux:session-ms0hf3f7-3ngln1");
  });

  test("no native link at all when the surface handle will not parse", () => {
    expect(nativeTerminalDeepLink({
      terminalSessionId: "ts.1",
      terminalSurfaceKey: "not-a-handle",
      sessionName: "whatever",
    }, "takeover")).toBeNull();
  });
});
