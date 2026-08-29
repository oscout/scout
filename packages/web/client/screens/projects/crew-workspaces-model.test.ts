import { describe, expect, test } from "bun:test";
import type { Agent } from "../../lib/types.ts";
import type { InboxProject, InboxThread } from "./projects-inbox-model.ts";
import {
  buildCrewMembers,
  buildRuntimeLens,
  buildWorkspaceLens,
  crewHarnesses,
  memberMatchesHarness,
  memberMatchesQuery,
  memberMatchesStatus,
} from "./crew-workspaces-model.ts";

const NOW = 1_700_000_000_000;

function mkThread(partial: Partial<InboxThread> & { id: string; agentName: string; projectSlug: string }): InboxThread {
  return {
    kind: "agent",
    projectTitle: partial.projectSlug,
    projectRoot: `/work/${partial.projectSlug}`,
    workspaceRoot: `/work/${partial.projectSlug}`,
    agentId: `agent:${partial.agentName.toLowerCase()}`,
    harness: "claude",
    branch: "main",
    work: "Reviewing the migration diff",
    group: "working",
    needs: false,
    working: true,
    lastActivityAt: NOW,
    sessionCount: 1,
    contextPct: null,
    conversationId: null,
    sessionId: null,
    ...partial,
  };
}

function mkAgent(partial: Partial<Agent> & { id: string; name: string }): Agent {
  return {
    definitionId: `${partial.id}-def`,
    handle: null,
    agentClass: "agent",
    harness: "claude",
    state: "callable",
    projectRoot: "/work",
    cwd: "/work",
    updatedAt: NOW,
    createdAt: NOW,
    transport: "local",
    selector: null,
    defaultSelector: null,
    nodeQualifier: null,
    workspaceQualifier: null,
    wakePolicy: null,
    capabilities: [],
    project: null,
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

describe("buildCrewMembers", () => {
  test("re-collapses per-project agent threads into one card per crew identity", () => {
    const threads = [
      mkThread({ id: "openscout:agent:1", agentName: "Milo", projectSlug: "openscout", agentId: "agent:milo", working: true }),
      mkThread({ id: "talkie:agent:1", agentName: "Milo", projectSlug: "talkie", agentId: "agent:milo", working: false, lastActivityAt: NOW - 60_000 }),
      mkThread({ id: "openscout:agent:2", agentName: "Brik", projectSlug: "openscout", agentId: "agent:brik", needs: true, working: false }),
    ];
    const agentsById = new Map<string, Agent>([
      ["agent:milo", mkAgent({ id: "agent:milo", name: "Milo", role: "Reviewer" })],
      ["agent:brik", mkAgent({ id: "agent:brik", name: "Brik" })],
    ]);

    const members = buildCrewMembers(threads, agentsById);
    expect(members).toHaveLength(2);

    const milo = members.find((member) => member.name === "Milo");
    expect(milo?.substrates).toHaveLength(2);
    expect(milo?.substrates.map((substrate) => substrate.projectSlug)).toEqual(["openscout", "talkie"]);
    expect(milo?.working).toBe(true);
    expect(milo?.status).toBe("working");
    expect(milo?.headline).toBe("Reviewer");

    // Needs-attention crew ranks first.
    expect(members[0]!.name).toBe("Brik");
    expect(members[0]!.status).toBe("needs");
  });

  test("falls back to a name+harness identity when agentId is missing", () => {
    const threads = [
      mkThread({ id: "a:1", agentName: "Codex session", projectSlug: "a", agentId: null, harness: "codex" }),
    ];
    const members = buildCrewMembers(threads, new Map());
    expect(members).toHaveLength(1);
    expect(members[0]!.key).toBe("named:codex:codex session");
  });

  test("ignores native (unattributed) threads — crew cards need an agent thread", () => {
    const threads = [mkThread({ id: "a:1", agentName: "Codex session", projectSlug: "a", kind: "native" })];
    expect(buildCrewMembers(threads, new Map())).toHaveLength(0);
  });
});

describe("buildWorkspaceLens", () => {
  test("inverts the crew roster into per-project stations", () => {
    const threads = [
      mkThread({ id: "openscout:agent:1", agentName: "Milo", projectSlug: "openscout", agentId: "agent:milo" }),
      mkThread({ id: "talkie:agent:1", agentName: "Milo", projectSlug: "talkie", agentId: "agent:milo" }),
      mkThread({ id: "openscout:agent:2", agentName: "Brik", projectSlug: "openscout", agentId: "agent:brik" }),
    ];
    const members = buildCrewMembers(threads, new Map());
    const projects: InboxProject[] = ["openscout", "talkie"].map((slug) => ({
      slug,
      title: slug,
      root: `/work/${slug}`,
      agentCount: 0,
      sessionCount: 0,
      liveSessionCount: 0,
      worktreeCount: 0,
      worktrees: [],
      needs: 0,
      working: 1,
      threadCount: 0,
      lastActivityAt: NOW,
      branches: [],
    }));

    const workspaces = buildWorkspaceLens(members, projects);
    const openscout = workspaces.find((workspace) => workspace.slug === "openscout");
    const talkie = workspaces.find((workspace) => workspace.slug === "talkie");
    expect(openscout?.crew).toHaveLength(2);
    expect(talkie?.crew).toHaveLength(1);
    expect(talkie?.crew[0]!.member.name).toBe("Milo");
  });
});

describe("buildRuntimeLens", () => {
  test("groups crew members by runtime engine with honest counts", () => {
    const threads = [
      mkThread({ id: "openscout:agent:1", agentName: "Milo", projectSlug: "openscout", agentId: "agent:milo", harness: "claude", working: true }),
      mkThread({ id: "talkie:agent:1", agentName: "Lulu", projectSlug: "talkie", agentId: "agent:lulu", harness: "claude", needs: true }),
      mkThread({ id: "openscout:agent:2", agentName: "Brik", projectSlug: "openscout", agentId: "agent:brik", harness: "codex", working: false }),
    ];
    const members = buildCrewMembers(threads, new Map());
    const runtimes = buildRuntimeLens(members);

    expect(runtimes).toHaveLength(2);
    const claude = runtimes.find((r) => r.harness === "claude");
    const codex = runtimes.find((r) => r.harness === "codex");

    expect(claude?.crew).toHaveLength(2);
    expect(claude?.needs).toBe(1);
    expect(claude?.working).toBe(1);
    expect(claude?.title).toBe("Claude");

    expect(codex?.crew).toHaveLength(1);
    expect(codex?.needs).toBe(0);
    expect(codex?.title).toBe("Codex");
  });
});

describe("crew filters", () => {
  const threads = [
    mkThread({ id: "a:1", agentName: "Milo", projectSlug: "a", agentId: "agent:milo", harness: "claude", needs: true, working: false, work: "Fixing the release train" }),
    mkThread({ id: "b:1", agentName: "Brik", projectSlug: "b", agentId: "agent:brik", harness: "codex", needs: false, working: false }),
  ];
  const members = buildCrewMembers(threads, new Map());
  const milo = members.find((member) => member.name === "Milo")!;
  const brik = members.find((member) => member.name === "Brik")!;

  test("memberMatchesStatus buckets needs / active / idle", () => {
    expect(memberMatchesStatus(milo, "needs")).toBe(true);
    expect(memberMatchesStatus(milo, "idle")).toBe(false);
    expect(memberMatchesStatus(brik, "idle")).toBe(true);
    expect(memberMatchesStatus(brik, "active")).toBe(false);
  });

  test("memberMatchesHarness is case-insensitive and 'all' passes everything", () => {
    expect(memberMatchesHarness(milo, "claude")).toBe(true);
    expect(memberMatchesHarness(milo, "CODEX")).toBe(false);
    expect(memberMatchesHarness(brik, "all")).toBe(true);
  });

  test("memberMatchesQuery matches name, role, project, and work text", () => {
    expect(memberMatchesQuery(milo, "release train")).toBe(true);
    expect(memberMatchesQuery(milo, "brik")).toBe(false);
    expect(memberMatchesQuery(milo, "")).toBe(true);
  });

  test("crewHarnesses lists distinct lowercase runtimes", () => {
    expect(crewHarnesses(members)).toEqual(["claude", "codex"]);
  });
});
