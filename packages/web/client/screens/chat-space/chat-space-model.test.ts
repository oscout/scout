import { describe, expect, test } from "bun:test";
import type {
  ChannelInvitePublicView,
  ChannelInviteRoute,
  ConversationDefinition,
  MessageRecord,
} from "@openscout/protocol";

import type { ChannelMemberReception, ChannelMemberView, TrackedRequest } from "./chat-api.ts";
import {
  API_PARTICIPATION_DETAIL,
  API_PARTICIPATION_SUMMARY,
  apiInstructionsUrl,
  askChip,
  askTone,
  bodySegments,
  canRevokeInvite,
  channelHasOwedAttention,
  channelLabel,
  composerHint,
  dayLabel,
  expiryLabel,
  fallbackMember,
  initialsFor,
  inviteCopyBlock,
  inviteKindLabel,
  inviteKindOf,
  inviteLandingView,
  inviteScopeLine,
  isAgentMember,
  isApiParticipant,
  isAskableMember,
  maskedTokenHint,
  memberDisplayName,
  memberOrFallback,
  memberReceptionView,
  memberTrailingFact,
  applyOptimisticReaction,
  newRequestId,
  normalizeAskState,
  mergeChannelRoster,
  peopleAgentLabel,
  projectFeed,
  reachabilityView,
  receptionView,
  relativeTime,
  sortChannels,
  threadReplies,
  threadStubLabel,
  WAKE_ON_DELIVERY_NOTE,
} from "./chat-space-model.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A fixed local wall-clock instant, so day boundaries are deterministic. */
const NOW = new Date(2026, 8, 16, 14, 0, 0, 0).getTime();

const message = (
  overrides: Partial<MessageRecord> & Pick<MessageRecord, "id" | "createdAt">,
): MessageRecord => ({
  conversationId: "conv-chat",
  actorId: "actor-maya",
  originNodeId: "node-authority",
  class: "agent",
  body: "hello",
  visibility: "workspace",
  policy: "best_effort",
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
  evidenceAt: null,
  attachedSessionId: "ses-1",
  redeemedAt: NOW - HOUR,
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

const route = (overrides: Partial<ChannelInviteRoute> = {}): ChannelInviteRoute => ({
  authorityNodeId: "node-authority",
  host: "arts-mini.tail1234.ts.net",
  baseUrl: "https://arts-mini.tail1234.ts.net:43120",
  reachability: "mesh",
  ...overrides,
});

const invite = (
  overrides: Partial<ChannelInvitePublicView> = {},
): ChannelInvitePublicView => ({
  id: "inv-1",
  channelId: "conv-chat",
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

const trackedRequest = (overrides: Partial<TrackedRequest> = {}): TrackedRequest => ({
  messageId: "msg-ask",
  flightId: "flight-1",
  state: "running",
  targetActorId: "actor-codex",
  ...overrides,
});

describe("time", () => {
  test("relative time degrades by unit", () => {
    expect(relativeTime(NOW - 10_000, NOW)).toBe("just now");
    expect(relativeTime(NOW - 5 * MINUTE, NOW)).toBe("5m ago");
    expect(relativeTime(NOW - 3 * HOUR, NOW)).toBe("3h ago");
    expect(relativeTime(NOW - 2 * DAY, NOW)).toBe("2d ago");
    // A clock skew from the server never renders as a negative age.
    expect(relativeTime(NOW + 5 * MINUTE, NOW)).toBe("just now");
  });

  test("day labels name today and yesterday", () => {
    expect(dayLabel(NOW - HOUR, NOW)).toBe("Today");
    expect(dayLabel(NOW - DAY, NOW)).toBe("Yesterday");
    expect(dayLabel(NOW - 5 * DAY, NOW)).not.toBe("Today");
  });

  test("an absent expiry is said out loud, not left blank", () => {
    expect(expiryLabel(null, NOW)).toBe("no expiry");
    expect(expiryLabel(NOW - MINUTE, NOW)).toBe("expired");
    expect(expiryLabel(NOW + 30 * MINUTE, NOW)).toBe("expires in 30 minutes");
    expect(expiryLabel(NOW + HOUR, NOW)).toBe("expires in 1 hour");
    expect(expiryLabel(NOW + 6 * DAY, NOW)).toBe("expires in 6 days");
  });
});

describe("identity", () => {
  test("channel labels carry exactly one hash", () => {
    expect(channelLabel("design")).toBe("#design");
    expect(channelLabel("#design")).toBe("#design");
    expect(channelLabel("  design  ")).toBe("#design");
  });

  test("coin initials never exceed two characters", () => {
    expect(initialsFor("Maya Chen")).toBe("MC");
    expect(initialsFor("codex")).toBe("CO");
    expect(initialsFor("Maya Chen Lee")).toBe("MC");
    expect(initialsFor("   ")).toBe("?");
  });

  test("an agent renders possessively, and never doubles an owner already in the name", () => {
    const owned = member({
      actorId: "actor-codex",
      kind: "agent",
      displayName: "Codex",
      owner: { actorId: "actor-maya", displayName: "Maya" },
    });
    expect(memberDisplayName(owned)).toBe("Maya's Codex");

    const preNamed = member({
      ...owned,
      displayName: "Maya's Codex",
    });
    expect(memberDisplayName(preNamed)).toBe("Maya's Codex");

    expect(memberDisplayName(member({ actorId: "actor-maya", displayName: "Maya" }))).toBe("Maya");
  });

  test("the facepile counts people and agents, never 'members'", () => {
    const members = [
      member({ actorId: "actor-maya", displayName: "Maya" }),
      member({ actorId: "actor-sam", displayName: "Sam" }),
      member({
        actorId: "actor-codex",
        kind: "agent",
        displayName: "Codex",
        owner: { actorId: "actor-maya", displayName: "Maya" },
      }),
    ];
    expect(peopleAgentLabel(members)).toBe("2 people · 1 agent");
    expect(peopleAgentLabel([members[0]!])).toBe("1 person · 0 agents");
  });

  test("a thin roster poll does not erase agents already in the room", () => {
    const maya = member({ actorId: "actor-maya", displayName: "Maya" });
    const arc = member({
      actorId: "arc.master.arts-mini",
      kind: "agent",
      displayName: "Arc",
      owner: { actorId: "actor-maya", displayName: "Maya" },
    });
    const merged = mergeChannelRoster([maya, arc], [
      { ...maya, kind: "unknown" as const },
    ]);
    expect(merged.map((item) => item.actorId)).toEqual(["actor-maya", "arc.master.arts-mini"]);
    expect(merged[1]?.kind).toBe("agent");
    expect(peopleAgentLabel(merged)).toBe("1 person · 1 agent");
  });

  test("a later one-person poll cannot snatch a four-person room", () => {
    const maya = member({ actorId: "actor-maya", displayName: "Maya" });
    const arc = member({
      actorId: "arc.master.arts-mini",
      kind: "agent",
      displayName: "Arc",
      owner: { actorId: "actor-maya", displayName: "Maya" },
    });
    const host = member({
      actorId: "arc-host.master.arts-mini",
      kind: "agent",
      displayName: "Arc Host",
    });
    const author = member({
      actorId: "arc-author.master.arts-mini",
      kind: "agent",
      displayName: "Arc Author",
    });
    const once = mergeChannelRoster([maya, arc, host, author], [maya]);
    expect(once.map((item) => item.actorId)).toEqual([
      "actor-maya",
      "arc.master.arts-mini",
      "arc-host.master.arts-mini",
      "arc-author.master.arts-mini",
    ]);
    expect(peopleAgentLabel(once)).toBe("1 person · 3 agents");
  });
});

describe("the connection plane", () => {
  test("one trailing fact per row, in precedence order", () => {
    const viewer = "actor-maya";
    expect(memberTrailingFact(member({ actorId: viewer, displayName: "Maya" }), viewer)).toBe("you");

    // A person carries no connection plane: it would read as a claim about them.
    expect(memberTrailingFact(member({ actorId: "actor-sam", displayName: "Sam" }), viewer)).toBeNull();

    const agent = member({
      actorId: "actor-codex",
      kind: "agent",
      displayName: "Codex",
      owner: { actorId: viewer, displayName: "Maya" },
    });
    // Idle and connected is absence, not a chip.
    expect(memberTrailingFact(agent, viewer)).toBeNull();

    expect(
      memberTrailingFact({ ...agent, activity: { status: "running" } }, viewer),
    ).toBe("working");
    expect(
      memberTrailingFact({ ...agent, activity: { status: "queued" } }, viewer),
    ).toBe("waiting");

    // Activity wins over a non-nominal reception; reception shows when quiet.
    const unavailable = reception({
      state: "unavailable",
      routeKind: "none",
      listening: false,
      summary: "Unavailable",
    });
    expect(
      memberTrailingFact({ ...agent, activity: { status: "running" }, reception: unavailable }, viewer),
    ).toBe("working");
    expect(memberTrailingFact({ ...agent, reception: unavailable }, viewer)).toBe("unavailable");
  });

  test("only a live attached route earns the dot", () => {
    const ready = receptionView(reception({ evidenceAt: NOW - 2 * MINUTE }), NOW);
    expect(ready?.showDot).toBe(true);
    expect(ready?.summary).toBe("Ready to receive");
    expect(ready?.detail).toBe("Attached to session ses-1 over a persistent route.");
    expect(ready?.evidence).toBe("confirmed 2m ago");
    expect(ready?.routeNote).toBeNull();

    // Transport-shaped optimism: a route kind alone never lights the dot.
    const notListening = receptionView(reception({ listening: false }), NOW);
    expect(notListening?.showDot).toBe(false);

    const wake = receptionView(
      reception({
        routeKind: "wake_on_delivery",
        listening: false,
        state: "ready_to_receive",
        summary: "Ready to receive",
      }),
      NOW,
    );
    expect(wake?.showDot).toBe(false);
    expect(wake?.routeNote).toBe(WAKE_ON_DELIVERY_NOTE);

    expect(receptionView(null, NOW)).toBeNull();
  });
});

describe("API participants", () => {
  /** Roster shape for a member minted by POST /api/invites/:token/participate. */
  const apiMember = (overrides: Partial<ChannelMemberView> = {}): ChannelMemberView =>
    member({
      actorId: "apia-3f2a9c",
      kind: "agent",
      displayName: "curl-bot",
      participation: "api",
      reception: reception({
        state: "waiting_for_agent",
        routeKind: "none",
        listening: false,
        summary: "Waiting for agent",
        detail: "This member has joined the channel but no agent session has redeemed the invitation yet.",
        attachedSessionId: null,
      }),
      ...overrides,
    });

  test("participation is declared by the roster, never inferred", () => {
    expect(isApiParticipant(apiMember())).toBe(true);
    // An agent with no session today is not an API participant.
    expect(isApiParticipant(member({ actorId: "actor-codex", kind: "agent" }))).toBe(false);
    expect(isApiParticipant(member({ actorId: "actor-codex", kind: "agent", participation: "session" }))).toBe(false);
  });

  test("an API participant is an agent but never an ask target", () => {
    expect(isAgentMember(apiMember())).toBe(true);
    expect(isAskableMember(apiMember())).toBe(false);
    expect(isAskableMember(member({ actorId: "actor-codex", kind: "agent" }))).toBe(true);
    expect(isAskableMember(member({ actorId: "actor-maya", displayName: "Maya" }))).toBe(false);
  });

  test("the roster fact names the mode, not a missing session", () => {
    expect(memberTrailingFact(apiMember(), "actor-maya")).toBe("via API");
    // Self still wins the single trailing fact.
    expect(memberTrailingFact(apiMember(), "apia-3f2a9c")).toBe("you");
  });

  test("the member card explains polling and claims no freshness", () => {
    const view = memberReceptionView(apiMember(), NOW);
    expect(view?.summary).toBe(API_PARTICIPATION_SUMMARY);
    expect(view?.detail).toBe(API_PARTICIPATION_DETAIL);
    expect(view?.detail).toContain("cannot be sent a tracked ask");
    // No dot and no evidence line: the server keeps no last-poll record, so
    // the card must not imply background availability or freshness.
    expect(view?.showDot).toBe(false);
    expect(view?.evidence).toBeNull();

    // Everyone else keeps the protocol's own reading, verbatim.
    const attached = member({ actorId: "actor-codex", kind: "agent" });
    expect(memberReceptionView(attached, NOW)?.summary).toBe("Ready to receive");
  });
});

describe("tracked asks", () => {
  test("delivery layering collapses into lifecycle words", () => {
    expect(normalizeAskState("accepted")).toBe("queued");
    expect(normalizeAskState("delivered")).toBe("queued");
    expect(normalizeAskState("canceled")).toBe("cancelled");
    expect(normalizeAskState(" RUNNING ")).toBe("running");
    expect(askTone("running")).toBe("owed");
    expect(askTone("completed")).toBe("settled");
    expect(askTone("cancelled")).toBe("settled");
    expect(askTone("failed")).toBe("failed");
    // An unknown broker state is still owed, and is never relabelled.
    expect(askTone("reticulating")).toBe("owed");
  });

  test("the chip names the target and the state", () => {
    const chip = askChip(trackedRequest(), { label: "Maya's Codex", reception: reception() });
    expect(chip.textWithTarget).toBe("▸ Maya's Codex · working");
    expect(chip.text).toBe("▸ working");
    expect(chip.tone).toBe("owed");
    expect(chip.canStop).toBe(true);
  });

  test("a wake_on_delivery route keeps its lifecycle word", () => {
    const chip = askChip(trackedRequest({ state: "accepted" }), {
      label: "Maya's Codex",
      reception: reception({ routeKind: "wake_on_delivery", listening: false }),
    });
    expect(chip.state).toBe("queued");
    expect(chip.textWithTarget).toBe("▸ Maya's Codex · working");
  });

  test("an owed ask at an unreachable member explains itself", () => {
    const stranded = askChip(trackedRequest(), {
      label: "Maya's Codex",
      reception: reception({ routeKind: "none", listening: false, state: "unavailable" }),
    });
    expect(stranded.text).toBe("blocked — Maya's Codex isn't listening right now");
    expect(stranded.textWithTarget).toBe(stranded.text);

    const disconnected = askChip(trackedRequest(), {
      label: "Maya's Codex",
      reception: reception({ state: "disconnected", listening: false }),
    });
    expect(disconnected.text).toContain("isn't listening right now");

    // A settled ask never gains the explanation: nothing is owed.
    const done = askChip(trackedRequest({ state: "completed" }), {
      label: "Maya's Codex",
      reception: reception({ routeKind: "none", listening: false, state: "unavailable" }),
    });
    expect(done.text).toBe("▸ completed");
  });

  test("an unknown target falls back to the actor id, never to a guess", () => {
    const chip = askChip(trackedRequest({ targetActorId: "actor-ghost" }), null);
    expect(chip.textWithTarget).toBe("▸ actor-ghost · working");
  });
});

describe("feed projection", () => {
  const yesterday = NOW - DAY;

  test("roots render in the channel and replies only count", () => {
    const projection = projectFeed({
      messages: [
        message({ id: "m1", createdAt: yesterday, body: "first" }),
        message({ id: "m2", createdAt: NOW - 2 * HOUR, body: "second" }),
        message({ id: "r1", createdAt: NOW - HOUR, body: "reply", replyToMessageId: "m2" }),
        message({ id: "r2", createdAt: NOW - 30 * MINUTE, body: "reply 2", replyToMessageId: "m2" }),
      ],
      requests: [trackedRequest({ messageId: "m2" })],
      nowMs: NOW,
    });

    const kinds = projection.entries.map((entry) => entry.kind);
    expect(kinds).toEqual(["day", "turn", "day", "turn"]);

    const turns = projection.entries.filter((entry) => entry.kind === "turn");
    expect(turns.map((entry) => entry.id)).toEqual(["m1", "m2"]);

    const second = turns[1]!;
    if (second.kind !== "turn") throw new Error("expected a turn");
    expect(second.replyCount).toBe(2);
    expect(second.lastReplyAt).toBe(NOW - 30 * MINUTE);
    expect(second.request?.flightId).toBe("flight-1");

    expect(threadReplies(projection, "m2").map((reply) => reply.id)).toEqual(["r1", "r2"]);
    expect(threadReplies(projection, "m1")).toEqual([]);
    expect(projection.lastMessageAt).toBe(NOW - 30 * MINUTE);
  });

  test("a long run of notices folds, keeping the tail visible", () => {
    const joins = [0, 1, 2, 3, 4].map((index) =>
      message({
        id: `s${index}`,
        createdAt: NOW - (10 - index) * MINUTE,
        class: "status",
        body: `${index} joined`,
      }),
    );
    const projection = projectFeed({
      messages: [...joins, message({ id: "m1", createdAt: NOW - MINUTE })],
      requests: [],
      nowMs: NOW,
    });

    const fold = projection.entries.find((entry) => entry.kind === "status-fold");
    if (!fold || fold.kind !== "status-fold") throw new Error("expected a fold");
    expect(fold.count).toBe(3);
    expect(fold.label).toBe("3 earlier notices");
    expect(fold.messages.map((entry) => entry.id)).toEqual(["s0", "s1", "s2"]);

    const visibleStatuses = projection.entries.filter((entry) => entry.kind === "status");
    expect(visibleStatuses.map((entry) => entry.id)).toEqual(["s3", "s4"]);
  });

  test("a short run of notices stays expanded", () => {
    const projection = projectFeed({
      messages: [0, 1, 2].map((index) =>
        message({ id: `s${index}`, createdAt: NOW - (5 - index) * MINUTE, class: "system" }),
      ),
      requests: [],
      nowMs: NOW,
    });
    expect(projection.entries.filter((entry) => entry.kind === "status-fold")).toEqual([]);
    expect(projection.entries.filter((entry) => entry.kind === "status")).toHaveLength(3);
  });

  test("thread stubs count and date themselves", () => {
    expect(threadStubLabel(1, null, NOW)).toBe("1 reply");
    expect(threadStubLabel(2, NOW - 3 * MINUTE, NOW)).toBe("2 replies · last 3m ago");
  });

  test("attention is owed asks at my agents and mentions of me", () => {
    const members = [
      member({ actorId: "actor-maya", displayName: "Maya" }),
      member({
        actorId: "actor-codex",
        kind: "agent",
        displayName: "Codex",
        owner: { actorId: "actor-maya", displayName: "Maya" },
      }),
      member({
        actorId: "actor-other",
        kind: "agent",
        displayName: "Claude",
        owner: { actorId: "actor-sam", displayName: "Sam" },
      }),
    ];
    const base = {
      messages: [message({ id: "m1", createdAt: NOW - MINUTE })],
      nowMs: NOW,
    };

    expect(
      channelHasOwedAttention({
        projection: projectFeed({ ...base, requests: [trackedRequest({ messageId: "m1" })] }),
        viewerActorId: "actor-maya",
        members,
      }),
    ).toBe(true);

    expect(
      channelHasOwedAttention({
        projection: projectFeed({
          ...base,
          requests: [trackedRequest({ messageId: "m1", state: "completed" })],
        }),
        viewerActorId: "actor-maya",
        members,
      }),
    ).toBe(false);

    // Somebody else's agent being busy is not my attention.
    expect(
      channelHasOwedAttention({
        projection: projectFeed({
          ...base,
          requests: [trackedRequest({ messageId: "m1", targetActorId: "actor-other" })],
        }),
        viewerActorId: "actor-maya",
        members,
      }),
    ).toBe(false);

    expect(
      channelHasOwedAttention({
        projection: projectFeed({
          messages: [
            message({
              id: "m1",
              createdAt: NOW - MINUTE,
              mentions: [{ actorId: "actor-maya", label: "Maya" }],
            }),
          ],
          requests: [],
          nowMs: NOW,
        }),
        viewerActorId: "actor-maya",
        members,
      }),
    ).toBe(true);
  });
});

describe("mentions", () => {
  test("only a structured mention is highlighted", () => {
    const segments = bodySegments(
      message({
        id: "m1",
        createdAt: NOW,
        body: "@Maya's Codex can you check @nobody about this?",
        mentions: [{ actorId: "actor-codex", label: "Maya's Codex" }],
      }),
    );
    expect(segments).toEqual([
      { kind: "mention", text: "@Maya's Codex" },
      { kind: "text", text: " can you check @nobody about this?" },
    ]);
  });

  test("a body with no mentions is one text run", () => {
    expect(bodySegments(message({ id: "m1", createdAt: NOW, body: "just talking" }))).toEqual([
      { kind: "text", text: "just talking" },
    ]);
  });

  test("the composer states the boundary between a post and a request", () => {
    expect(composerHint(null)).toBeNull();
    expect(composerHint("Maya's Codex")).toBe(
      "Creates a tracked request for Maya's Codex · reply lands in this thread",
    );
  });
});

describe("invitations", () => {
  test("single-redemption invitations split on invitee binding", () => {
    // An agent invitation carries its issuer as invitee; a no-install
    // invitation carries nobody, because the server mints the identity.
    expect(inviteKindOf(invite({ maxRedemptions: 1, invitee: { displayName: "Maya" } }))).toBe("agent");
    expect(inviteKindOf(invite({ maxRedemptions: 1 }))).toBe("api");
    expect(inviteKindOf(invite({ maxRedemptions: null }))).toBe("teammate");
    expect(inviteKindOf(invite({ maxRedemptions: 5 }))).toBe("teammate");

    expect(inviteKindLabel("api")).toBe("no-install agent");
    expect(inviteKindLabel("agent")).toBe("agent");
    expect(inviteKindLabel("teammate")).toBe("teammate");
  });

  test("the roster never shows more of a token than the hint", () => {
    expect(maskedTokenHint("vx3k")).toBe("vx3k-····");
    expect(maskedTokenHint("vx3k-7f2a")).toBe("vx3k-····");
    expect(maskedTokenHint("  ")).toBe("····");
  });

  test("copy blocks differ by who is reading them", () => {
    const shared = {
      channelTitle: "design",
      channelTopic: "Chat invites",
      inviterName: "Maya",
      inviteUrl: "https://host/invite/tok",
      agentInstructionsUrl: "https://host/invite/tok/agent.md",
    };
    expect(inviteCopyBlock({ ...shared, kind: "teammate" })).toBe(
      [
        "You're invited to #design on Scout Chat.",
        "From Maya · Chat invites.",
        "Open: https://host/invite/tok",
      ].join("\n"),
    );
    const agentCopy = inviteCopyBlock({ ...shared, kind: "agent" });
    expect(agentCopy).toContain('scout chat join "https://host/invite/tok/agent.md"');
    expect(agentCopy).not.toContain("Read https://");
    expect(agentCopy).toContain("Use this running agent to read and reply over HTTP; no local Scout service is required.");

    // The no-install block points at the api.md document the server serves
    // beside agent.md, and promises nothing about sessions or wake-up.
    const apiCopy = inviteCopyBlock({ ...shared, kind: "api" });
    expect(apiCopy).toContain("https://host/invite/tok/api.md");
    expect(apiCopy).toContain("nothing to install");
    expect(apiCopy).not.toContain("session");
  });

  test("the api.md URL is derived exactly as the server serves it", () => {
    expect(apiInstructionsUrl("https://host/invite/tok")).toBe("https://host/invite/tok/api.md");
    expect(apiInstructionsUrl("https://host/invite/tok/")).toBe("https://host/invite/tok/api.md");
  });

  test("revoke is offered only where the server would honour it", () => {
    const operator = { actorId: "actor-host", isOperator: true };
    const maya = { actorId: "actor-maya", isOperator: false };

    // The host's invitation: the host may revoke it, a member may not.
    const hostInvite = invite();
    expect(canRevokeInvite(hostInvite, operator)).toBe(true);
    expect(canRevokeInvite(hostInvite, maya)).toBe(false);

    // Authorship is the creator, not the recipient: an invitation *for* Maya
    // that Maya did not create is not hers to revoke.
    const inviteForMaya = invite({ invitee: { displayName: "Maya", actorId: "actor-maya" } });
    expect(canRevokeInvite(inviteForMaya, maya)).toBe(false);

    const mayasInvite = invite({ createdByActorId: "actor-maya" });
    expect(canRevokeInvite(mayasInvite, maya)).toBe(true);
    expect(canRevokeInvite(mayasInvite, { actorId: "actor-sam", isOperator: false })).toBe(false);

    // Nothing is revocable twice.
    expect(canRevokeInvite(invite({ state: "revoked" }), operator)).toBe(false);
    expect(canRevokeInvite(invite({ state: "expired" }), operator)).toBe(false);
  });

  test("the scope line says what the invitation admits", () => {
    expect(inviteScopeLine("agent", "Maya")).toBe("single use · joins as Maya's");
    expect(inviteScopeLine("api", "Maya")).toBe("single use · joins over HTTP");
    expect(inviteScopeLine("teammate", "Maya")).toBe("multi-use until it expires or is revoked");
  });
});

describe("reachability", () => {
  test("the server's own note is rendered verbatim", () => {
    const view = reachabilityView(route({ reachability: "lan", caveat: "Same network only." }), {
      reachability: "lan",
      label: "On this network",
      detail: "Teammates must be on this network to open the link.",
      remoteUsable: false,
    });
    expect(view.state).toBe("On this network");
    expect(view.line).toBe("Teammates must be on this network to open the link.");
    expect(view.caveat).toBe("Same network only.");
    expect(view.showDot).toBe(false);
    expect(view.remoteUsable).toBe(false);
  });

  test("a caveat that repeats the note is not printed twice", () => {
    const view = reachabilityView(route({ reachability: "lan", caveat: "Same network only." }), {
      reachability: "lan",
      label: "On this network",
      detail: "Same network only.",
      remoteUsable: false,
    });
    expect(view.caveat).toBeNull();
  });

  test("without a note, every route kind still gets an honest line", () => {
    expect(reachabilityView(route({ reachability: "mesh" })).remoteUsable).toBe(true);
    expect(reachabilityView(route({ reachability: "mesh" })).showDot).toBe(true);
    expect(reachabilityView(route({ reachability: "lan" })).remoteUsable).toBe(false);

    const localOnly = reachabilityView(route({ reachability: "local_only" }));
    expect(localOnly.state).toBe("This machine only");
    expect(localOnly.showDot).toBe(false);

    const unknown = reachabilityView(route({ reachability: "unknown" }));
    expect(unknown.state).toBe("Reachability unconfirmed");
    expect(unknown.remoteUsable).toBe(false);

    // An unrecognized reachability is treated as unverified, never as reachable.
    const bogus = reachabilityView({ ...route(), reachability: "teleport" as never });
    expect(bogus.remoteUsable).toBe(false);
  });
});

describe("the invitation landing page", () => {
  const base = {
    channelTitle: "design",
    inviterName: "Maya",
    alreadyMember: false,
    nowMs: NOW,
  };

  test("a live invitation offers to join", () => {
    const view = inviteLandingView({ ...base, invite: invite() });
    if (view.mode !== "join") throw new Error("expected join");
    expect(view.cta).toBe("Join #design");
    expect(view.note).toContain("admits you to this channel only");
    expect(view.note).toContain("It expires");
  });

  test("a member who returns is offered the room, not a second join", () => {
    const view = inviteLandingView({ ...base, alreadyMember: true, invite: invite() });
    if (view.mode !== "open") throw new Error("expected open");
    expect(view.cta).toBe("Open #design");
  });

  test("an invitation with no expiry says so", () => {
    const view = inviteLandingView({ ...base, invite: invite({ expiresAt: null }) });
    if (view.mode !== "join") throw new Error("expected join");
    expect(view.note).toContain("It does not expire.");
  });

  test("closed invitations name the recovery path", () => {
    const expired = inviteLandingView({
      ...base,
      invite: invite({ state: "expired", expiresAt: NOW - DAY }),
    });
    expect(expired.mode).toBe("closed");
    if (expired.mode !== "closed") throw new Error("expected closed");
    expect(expired.message).toContain("Ask Maya for a new one.");

    const anonymous = inviteLandingView({
      ...base,
      inviterName: null,
      invite: invite({ state: "exhausted" }),
    });
    if (anonymous.mode !== "closed") throw new Error("expected closed");
    expect(anonymous.message).toContain("already been used");
    expect(anonymous.message).toContain("Ask the person who invited you for a new one.");

    const revoked = inviteLandingView({ ...base, invite: invite({ state: "revoked" }) });
    if (revoked.mode !== "closed") throw new Error("expected closed");
    expect(revoked.message).toBe("This invitation was revoked.");
  });
});

describe("channels and fallbacks", () => {
  const conversation = (id: string, title: string): ConversationDefinition => ({
    id,
    kind: "channel",
    title,
    visibility: "workspace",
    shareMode: "shared",
    authorityNodeId: "node-authority",
    participantIds: [],
  });

  test("channels sort case-insensitively by title", () => {
    const sorted = sortChannels([
      conversation("c1", "release"),
      conversation("c2", "Design"),
      conversation("c3", "agents"),
    ]);
    expect(sorted.map((entry) => entry.title)).toEqual(["agents", "Design", "release"]);
  });

  test("a message from a departed member still renders, claiming nothing", () => {
    const ghost = fallbackMember("actor-ghost");
    expect(ghost.displayName).toBe("actor-ghost");
    expect(ghost.kind).toBe("unknown");
    expect(ghost.reception.listening).toBe(false);
    expect(ghost.reception.routeKind).toBe("none");
    expect(ghost.reception.attachedSessionId).toBeNull();
    // It is never counted as an agent, so no agent row is invented for it.
    expect(peopleAgentLabel([ghost])).toBe("1 person · 0 agents");

    const roster = new Map([["actor-maya", member({ actorId: "actor-maya", displayName: "Maya" })]]);
    expect(memberOrFallback(roster, "actor-maya").displayName).toBe("Maya");
    expect(memberOrFallback(roster, "actor-ghost").actorId).toBe("actor-ghost");
  });

  test("request ids are unique per logical send", () => {
    const first = newRequestId();
    expect(first.startsWith("req-")).toBe(true);
    expect(first).not.toBe(newRequestId());
  });

  test("optimistic reactions add, fill me, and remove without reshuffling others", () => {
    const added = applyOptimisticReaction([], "👍", false);
    expect(added).toEqual([{ emoji: "👍", count: 1, me: true }]);
    const second = applyOptimisticReaction([{ emoji: "👍", count: 1, me: false }], "👍", false);
    expect(second).toEqual([{ emoji: "👍", count: 2, me: true }]);
    const removed = applyOptimisticReaction(
      [{ emoji: "👍", count: 2, me: true }, { emoji: "🎉", count: 1, me: false }],
      "👍",
      true,
    );
    expect(removed).toEqual([{ emoji: "👍", count: 1, me: false }, { emoji: "🎉", count: 1, me: false }]);
  });
});
