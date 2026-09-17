import { describe, expect, test } from "bun:test";
import type { Agent, SessionEntry } from "../../lib/types.ts";
import {
  buildChannelMembers,
  channelDisplayLabel,
  channelMemberForActor,
  sharedChannelWorkspace,
} from "./channel-context-model.ts";

const agent = (overrides: Partial<Agent> & Pick<Agent, "id" | "name">): Agent => ({
  definitionId: overrides.id,
  handle: null,
  agentClass: "managed_session",
  harness: "claude",
  state: "idle",
  projectRoot: "/workspace/openscout",
  cwd: "/workspace/openscout",
  updatedAt: 1_700_000_000_000,
  createdAt: 1_699_000_000_000,
  transport: "tmux",
  selector: null,
  defaultSelector: null,
  nodeQualifier: null,
  workspaceQualifier: null,
  wakePolicy: null,
  capabilities: [],
  project: "openscout",
  branch: "main",
  role: null,
  model: "claude-opus",
  harnessSessionId: null,
  terminalSurface: null,
  harnessLogPath: null,
  conversationId: null,
  homeNodeId: null,
  homeNodeName: null,
  ownerId: null,
  ownerName: null,
  ownerHandle: null,
  staleLocalRegistration: false,
  retiredFromFleet: false,
  replacedByAgentId: null,
  ...overrides,
});

const channel: SessionEntry = {
  id: "chn-1",
  kind: "channel",
  title: "message-lifecycle-design",
  alias: "#message-lifecycle-design",
  participantIds: ["operator", "session-tesla", "agent-kepler", "agent-faraday"],
  participants: [
    {
      actorId: "operator",
      kind: "person",
      displayName: "Operator",
      label: "Operator",
    },
    {
      actorId: "session-tesla",
      kind: "session",
      displayName: "openscout-mendel-4",
      label: "openscout-mendel-4 · Tesla",
      scopedAlias: "Tesla",
      sessionId: "session-tesla",
      harness: "claude",
      workspaceRoot: "/workspace/openscout",
    },
    {
      actorId: "agent-kepler",
      kind: "agent",
      displayName: "Openscout",
      label: "Openscout · Kepler",
      scopedAlias: "Kepler",
      agentId: "agent-kepler",
      sessionId: "session-tesla",
      harness: "claude",
      workspaceRoot: "/workspace/openscout",
    },
    {
      actorId: "agent-faraday",
      kind: "agent",
      displayName: "Openscout",
      label: "Openscout · Faraday",
      scopedAlias: "Faraday",
      agentId: "agent-faraday",
      sessionId: "relay-faraday",
      harness: "claude",
      workspaceRoot: "/workspace/openscout",
    },
  ],
  agentId: null,
  agentName: null,
  harness: null,
  harnessSessionId: null,
  harnessLogPath: null,
  currentBranch: null,
  preview: null,
  messageCount: 0,
  lastMessageAt: null,
  workspaceRoot: null,
};

describe("channel context profiles", () => {
  test("uses a human channel identity instead of the opaque id", () => {
    expect(channelDisplayLabel(channel, channel.id)).toBe("#message-lifecycle-design");
    expect(channelDisplayLabel({ ...channel, alias: null, title: "reviews" }, channel.id)).toBe("#reviews");
  });

  test("deduplicates session and agent identities while preserving every activity key", () => {
    const members = buildChannelMembers(
      channel,
      [
        agent({ id: "agent-kepler", name: "Openscout", harnessSessionId: "session-tesla" }),
        agent({ id: "agent-faraday", name: "Openscout", harnessSessionId: "relay-faraday" }),
      ],
      [{ actorId: "agent-kepler", status: "running", updatedAt: 1_700_000_000_500, active: true }],
    );

    expect(members).toHaveLength(3);
    const tesla = members.find((member) => member.name === "Tesla");
    expect(tesla?.status).toBe("working");
    expect(tesla?.preferredRoute).toBe("session");
    expect(tesla?.actorIds).toEqual(expect.arrayContaining(["session-tesla", "agent-kepler"]));
    expect(channelMemberForActor(members, "agent-kepler")?.name).toBe("Tesla");
  });

  test("does not claim channel work from fleet presence alone", () => {
    const members = buildChannelMembers(
      channel,
      [agent({ id: "agent-kepler", name: "Openscout", state: "working" })],
      [],
    );

    expect(members.find((member) => member.name === "Tesla")?.status).toBe("available");
  });

  test("marks a channel-linked wait distinctly and finds the shared workspace", () => {
    const members = buildChannelMembers(
      channel,
      [],
      [{ actorId: "session-tesla", status: "queued", updatedAt: 1_700_000_000_500, active: true }],
    );

    expect(members.find((member) => member.name === "Tesla")?.status).toBe("waiting");
    expect(sharedChannelWorkspace(members)).toBe("openscout");
  });

  test("does not project a completed recent run as current work", () => {
    const members = buildChannelMembers(
      channel,
      [],
      [{ actorId: "session-tesla", status: "Completed", updatedAt: 1_700_000_000_500, active: false }],
    );

    expect(members.find((member) => member.name === "Tesla")?.status).toBe("unknown");
  });

  test("does not present a literal offline agent as available", () => {
    const members = buildChannelMembers(
      channel,
      [agent({ id: "agent-kepler", name: "Openscout", state: "offline" })],
      [],
    );

    expect(members.find((member) => member.name === "Tesla")?.status).toBe("offline");
  });
});

describe("distinct team members", () => {
  // A team channel has several humans in it. The model used to fold every
  // person into a single "operator" member, which silently merged teammates
  // into the viewer.
  const teamChannel: SessionEntry = {
    ...channel,
    participantIds: ["person-maya", "person-art", "agent-kepler"],
    participants: [
      { actorId: "person-maya", kind: "person", displayName: "Maya", label: "Maya" },
      { actorId: "person-art", kind: "person", displayName: "Art", label: "Art" },
      {
        actorId: "agent-kepler",
        kind: "agent",
        displayName: "Openscout",
        label: "Openscout · Kepler",
        scopedAlias: "Kepler",
        agentId: "agent-kepler",
        sessionId: "session-tesla",
        harness: "codex",
        workspaceRoot: "/workspace/openscout",
      },
    ],
  };

  test("two humans are two members, not one merged operator", () => {
    const members = buildChannelMembers(teamChannel, [], [], {
      viewerActorId: "person-art",
    });
    const people = members.filter((member) => member.isPerson);
    expect(people).toHaveLength(2);
    expect(people.map((member) => member.name).sort()).toEqual(["Maya", "You"]);
  });

  test("exactly one member is the viewer, and the viewer decides which", () => {
    const asArt = buildChannelMembers(teamChannel, [], [], { viewerActorId: "person-art" });
    expect(asArt.filter((member) => member.isSelf)).toHaveLength(1);
    expect(asArt.find((member) => member.isSelf)?.actorIds).toContain("person-art");

    // The same channel seen by the other teammate: membership is identical,
    // only the "You" moves.
    const asMaya = buildChannelMembers(teamChannel, [], [], { viewerActorId: "person-maya" });
    expect(asMaya.filter((member) => member.isSelf)).toHaveLength(1);
    expect(asMaya.find((member) => member.isSelf)?.actorIds).toContain("person-maya");
    expect(asMaya).toHaveLength(asArt.length);
  });

  test("a viewer who is not in the channel makes nobody 'You'", () => {
    const members = buildChannelMembers(teamChannel, [], [], {
      viewerActorId: "person-stranger",
    });
    expect(members.filter((member) => member.isSelf)).toHaveLength(0);
    expect(members.map((member) => member.name)).not.toContain("You");
  });

  test("a second human does not break workspace inference", () => {
    const members = buildChannelMembers(teamChannel, [], [], {
      viewerActorId: "person-art",
    });
    expect(sharedChannelWorkspace(members)).toBe("openscout");
  });

  test("the connection plane stays separate from the activity status", () => {
    const members = buildChannelMembers(teamChannel, [], [], {
      viewerActorId: "person-art",
      receptionByActorId: {
        "agent-kepler": {
          state: "unavailable",
          routeKind: "none",
          listening: false,
          summary: "No route",
          detail: "No delivery route is registered for this member.",
          evidenceAt: null,
        },
      },
    });
    const kepler = members.find((member) => member.actorIds.includes("agent-kepler"));
    expect(kepler?.connection?.state).toBe("unavailable");
    expect(kepler?.connection?.listening).toBe(false);
    // The activity plane is untouched by the connection plane.
    expect(kepler?.status).not.toBe("unavailable");
  });
});
