import { describe, expect, test } from "bun:test";
import type {
  ChannelInvitePublicView,
  ChannelInviteRoute,
  ConversationDefinition,
} from "@openscout/protocol";

import type { ChannelMemberReception, ChannelMemberView } from "./chat-api.ts";
import {
  buildSpaceTeam,
  type SpaceTeamChannelInput,
} from "./space-team-model.ts";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const NOW = new Date(2026, 8, 16, 14, 0, 0, 0).getTime();

const channel = (
  overrides: Partial<ConversationDefinition> & Pick<ConversationDefinition, "id" | "title">,
): ConversationDefinition => ({
  kind: "channel",
  visibility: "private",
  shareMode: "local",
  authorityNodeId: "node-authority",
  participantIds: [],
  ...overrides,
});

const reception = (
  overrides: Partial<ChannelMemberReception> = {},
): ChannelMemberReception => ({
  state: "ready_to_receive",
  routeKind: "persistent",
  listening: true,
  summary: "Ready to receive",
  detail: "Attached to session ses-1 over a persistent route.",
  evidenceAt: NOW - HOUR,
  attachedSessionId: "ses-1",
  redeemedAt: NOW - 2 * HOUR,
  ...overrides,
});

const member = (
  overrides: Partial<ChannelMemberView> & Pick<ChannelMemberView, "actorId">,
): ChannelMemberView => ({
  kind: "person",
  displayName: overrides.actorId,
  reception: reception(),
  ...overrides,
});

const route = (): ChannelInviteRoute => ({
  authorityNodeId: "node-authority",
  host: "arts-mini.tail1234.ts.net",
  baseUrl: "https://arts-mini.tail1234.ts.net:43120",
  reachability: "mesh",
});

const invite = (
  overrides: Partial<ChannelInvitePublicView> = {},
): ChannelInvitePublicView => ({
  id: "inv-1",
  channelId: "conv-general",
  scope: "channel_participation",
  state: "active",
  createdByActorId: "actor-host",
  tokenHint: "vx3k",
  createdAt: NOW - HOUR,
  expiresAt: NOW + 6 * DAY,
  maxRedemptions: null,
  redemptionCount: 0,
  route: route(),
  redemptions: [],
  ...overrides,
});

const general = channel({ id: "conv-general", title: "general" });
const design = channel({ id: "conv-design", title: "design" });

const input = (
  partial: Partial<SpaceTeamChannelInput> & Pick<SpaceTeamChannelInput, "channel">,
): SpaceTeamChannelInput => ({
  members: [],
  invites: [],
  ...partial,
});

describe("buildSpaceTeam", () => {
  test("a member in two channels is one person holding both channel ids", () => {
    const team = buildSpaceTeam([
      input({ channel: general, members: [member({ actorId: "actor-maya", displayName: "Maya" })] }),
      input({ channel: design, members: [member({ actorId: "actor-maya", displayName: "Maya" })] }),
    ], "actor-me");

    expect(team.people).toHaveLength(1);
    expect(team.people[0]!.member.actorId).toBe("actor-maya");
    expect(team.people[0]!.channelIds).toEqual(["conv-general", "conv-design"]);
  });

  test("a richer reception reading survives the merge", () => {
    const thin = member({
      actorId: "actor-codex",
      kind: "agent",
      displayName: "Codex",
      reception: reception({
        state: "waiting_for_agent",
        routeKind: "none",
        listening: false,
        summary: "",
        detail: "",
        evidenceAt: null,
        attachedSessionId: null,
      }),
    });
    const full = member({ actorId: "actor-codex", kind: "agent", displayName: "Codex" });
    const team = buildSpaceTeam([
      input({ channel: general, members: [full] }),
      input({ channel: design, members: [thin] }),
    ], "actor-me");

    // The thin second read must not erase the live route the first one saw.
    expect(team.unownedAgents[0]!.member.reception.attachedSessionId).toBe("ses-1");
    expect(team.unownedAgents[0]!.member.reception.listening).toBe(true);
  });

  test("agents group under their owner; the ownerless stand alone", () => {
    const codex = member({
      actorId: "actor-codex",
      kind: "agent",
      displayName: "Codex",
      owner: { actorId: "actor-maya", displayName: "Maya" },
    });
    const stray = member({ actorId: "actor-stray", kind: "agent", displayName: "Stray" });
    const team = buildSpaceTeam([
      input({
        channel: general,
        members: [
          member({ actorId: "actor-maya", displayName: "Maya" }),
          codex,
          stray,
        ],
      }),
    ], "actor-me");

    expect(team.people).toHaveLength(1);
    expect(team.people[0]!.agents.map((agent) => agent.member.actorId)).toEqual(["actor-codex"]);
    expect(team.unownedAgents.map((agent) => agent.member.actorId)).toEqual(["actor-stray"]);
  });

  test("an agent owned by somebody not in the space is unowned", () => {
    const orphan = member({
      actorId: "actor-orphan",
      kind: "agent",
      displayName: "Orphan",
      owner: { actorId: "actor-outsider", displayName: "Outsider" },
    });
    const team = buildSpaceTeam([
      input({
        channel: general,
        members: [member({ actorId: "actor-maya", displayName: "Maya" }), orphan],
      }),
    ], "actor-me");

    expect(team.people[0]!.agents).toHaveLength(0);
    expect(team.unownedAgents.map((agent) => agent.member.actorId)).toEqual(["actor-orphan"]);
  });

  test("former members are excluded entirely", () => {
    const team = buildSpaceTeam([
      input({
        channel: general,
        members: [
          member({ actorId: "actor-maya", displayName: "Maya" }),
          member({ actorId: "actor-gone", kind: "unknown", displayName: "Gone" }),
        ],
      }),
    ], "actor-me");

    expect(team.people.map((person) => person.member.actorId)).toEqual(["actor-maya"]);
  });

  test("only active invitations are listed, soonest expiry first, no-expiry last", () => {
    const team = buildSpaceTeam([
      input({
        channel: general,
        invites: [
          invite({ id: "inv-noexpiry", expiresAt: null }),
          invite({ id: "inv-revoked", state: "revoked" }),
          invite({ id: "inv-late", expiresAt: NOW + 6 * DAY }),
          invite({ id: "inv-soon", expiresAt: NOW + HOUR }),
        ],
      }),
      input({
        channel: design,
        invites: [invite({ id: "inv-design", expiresAt: NOW + DAY })],
      }),
    ], "actor-me");

    expect(team.invites.map((entry) => entry.invite.id)).toEqual([
      "inv-soon",
      "inv-design",
      "inv-late",
      "inv-noexpiry",
    ]);
    expect(team.invites[1]!.channel.id).toBe("conv-design");
  });

  test("a failed channel read is reported, not silent", () => {
    const team = buildSpaceTeam([
      input({ channel: general, members: [member({ actorId: "actor-maya" })] }),
      input({
        channel: design,
        members: null,
        invites: null,
        error: "Only members can see this channel's roster",
      }),
    ], "actor-me");

    expect(team.channelErrors).toEqual([
      { channel: design, message: "Only members can see this channel's roster" },
    ]);
    // And the channels that did answer still contribute.
    expect(team.people.map((person) => person.member.actorId)).toEqual(["actor-maya"]);
  });

  test("the viewer sorts first, then everyone else by name", () => {
    const team = buildSpaceTeam([
      input({
        channel: general,
        members: [
          member({ actorId: "actor-zed", displayName: "Zed" }),
          member({ actorId: "actor-me", displayName: "Me" }),
          member({ actorId: "actor-ada", displayName: "Ada" }),
        ],
      }),
    ], "actor-me");

    expect(team.people.map((person) => person.member.actorId)).toEqual([
      "actor-me",
      "actor-ada",
      "actor-zed",
    ]);
  });
});
