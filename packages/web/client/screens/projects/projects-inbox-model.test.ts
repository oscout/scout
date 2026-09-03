import { describe, expect, test } from "bun:test";
import type {
  Agent,
  FleetAsk,
  FleetAttentionItem,
  FleetState,
  SessionEntry,
  TailDiscoverySnapshot,
  TailEvent,
} from "../../lib/types.ts";
import {
  buildProjectsInboxModel,
  groupThreads,
  isDormantProject,
  isSessionSelected,
  isThreadSelected,
  sessionOpenRoute,
  sessionRouteRef,
  sessionSelectRoute,
  resolveProjectSlug,
  threadOpenRoute,
  threadObserveRoute,
  threadRouteRef,
  threadSelectRoute,
  threadsForProject,
  type BuildInboxInput,
} from "./projects-inbox-model.ts";

const NOW = 1_700_000_000_000;
const RECENT = NOW - 60_000; // 1m ago — live
const STALE = NOW - 3 * 24 * 60 * 60_000; // 3d ago — dormant

function mkAgent(partial: Partial<Agent> & { id: string; name: string }): Agent {
  return {
    definitionId: `${partial.id}-def`,
    handle: null,
    agentClass: "agent",
    harness: "claude",
    state: "callable",
    projectRoot: "/Users/test/dev/openscout",
    cwd: "/Users/test/dev/openscout",
    updatedAt: RECENT,
    createdAt: RECENT,
    transport: "local",
    selector: null,
    defaultSelector: null,
    nodeQualifier: null,
    workspaceQualifier: null,
    wakePolicy: null,
    capabilities: [],
    project: "openscout",
    branch: "main",
    role: null,
    model: "opus",
    harnessSessionId: null,
    terminalSurface: null,
    harnessLogPath: null,
    conversationId: null,
    homeNodeId: "local",
    homeNodeName: "local",
    ownerId: null,
    ownerName: null,
    ownerHandle: null,
    staleLocalRegistration: false,
    retiredFromFleet: false,
    replacedByAgentId: null,
    ...partial,
  };
}

function mkAsk(agentId: string): FleetAsk {
  return {
    invocationId: `inv-${agentId}`,
    flightId: null,
    agentId,
    agentName: agentId,
    conversationId: null,
    collaborationRecordId: null,
    task: "Review the migration diff",
    status: "needs_attention",
    statusLabel: "needs attention",
    acknowledgedAt: null,
    attention: "badge",
    agentState: "available",
    harness: "codex",
    transport: "local",
    summary: "Review the migration diff",
    startedAt: RECENT,
    completedAt: null,
    updatedAt: RECENT,
  };
}

function mkAttention(agentId: string): FleetAttentionItem {
  return {
    kind: "work_item",
    recordId: `work-${agentId}`,
    title: "Review the migration diff",
    summary: "Choose whether the migration is ready to merge",
    agentId,
    agentName: agentId,
    conversationId: null,
    state: "review",
    acceptanceState: "pending",
    updatedAt: RECENT,
  };
}

function mkFleet(asks: FleetAsk[], needsAttention: FleetAttentionItem[] = []): FleetState {
  return {
    generatedAt: NOW,
    totals: { active: asks.length, recentCompleted: 0, needsAttention: needsAttention.length, activity: 0 },
    activeAsks: asks,
    recentCompleted: [],
    needsAttention,
    activity: [],
  };
}

function mkSession(agent: Agent, partial: Partial<SessionEntry> = {}): SessionEntry {
  return {
    id: `c.${agent.id}`,
    kind: "dm",
    title: `${agent.name} session`,
    participantIds: [agent.id],
    agentId: agent.id,
    agentName: agent.name,
    harness: agent.harness,
    harnessSessionId: agent.harnessSessionId,
    harnessLogPath: agent.harnessLogPath,
    currentBranch: agent.branch,
    preview: "Map the project hierarchy",
    messageCount: 8,
    lastMessageAt: RECENT,
    workspaceRoot: agent.projectRoot,
    ...partial,
  };
}

function baseInput(
  agents: Agent[],
  fleet: FleetState | null,
  showEphemeral = false,
  sessions: SessionEntry[] = [],
  discovery: TailDiscoverySnapshot | null = null,
): BuildInboxInput {
  return {
    agents,
    machineId: null,
    sessions,
    fleet,
    discovery,
    nowMs: NOW,
    showEphemeral,
  };
}

describe("buildProjectsInboxModel — collapse + truthful counts", () => {
  test("collapses ID-proliferation: two same-named agents fold into one thread", () => {
    const agents = [
      mkAgent({ id: "scout.a", name: "Scout", branch: "main" }),
      mkAgent({ id: "scout.b", name: "Scout", branch: "feat/x" }),
    ];
    const model = buildProjectsInboxModel(baseInput(agents, null));
    const scoutThreads = model.threads.filter((thread) => thread.agentName === "Scout");
    expect(scoutThreads).toHaveLength(1);
    expect(model.threads).toHaveLength(1);
  });

  test("ephemeral card/clone agents fold away unless showEphemeral", () => {
    const agents = [
      mkAgent({ id: "scout.a", name: "Scout" }),
      mkAgent({ id: "card.1", name: "Openscout Card J Sh3vxg" }),
    ];
    const hidden = buildProjectsInboxModel(baseInput(agents, null, false));
    expect(hidden.threads).toHaveLength(1);
    expect(hidden.threads[0]!.agentName).toBe("Scout");

    const shown = buildProjectsInboxModel(baseInput(agents, null, true));
    expect(shown.threads.length).toBe(2);
  });

  test("your-turn count is sourced only from explicit operator attention", () => {
    const agents = [
      mkAgent({ id: "scout.a", name: "Scout" }),
      mkAgent({ id: "helper.a", name: "Helper", harness: "codex" }),
      mkAgent({ id: "runner.a", name: "Runner", state: "working" }),
    ];
    const askOnly = buildProjectsInboxModel(
      baseInput(agents, mkFleet([mkAsk("helper.a")])),
    );
    expect(askOnly.threads).toHaveLength(3);
    expect(askOnly.threads.filter((thread) => thread.needs)).toHaveLength(0);
    expect(askOnly.threads.filter((thread) => thread.working)).toHaveLength(1);
    expect(askOnly.threads.find((thread) => thread.agentName === "Helper")?.group).toBe("recent");

    const explicitAttention = buildProjectsInboxModel(
      baseInput(
        agents,
        mkFleet([mkAsk("helper.a")], [mkAttention("helper.a")]),
      ),
    );
    const helper = explicitAttention.threads.find((thread) => thread.agentName === "Helper");
    expect(explicitAttention.threads.filter((thread) => thread.needs)).toHaveLength(1);
    expect(helper?.needs).toBe(true);
    expect(helper?.group).toBe("needs");
    expect(helper?.work).toBe("Choose whether the migration is ready to merge");
  });

  test("working asks stay in working instead of being mislabeled as your turn", () => {
    const agent = mkAgent({ id: "worker.a", name: "Worker", state: "working" });
    const ask = { ...mkAsk(agent.id), status: "working" as const, statusLabel: "working" };
    const model = buildProjectsInboxModel(baseInput([agent], mkFleet([ask])));
    expect(model.threads.filter((thread) => thread.needs)).toHaveLength(0);
    expect(model.threads.filter((thread) => thread.working)).toHaveLength(1);
    expect(model.threads[0]?.group).toBe("working");
  });
});

describe("attention ordering", () => {
  test("needs sorts above working sorts above recent", () => {
    const agents = [
      mkAgent({ id: "idle.a", name: "Idler", updatedAt: NOW - 2 * 60 * 60_000 }),
      mkAgent({ id: "work.a", name: "Worker", state: "working" }),
      mkAgent({ id: "need.a", name: "Needer", harness: "codex" }),
    ];
    const model = buildProjectsInboxModel(baseInput(agents, mkFleet([], [mkAttention("need.a")])));
    expect(model.threads.map((thread) => thread.agentName)).toEqual(["Needer", "Worker", "Idler"]);
  });

  test("groupThreads buckets into needs / working / recent in order", () => {
    const agents = [
      mkAgent({ id: "work.a", name: "Worker", state: "working" }),
      mkAgent({ id: "need.a", name: "Needer", harness: "codex" }),
      mkAgent({ id: "idle.a", name: "Idler" }),
    ];
    const model = buildProjectsInboxModel(baseInput(agents, mkFleet([], [mkAttention("need.a")])));
    const groups = groupThreads(model.threads).map((section) => section.group);
    expect(groups).toEqual(["needs", "working", "recent"]);
  });
});

describe("project aggregation + dormancy", () => {
  test("project rollup reports truthful needs/working and dormancy", () => {
    const agents = [
      mkAgent({ id: "os.a", name: "Scout", state: "working" }),
      mkAgent({
        id: "old.a",
        name: "Ghost",
        project: "atelier",
        projectRoot: "/Users/test/dev/atelier",
        cwd: "/Users/test/dev/atelier",
        updatedAt: STALE,
      }),
    ];
    const model = buildProjectsInboxModel(baseInput(agents, null));
    const openscout = model.projects.find((project) => project.slug === "openscout");
    const atelier = model.projects.find((project) => project.slug === "atelier");
    expect(openscout?.working).toBe(1);
    expect(isDormantProject(openscout!, NOW)).toBe(false);
    expect(isDormantProject(atelier!, NOW)).toBe(true);
    // Attention-first: the live project sorts ahead of the dormant one.
    expect(model.projects[0]!.slug).toBe("openscout");
  });

  test("project rollup exposes sessions as siblings of agent threads", () => {
    const scout = mkAgent({ id: "scout.a", name: "Scout" });
    const model = buildProjectsInboxModel(baseInput([scout], null, false, [mkSession(scout)]));
    const openscout = model.projects.find((project) => project.slug === "openscout");

    expect(model.threads).toHaveLength(1);
    expect(model.sessions).toHaveLength(1);
    expect(model.sessions[0]?.agentId).toBe("scout.a");
    expect(model.sessions[0]?.route).toEqual({ view: "conversation", conversationId: "c.scout.a" });
    expect(openscout?.agentCount).toBe(1);
    expect(openscout?.sessionCount).toBe(1);
  });

  test("session-backed actors stay in sessions without inflating the agent roster", () => {
    const actor = mkAgent({
      id: "session-mt4jt8j7-gkg9xg",
      name: "Session Mt4jt8j7 Gkg9xg",
      definitionId: "session-mt4jt8j7-gkg9xg",
      handle: "session-mt4jt8j7-gkg9xg",
      harnessSessionId: "mt4jt8j7-gkg9xg",
    });
    const model = buildProjectsInboxModel(baseInput([actor], null, false, [mkSession(actor)]));
    const openscout = model.projects.find((project) => project.slug === "openscout");

    expect(model.threads).toHaveLength(0);
    expect(model.sessions).toHaveLength(1);
    expect(model.sessions[0]?.agentId).toBe(actor.id);
    expect(openscout?.agentCount).toBe(1);
    expect(openscout?.sessionCount).toBe(1);
  });

  test("keeps a session actor visible while its conversation inventory is lagging", () => {
    const actor = mkAgent({
      id: "session-missing-conversation",
      name: "Session Missing Conversation",
      definitionId: "session-missing-conversation",
      handle: "session-missing-conversation",
      harnessSessionId: "harness-session-123",
      state: "working",
    });

    const model = buildProjectsInboxModel(baseInput([actor], null));
    const openscout = model.projects.find((project) => project.slug === "openscout");

    expect(model.threads).toHaveLength(0);
    expect(model.sessions).toHaveLength(1);
    expect(model.sessions[0]?.agentId).toBe(actor.id);
    expect(model.sessions[0]?.sessionId).toBe("harness-session-123");
    expect(model.sessions[0]?.route).toEqual({ view: "sessions", sessionId: "harness-session-123" });
    expect(sessionRouteRef(model.sessions[0]!)).toBe("session:claude:harness-session-123");
    expect(model.sessions[0]?.working).toBe(true);
    expect(openscout?.sessionCount).toBe(1);
    expect(openscout?.liveSessionCount).toBe(1);
  });

  test("deduplicates fallback registrations by harness-scoped session ref", () => {
    const first = mkAgent({
      id: "session-duplicate-a",
      name: "Session Duplicate A",
      definitionId: "session-duplicate-a",
      harnessSessionId: "shared-session-ref",
    });
    const duplicate = mkAgent({
      id: "session-duplicate-b",
      name: "Session Duplicate B",
      definitionId: "session-duplicate-b",
      harnessSessionId: "shared-session-ref",
    });
    const otherHarness = mkAgent({
      id: "session-duplicate-codex",
      name: "Session Duplicate Codex",
      definitionId: "session-duplicate-codex",
      harness: "codex",
      harnessSessionId: "shared-session-ref",
    });
    const aliasedClaudeHarness = mkAgent({
      id: "session-duplicate-claude-code",
      name: "Session Duplicate Claude Code",
      definitionId: "session-duplicate-claude-code",
      harness: "claude-code",
      harnessSessionId: "shared-session-ref",
    });

    const model = buildProjectsInboxModel(baseInput([first, duplicate, otherHarness, aliasedClaudeHarness], null));

    expect(model.sessions).toHaveLength(2);
    expect(model.sessions.map(sessionRouteRef).sort()).toEqual([
      "session:claude:shared-session-ref",
      "session:codex:shared-session-ref",
    ]);
  });

  test("project rollup preserves the concrete worktree inventory", () => {
    const agents = [
      mkAgent({ id: "main.a", name: "Main", cwd: "/Users/test/dev/openscout", branch: "main" }),
      mkAgent({
        id: "feature.a",
        name: "Feature",
        cwd: "/Users/test/.codex/worktrees/123/openscout",
        branch: "codex/worktree-preview",
      }),
    ];
    const model = buildProjectsInboxModel(baseInput(agents, null));
    const openscout = model.projects.find((project) => project.slug === "openscout");

    expect(openscout?.worktreeCount).toBe(2);
    expect(openscout?.worktrees.map((worktree) => ({ root: worktree.root, branch: worktree.branch }))).toEqual([
      { root: "/Users/test/.codex/worktrees/123/openscout", branch: "codex/worktree-preview" },
      { root: "/Users/test/dev/openscout", branch: "main" },
    ]);
  });

  test("folds a derived Codex worktree project into its canonical repository", () => {
    const agents = [
      mkAgent({ id: "canonical.a", name: "Canonical", cwd: "/Users/test/dev/openscout" }),
      mkAgent({
        id: "canonical-worktree-owner.a",
        name: "Canonical worktree owner",
        projectRoot: "/Users/test/dev/openscout",
        cwd: "/Users/test/.codex/worktrees/fb71/openscout",
        branch: "codex/project-directory",
      }),
      mkAgent({
        id: "worktree.a",
        name: "Worktree endpoint",
        projectRoot: "/Users/test/.codex/worktrees/fb71/openscout",
        cwd: "/Users/test/.codex/worktrees/fb71/openscout",
        branch: "codex/project-directory",
      }),
    ];
    const model = buildProjectsInboxModel(baseInput(agents, null));
    const openscoutProjects = model.projects.filter((project) => project.title.toLowerCase() === "openscout");

    expect(openscoutProjects).toHaveLength(1);
    expect(openscoutProjects[0]?.root).toBe("~/dev/openscout");
    expect(openscoutProjects[0]?.agentCount).toBe(1);
    expect(openscoutProjects[0]?.worktrees.map((worktree) => worktree.root)).toEqual([
      "/Users/test/.codex/worktrees/fb71/openscout",
      "/Users/test/dev/openscout",
    ]);
    expect(new Set(model.threads.map((thread) => thread.projectSlug))).toEqual(new Set([openscoutProjects[0]!.slug]));
    expect(Object.keys(model.projectAliases)).toHaveLength(1);
    const [removedSlug] = Object.keys(model.projectAliases);
    expect(resolveProjectSlug(model, removedSlug!)).toBe(openscoutProjects[0]!.slug);
  });

  test("does not fold an unowned derived worktree into an unrelated same-title clone", () => {
    const agents = [
      mkAgent({ id: "clone.a", name: "Clone", cwd: "/Users/test/dev/openscout" }),
      mkAgent({
        id: "orphan-worktree.a",
        name: "Orphan worktree",
        projectRoot: "/Users/test/.codex/worktrees/orphan/openscout",
        cwd: "/Users/test/.codex/worktrees/orphan/openscout",
      }),
    ];

    const model = buildProjectsInboxModel(baseInput(agents, null));

    expect(model.projects.filter((project) => project.title.toLowerCase() === "openscout")).toHaveLength(2);
    expect(model.projectAliases).toEqual({});
  });

  test("process-only native observations do not become openable sessions", () => {
    const discovery: TailDiscoverySnapshot = {
      generatedAt: NOW,
      processes: [
        {
          pid: 99168,
          ppid: 1,
          command: "claude --verbose",
          etime: "00:10",
          cwd: "/Users/test/dev/openscout",
          harness: "claude",
          parentChain: [],
          source: "claude",
        },
      ],
      transcripts: [],
      issues: [],
      totals: {
        total: 1,
        scoutManaged: 0,
        hudsonManaged: 0,
        unattributed: 1,
        transcripts: 0,
      },
    };
    const model = buildProjectsInboxModel(baseInput([], null, false, [], discovery));
    const openscout = model.projects.find((project) => project.slug === "openscout");

    expect(model.sessions).toHaveLength(0);
    expect(openscout?.sessionCount).toBe(0);
    expect(openscout?.liveSessionCount).toBe(0);
  });

  test("uses transcript event time instead of a freshly touched file for project recency", () => {
    const discovery: TailDiscoverySnapshot = {
      generatedAt: NOW,
      processes: [],
      transcripts: [
        {
          source: "claude",
          transcriptPath: "/Users/test/.claude/projects/-Users-test-dev-arc/session.jsonl",
          sessionId: "claude-arc-session",
          cwd: "/Users/test/dev/arc",
          project: "arc",
          harness: "unattributed",
          lastEventAt: STALE,
          mtimeMs: RECENT,
          size: 42_000,
        },
      ],
      issues: [],
      totals: {
        total: 0,
        scoutManaged: 0,
        hudsonManaged: 0,
        unattributed: 0,
        transcripts: 1,
      },
    };

    const model = buildProjectsInboxModel(baseInput([], null, false, [], discovery));
    const arc = model.projects.find((project) => project.slug === "arc");

    expect(model.threads).toHaveLength(0);
    expect(arc?.lastActivityAt).toBe(STALE);
    expect(arc && isDormantProject(arc, NOW)).toBe(true);
  });

  test("projects the latest observed assistant reply onto its exact harness session", () => {
    const sessionId = "01a045dd-783e-7660-b714-0e7d83f9dc67";
    const discovery: TailDiscoverySnapshot = {
      generatedAt: NOW,
      processes: [],
      transcripts: [{
        source: "codex",
        transcriptPath: `/Users/test/.codex/sessions/rollout-${sessionId}.jsonl`,
        sessionId,
        cwd: "/Users/test/dev/openscout",
        project: "openscout",
        harness: "unattributed",
        lastEventAt: NOW - 2_000,
        mtimeMs: NOW - 1_000,
        size: 42_000,
      }],
      issues: [],
      totals: {
        total: 0,
        scoutManaged: 0,
        hudsonManaged: 0,
        unattributed: 0,
        transcripts: 1,
      },
    };
    const recentEvents: TailEvent[] = [
      {
        id: "codex:assistant:latest",
        ts: NOW - 2_000,
        source: "codex",
        sessionId,
        pid: -1,
        parentPid: null,
        project: "openscout",
        cwd: "/Users/test/dev/openscout",
        harness: "unattributed",
        kind: "assistant",
        summary: "No bribes. The title bar and anchored controls are fixed.",
      },
      {
        id: "codex:user:newer-but-not-a-reply",
        ts: NOW - 1_000,
        source: "codex",
        sessionId,
        pid: -1,
        parentPid: null,
        project: "openscout",
        cwd: "/Users/test/dev/openscout",
        harness: "unattributed",
        kind: "user",
        summary: "Can I steer this?",
      },
      {
        id: "codex:developer:not-a-reply",
        ts: NOW,
        source: "codex",
        sessionId,
        pid: -1,
        parentPid: null,
        project: "openscout",
        cwd: "/Users/test/dev/openscout",
        harness: "unattributed",
        kind: "assistant",
        summary: "Follow the workspace approval policy.",
        raw: { type: "response_item", payload: { type: "message", role: "developer" } },
      },
      {
        id: "codex:approval-review:not-a-reply",
        ts: NOW + 1,
        source: "codex",
        sessionId,
        pid: -1,
        parentPid: null,
        project: "openscout",
        cwd: "/Users/test/dev/openscout",
        harness: "unattributed",
        kind: "assistant",
        summary: JSON.stringify({
          risk_level: "low",
          user_authorization: "medium",
          outcome: "allow",
          rationale: "Read-only local verification.",
        }),
        raw: { type: "response_item", payload: { type: "message", role: "assistant" } },
      },
    ];

    const model = buildProjectsInboxModel({
      ...baseInput([], null, false, [], discovery),
      recentEvents,
    });
    const session = model.sessions[0]!;

    expect(session.latestReplyAt).toBe(NOW - 2_000);
    expect(session.latestReplyPreview).toBe("No bribes. The title bar and anchored controls are fixed.");
    expect(session.sessionId).toBe(sessionId);
    expect(sessionOpenRoute(session, { view: "agents-v2", projectSlug: session.projectSlug })).toEqual({
      view: "agents-v2",
      projectSlug: "openscout",
      indexView: "sessions",
      sessionId: `session:codex:${sessionId}`,
      selectedAgentId: undefined,
    });
  });

  test("keeps same-id replies scoped to their source harness", () => {
    const sharedSessionId = "shared-session";
    const discovery: TailDiscoverySnapshot = {
      generatedAt: NOW,
      processes: [],
      transcripts: [
        {
          source: "codex",
          transcriptPath: "/Users/test/.codex/sessions/shared-session.jsonl",
          sessionId: sharedSessionId,
          cwd: "/Users/test/dev/openscout",
          project: "openscout",
          harness: "unattributed",
          lastEventAt: NOW - 2_000,
          mtimeMs: NOW - 2_000,
          size: 42_000,
        },
        {
          source: "claude",
          transcriptPath: "/Users/test/.claude/projects/blink/shared-session.jsonl",
          sessionId: sharedSessionId,
          cwd: "/Users/test/dev/blink",
          project: "blink",
          harness: "unattributed",
          lastEventAt: NOW - 1_000,
          mtimeMs: NOW - 1_000,
          size: 24_000,
        },
      ],
      issues: [],
      totals: {
        total: 0,
        scoutManaged: 0,
        hudsonManaged: 0,
        unattributed: 0,
        transcripts: 2,
      },
    };
    const recentEvents: TailEvent[] = [
      {
        id: "codex:shared-session:reply",
        ts: NOW - 2_000,
        source: "codex",
        sessionId: sharedSessionId,
        pid: -1,
        parentPid: null,
        project: "openscout",
        cwd: "/Users/test/dev/openscout",
        harness: "unattributed",
        kind: "assistant",
        summary: "Codex response",
      },
      {
        id: "claude:shared-session:reply",
        ts: NOW - 1_000,
        source: "claude",
        sessionId: sharedSessionId,
        pid: -1,
        parentPid: null,
        project: "blink",
        cwd: "/Users/test/dev/blink",
        harness: "unattributed",
        kind: "assistant",
        summary: "Claude response",
      },
    ];

    const model = buildProjectsInboxModel({
      ...baseInput([], null, false, [], discovery),
      recentEvents,
    });
    const codex = model.sessions.find((session) => session.harness === "codex");
    const claude = model.sessions.find((session) => session.harness === "claude");

    expect(codex?.latestReplyPreview).toBe("Codex response");
    expect(codex?.latestReplyAt).toBe(NOW - 2_000);
    expect(claude?.latestReplyPreview).toBe("Claude response");
    expect(claude?.latestReplyAt).toBe(NOW - 1_000);
    expect(sessionRouteRef(codex!)).toBe("session:codex:shared-session");
    expect(sessionRouteRef(claude!)).toBe("session:claude:shared-session");
    const bareRoute = { view: "agents-v2" as const, sessionId: sharedSessionId };
    expect(isSessionSelected(codex!, bareRoute, model.sessions)).toBe(false);
    expect(isSessionSelected(claude!, bareRoute, model.sessions)).toBe(false);
    const legacyPrefixedRoute = { view: "agents-v2" as const, sessionId: `session:${sharedSessionId}` };
    expect(isSessionSelected(codex!, legacyPrefixedRoute, model.sessions)).toBe(false);
    expect(isSessionSelected(claude!, legacyPrefixedRoute, model.sessions)).toBe(false);
    expect(isSessionSelected(
      codex!,
      { view: "agents-v2", sessionId: "session:codex:shared-session" },
      model.sessions,
    )).toBe(true);

    const codexThread = model.threads.find((thread) => thread.kind === "native" && thread.harness === "codex")!;
    const claudeThread = model.threads.find((thread) => thread.kind === "native" && thread.harness === "claude")!;
    expect(threadRouteRef(codexThread)).toBe("session:codex:shared-session");
    expect(threadRouteRef(claudeThread)).toBe("session:claude:shared-session");
    expect(isThreadSelected(codexThread, bareRoute, model.threads)).toBe(false);
    expect(isThreadSelected(claudeThread, bareRoute, model.threads)).toBe(false);
    expect(isThreadSelected(codexThread, legacyPrefixedRoute, model.threads)).toBe(false);
    expect(isThreadSelected(claudeThread, legacyPrefixedRoute, model.threads)).toBe(false);
    const codexThreadRoute = threadSelectRoute(codexThread, { view: "agents-v2" });
    expect(codexThreadRoute.sessionId).toBe("session:codex:shared-session");
    expect(isThreadSelected(codexThread, codexThreadRoute, model.threads)).toBe(true);
    expect(isThreadSelected(claudeThread, codexThreadRoute, model.threads)).toBe(false);
    expect(threadOpenRoute(codexThread, { view: "agents-v2" })).toEqual({
      view: "sessions",
      sessionId: "session:codex:shared-session",
    });
    expect(threadObserveRoute(codexThread, { view: "agents-v2" })).toEqual({
      view: "sessions",
      sessionId: "session:codex:shared-session",
    });
  });
});

describe("filters + routing", () => {
  test("threadsForProject scopes to one slug", () => {
    const agents = [
      mkAgent({ id: "os.a", name: "Scout" }),
      mkAgent({
        id: "at.a",
        name: "Maker",
        project: "atelier",
        projectRoot: "/Users/test/dev/atelier",
        cwd: "/Users/test/dev/atelier",
      }),
    ];
    const model = buildProjectsInboxModel(baseInput(agents, null));
    const slug = model.projects.find((project) => project.slug === "openscout")!.slug;
    const scoped = threadsForProject(model.threads, slug);
    expect(scoped).toHaveLength(1);
    expect(scoped[0]!.agentName).toBe("Scout");
  });

  test("select vs open routes hit existing surfaces", () => {
    const agents = [mkAgent({ id: "scout.a", name: "Scout", conversationId: "conv-1" })];
    const model = buildProjectsInboxModel(baseInput(agents, null));
    const thread = model.threads[0]!;
    const route = { view: "agents-v2" as const };

    const select = threadSelectRoute(thread, route);
    expect(select.selectedAgentId).toBe("scout.a");
    expect(isThreadSelected(thread, select, model.threads)).toBe(true);

    const open = threadOpenRoute(thread, route);
    expect(open).toEqual({ view: "conversation", conversationId: "conv-1" });
  });

  test("session selection uses session ids, then conversation ids, never stable row refs", () => {
    const agents = [mkAgent({ id: "scout.a", name: "Scout" })];
    const model = buildProjectsInboxModel(baseInput(agents, null, false, [mkSession(agents[0]!)]));
    const session = model.sessions[0]!;
    expect(session.sessionId).toBeTruthy();
    const canonicalSessionId = session.sessionId!;
    const select = { view: "agents-v2" as const, projectSlug: session.projectSlug, sessionId: session.sessionId ?? undefined };
    expect(isSessionSelected(session, select, model.sessions)).toBe(true);
    expect(isSessionSelected(
      session,
      { ...select, sessionId: `session:${canonicalSessionId}` },
      model.sessions,
    )).toBe(true);
    expect(sessionSelectRoute(session, { view: "agents-v2", projectSlug: session.projectSlug }).selectedAgentId).toBeUndefined();
    expect(sessionOpenRoute(session, { view: "agents-v2", projectSlug: session.projectSlug })).toEqual({
      view: "agents-v2",
      projectSlug: session.projectSlug,
      indexView: "sessions",
      sessionId: canonicalSessionId,
      selectedAgentId: undefined,
    });

    const conversationBacked = { ...session, sessionId: null };
    const conversationSelect = sessionSelectRoute(conversationBacked, { view: "agents-v2", projectSlug: conversationBacked.projectSlug });
    expect(conversationSelect.sessionId).toBe("c.scout.a");
    expect(conversationSelect.selectedAgentId).toBeUndefined();
    expect(isSessionSelected(conversationBacked, { view: "agents-v2", sessionId: "c.scout.a" }, [conversationBacked])).toBe(true);

    const liveProcess = { ...session, sessionId: null, conversationId: null, route: null };
    const liveSelect = sessionSelectRoute(liveProcess, { view: "agents-v2", projectSlug: liveProcess.projectSlug });
    expect(liveSelect).toEqual({ view: "agents-v2", projectSlug: liveProcess.projectSlug });
    expect(isSessionSelected(liveProcess, { view: "agents-v2", sessionId: "scout:c.scout.a" }, [liveProcess])).toBe(false);

    expect(sessionOpenRoute(liveProcess, { view: "agents-v2", projectSlug: liveProcess.projectSlug })).toEqual({
      view: "agents-v2",
      projectSlug: liveProcess.projectSlug,
      indexView: "sessions",
      selectedAgentId: undefined,
      sessionId: undefined,
    });
  });

});
