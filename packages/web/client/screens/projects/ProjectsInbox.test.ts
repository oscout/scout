import { describe, expect, mock, test } from "bun:test";

import type { InboxProject, InboxSession } from "./projects-inbox-model.ts";
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
  agentCount: 1,
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
let mockProjectAliases: Record<string, string> = {};

mock.module("./useProjectsInbox.ts", () => ({
  refreshProjectsInbox: () => undefined,
  useProjectsInbox: () => ({
    model: {
      projects: mockProjects,
      threads: [],
      sessions: mockSessions,
      projectAliases: mockProjectAliases,
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
  filterAndSortProjects,
} = await import("./ProjectsRail.tsx");

describe("ProjectsInbox ThreadRow", () => {
  test("keeps the initial project rail project-only", () => {
    const html = renderToStaticMarkup(createElement(ProjectsRail, {
      route: { view: "agents-v2" },
      navigate: () => undefined,
    }));

    expect(html).toContain("/Pomo");
    expect(html).toContain("Find project");
    expect(html).not.toContain("Verify the sessions route");
    expect(html).not.toContain("Latest replies");
    expect(html).not.toContain("No sessions yet");
  });

  test("filters and sorts only canonical project fields", () => {
    const projects: InboxProject[] = [
      { ...defaultProject, slug: "talkie", title: "Talkie", root: "/workspace/talkie", lastActivityAt: 1 },
      { ...defaultProject, slug: "openscout", title: "OpenScout", root: "/workspace/openscout", lastActivityAt: 2 },
    ];

    expect(filterAndSortProjects(projects, "openscout", "recent").map((project) => project.slug))
      .toEqual(["openscout"]);
    expect(filterAndSortProjects(projects, "verify the sessions route", "recent"))
      .toHaveLength(0);
    expect(filterAndSortProjects(projects, "", "name").map((project) => project.slug))
      .toEqual(["openscout", "talkie"]);
  });

  test("shows quiet projects without a disclosure gate", () => {
    mockProjects = [
      defaultProject,
      {
        ...defaultProject,
        slug: "quiet",
        title: "Quiet",
        root: "/workspace/quiet",
        lastActivityAt: 0,
      },
    ];

    try {
      const html = renderToStaticMarkup(createElement(ProjectsRail, {
        route: { view: "agents-v2" },
        navigate: () => undefined,
      }));
      expect(html).toContain("/Pomo");
      expect(html).toContain("/Quiet");
      expect(html).not.toContain("All projects");
    } finally {
      mockProjects = [defaultProject];
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

  test("renders one synthetic project agent instead of endpoint rows", () => {
    const html = renderToStaticMarkup(createElement(ProjectsInbox, {
      route: {
        view: "agents-v2",
        projectSlug: "pomo",
        indexView: "agents",
      },
      navigate: () => undefined,
    }));

    expect(html).toContain("Project agent");
    expect(html).toContain("Open project");
    expect(html).not.toContain("Verify the sessions route");
    expect(html).not.toContain("No visible agents in this project");
  });

  test("keeps a folded worktree slug routed to its canonical project", () => {
    mockProjectAliases = { "pomo-worktree": "pomo" };
    try {
      const projectHtml = renderToStaticMarkup(createElement(ProjectsInbox, {
        route: {
          view: "agents-v2",
          projectSlug: "pomo-worktree",
          indexView: "agents",
        },
        navigate: () => undefined,
      }));
      const railHtml = renderToStaticMarkup(createElement(ProjectsRail, {
        route: { view: "agents-v2", projectSlug: "pomo-worktree" },
        navigate: () => undefined,
      }));

      expect(projectHtml).toContain("Project agent");
      expect(projectHtml).toContain("/workspace/pomo");
      expect(railHtml).toContain('aria-current="page"');
    } finally {
      mockProjectAliases = {};
    }
  });

  test("uses singular repository activity labels", () => {
    const html = renderToStaticMarkup(createElement(ProjectsInbox, {
      route: { view: "agents-v2", projectSlug: "pomo" },
      navigate: () => undefined,
    }));

    expect(html).toContain("</b> agent</span>");
    expect(html).not.toContain("</b> agents</span>");
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
