import { describe, expect, test } from "bun:test";
import type { Agent } from "../../lib/types.ts";
import type { InboxProject, InboxThread } from "./projects-inbox-model.ts";
import {
  buildCrewMembers,
  memberMatchesQuery,
  memberMatchesStatus,
  projectMatchesQuery,
  projectMatchesStatus,
} from "./crew-workspaces-model.ts";

const NOW = 1_700_000_000_000;

function mkProject(partial: Partial<InboxProject> & { slug: string }): InboxProject {
  return {
    title: partial.slug,
    root: `/work/${partial.slug}`,
    agentCount: 1,
    sessionCount: 0,
    liveSessionCount: 0,
    worktreeCount: 1,
    worktrees: [],
    needs: 0,
    working: 0,
    threadCount: 0,
    lastActivityAt: NOW,
    branches: [],
    ...partial,
  };
}

function mkThread(partial: Partial<InboxThread> & { id: string; projectSlug: string }): InboxThread {
  return {
    kind: "agent",
    projectTitle: partial.projectSlug,
    projectRoot: `/work/${partial.projectSlug}`,
    workspaceRoot: `/work/${partial.projectSlug}`,
    agentId: null,
    agentName: "Project endpoint",
    harness: "claude",
    branch: "main",
    work: "Reviewing the migration diff",
    group: "recent",
    needs: false,
    working: false,
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
    definitionId: `${partial.id}-definition`,
    handle: null,
    agentClass: "agent",
    harness: "claude",
    state: "callable",
    projectRoot: null,
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
  test("emits one durable project agent across Claude and Codex endpoints", () => {
    const project = mkProject({
      slug: "openscout",
      title: "OpenScout",
      sessionCount: 12,
      liveSessionCount: 2,
      working: 2,
    });
    const threads = [
      mkThread({
        id: "openscout:claude",
        projectSlug: "openscout",
        agentId: "claude-endpoint",
        harness: "claude",
        working: true,
      }),
      mkThread({
        id: "openscout:codex",
        projectSlug: "openscout",
        agentId: "codex-endpoint",
        harness: "codex",
        working: true,
      }),
    ];
    const agents = [
      mkAgent({ id: "claude-endpoint", name: "Claude endpoint", projectRoot: "/work/openscout" }),
      mkAgent({ id: "codex-endpoint", name: "Codex endpoint", projectRoot: "/work/openscout", harness: "codex" }),
    ];

    const members = buildCrewMembers([project], threads, agents);

    expect(members).toHaveLength(1);
    expect(members[0]!.key).toBe("project:openscout");
    expect(members[0]!.kind).toBe("project");
    expect(members[0]!.agentId).toBeNull();
    expect(members[0]!.harnesses).toEqual(["claude", "codex"]);
    expect(members[0]!.sessionCount).toBe(12);
  });

  test("never promotes a Session Mt actor into the durable roster", () => {
    const sessionActor = mkAgent({
      id: "session-mt4jt8j7-gkg9xg",
      name: "Session Mt4jt8j7 Gkg9xg",
      definitionId: "session-mt4jt8j7-gkg9xg",
      handle: "session-mt4jt8j7-gkg9xg",
    });

    const members = buildCrewMembers([mkProject({ slug: "openscout" })], [], [sessionActor]);

    expect(members).toHaveLength(1);
    expect(members[0]!.kind).toBe("project");
    expect(members.some((member) => member.name.startsWith("Session Mt"))).toBe(false);
  });

  test("deduplicates horizontal role endpoints by durable definition", () => {
    const agents = [
      mkAgent({
        id: "reviewer-claude",
        name: "Release reviewer",
        definitionId: "release-reviewer",
        handle: "release-reviewer",
        role: "Reviewer",
        cwd: null,
      }),
      mkAgent({
        id: "reviewer-codex",
        name: "Release reviewer",
        definitionId: "release-reviewer",
        handle: "release-reviewer",
        role: "Reviewer",
        harness: "codex",
        cwd: null,
        updatedAt: NOW - 1,
      }),
    ];
    const threads = [
      mkThread({ id: "review:a", projectSlug: "openscout", agentId: "reviewer-claude", working: true }),
      mkThread({ id: "review:b", projectSlug: "talkie", agentId: "reviewer-codex", harness: "codex" }),
    ];

    const members = buildCrewMembers(
      [mkProject({ slug: "openscout" }), mkProject({ slug: "talkie" })],
      threads,
      agents,
    );
    const roles = members.filter((member) => member.kind === "role");

    expect(roles).toHaveLength(1);
    expect(roles[0]!.key).toBe("role:release-reviewer");
    expect(roles[0]!.harnesses).toEqual(["claude", "codex"]);
    expect(roles[0]!.substrates.map((substrate) => substrate.projectSlug)).toEqual(["openscout", "talkie"]);
  });

  test("keeps a durable role when its coding endpoints span multiple projects", () => {
    const agents = [
      mkAgent({
        id: "reviewer-openscout",
        name: "Release reviewer",
        definitionId: "release-reviewer",
        role: "Reviewer",
        project: "openscout",
        projectRoot: "/work/openscout",
        cwd: "/work/openscout",
      }),
      mkAgent({
        id: "reviewer-talkie",
        name: "Release reviewer",
        definitionId: "release-reviewer",
        role: "Reviewer",
        project: "talkie",
        projectRoot: "/work/talkie",
        cwd: "/work/talkie",
      }),
    ];
    const threads = [
      mkThread({ id: "review:openscout", projectSlug: "openscout", agentId: "reviewer-openscout" }),
      mkThread({ id: "review:talkie", projectSlug: "talkie", agentId: "reviewer-talkie" }),
    ];

    const members = buildCrewMembers(
      [mkProject({ slug: "openscout" }), mkProject({ slug: "talkie" })],
      threads,
      agents,
    );

    expect(members.filter((member) => member.kind === "role").map((member) => member.key))
      .toEqual(["role:release-reviewer"]);
  });

  test("does not misclassify a project-bound named definition as horizontal", () => {
    const endpoint = mkAgent({
      id: "project-reviewer",
      name: "Project reviewer",
      definitionId: "project-reviewer",
      role: "Reviewer",
      projectRoot: "/work/openscout",
    });

    const members = buildCrewMembers([mkProject({ slug: "openscout" })], [], [endpoint]);
    expect(members.filter((member) => member.kind === "role")).toHaveLength(0);
    expect(members.filter((member) => member.kind === "project")).toHaveLength(1);
  });

  test("treats workspace-qualified and cwd-owned registrations as project endpoints", () => {
    const project = mkProject({ slug: "openscout" });
    const workspaceQualified = mkAgent({
      id: "workspace-endpoint",
      name: "Workspace endpoint",
      handle: "workspace-endpoint",
      workspaceQualifier: "openscout",
    });
    const cwdOwned = mkAgent({
      id: "cwd-endpoint",
      name: "Cwd endpoint",
      handle: "cwd-endpoint",
      cwd: "/work/openscout",
    });
    const unrelatedCwd = mkAgent({
      id: "unrelated-cwd-endpoint",
      name: "Unrelated cwd endpoint",
      handle: "unrelated-cwd-endpoint",
      cwd: "/some/other/repo/packages/web",
    });
    const threads = [
      mkThread({ id: "cwd-thread", projectSlug: "openscout", agentId: cwdOwned.id }),
    ];

    const members = buildCrewMembers([project], threads, [workspaceQualified, cwdOwned, unrelatedCwd]);

    expect(members.filter((member) => member.kind === "role")).toHaveLength(0);
    expect(members.filter((member) => member.kind === "project")).toHaveLength(1);
  });

  test("scopes horizontal role identities to the selected machine", () => {
    const local = mkAgent({
      id: "local-reviewer",
      name: "Local reviewer",
      definitionId: "shared-reviewer",
      handle: "local-reviewer",
      homeNodeId: "local",
      cwd: null,
    });
    const remote = mkAgent({
      id: "remote-reviewer",
      name: "Remote reviewer",
      definitionId: "shared-reviewer",
      handle: "remote-reviewer",
      homeNodeId: "remote",
      cwd: null,
      updatedAt: NOW + 1,
    });

    const members = buildCrewMembers([mkProject({ slug: "openscout" })], [], [local, remote], "local");
    const roles = members.filter((member) => member.kind === "role");

    expect(roles.map((member) => ({ name: member.name, agentId: member.agentId })))
      .toEqual([{ name: "Local reviewer", agentId: "local-reviewer" }]);
  });

  test("keeps a quiet project visible as a base identity", () => {
    const members = buildCrewMembers([mkProject({ slug: "quiet", lastActivityAt: 0 })], [], []);
    expect(members).toHaveLength(1);
    expect(members[0]!.status).toBe("idle");
    expect(members[0]!.work).toBe("No active work");
  });
});

describe("directory filters", () => {
  const needsProject = mkProject({ slug: "openscout", title: "OpenScout", needs: 1 });
  const idleProject = mkProject({ slug: "talkie", title: "Talkie", lastActivityAt: 0 });
  const [needsMember, idleMember] = buildCrewMembers([needsProject, idleProject], [], []);

  test("status filters preserve needs and idle buckets", () => {
    expect(memberMatchesStatus(needsMember!, "needs")).toBe(true);
    expect(memberMatchesStatus(idleMember!, "idle")).toBe(true);
    expect(projectMatchesStatus(needsProject, "needs")).toBe(true);
    expect(projectMatchesStatus(idleProject, "idle")).toBe(true);
  });

  test("query matches durable identity and project path", () => {
    expect(memberMatchesQuery(needsMember!, "openscout")).toBe(true);
    expect(memberMatchesQuery(needsMember!, "/work/openscout")).toBe(true);
    expect(memberMatchesQuery(needsMember!, "talkie")).toBe(false);
    expect(projectMatchesQuery(idleProject, "/work/talkie")).toBe(true);
  });
});
