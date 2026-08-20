import { describe, expect, test } from "bun:test";

import {
  namedChannelNaturalKey,
  stableChannelId,
  type ActorIdentity,
  type AgentDefinition,
  type AgentEndpoint,
  type ConversationDefinition,
  type FlightRecord,
  type InvocationRequest,
  type MessageRecord,
} from "@openscout/protocol";

import { createRuntimeRegistrySnapshot } from "./registry.js";
import {
  brokerActorDisplayName,
  brokerConversationChannel,
  brokerRouteKind,
  brokerTargetLabel,
  brokerTargetProjectRoot,
  buildBrokerReturnAddressForActor,
  completedFlightFromBrokerReply,
  findConversationByIdentity,
  isLocalScoutProductTarget,
  isOperatorDeliveryTarget,
  messageAnswersInvocation,
  messageRefCandidateForRouteTarget,
  messageVisibilityForConversation,
  metadataStringValue,
  resolveBrokerMessageRef,
  resolveConversationShareMode,
  scoutbotReplyProvenanceMetadata,
  summarizeHomeAgent,
  titleCaseName,
} from "./broker-conversation-helpers.js";

function actor(input: Partial<ActorIdentity> = {}): ActorIdentity {
  return {
    id: "operator",
    kind: "person",
    displayName: "Operator",
    handle: "operator",
    labels: [],
    metadata: {},
    ...input,
  };
}

function agent(input: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: "agent-1",
    kind: "agent",
    definitionId: "agent-1",
    displayName: "Agent One",
    handle: "agent-one",
    selector: "@agent-one",
    defaultSelector: "@agent-one",
    labels: [],
    metadata: {},
    agentClass: "general",
    capabilities: ["chat"],
    wakePolicy: "manual",
    homeNodeId: "node-local",
    authorityNodeId: "node-local",
    advertiseScope: "local",
    ...input,
  };
}

function endpoint(input: Partial<AgentEndpoint> = {}): AgentEndpoint {
  return {
    id: "endpoint-1",
    agentId: "agent-1",
    nodeId: "node-local",
    harness: "codex",
    transport: "tmux",
    state: "idle",
    sessionId: "session-1",
    projectRoot: "/repo",
    metadata: {},
    ...input,
  };
}

function conversation(input: Partial<ConversationDefinition> = {}): ConversationDefinition {
  return {
    id: "channel.shared",
    kind: "channel",
    title: "shared",
    visibility: "workspace",
    shareMode: "shared",
    authorityNodeId: "node-local",
    participantIds: ["operator", "agent-1"],
    metadata: { channel: "shared", naturalKey: namedChannelNaturalKey("shared") },
    ...input,
  };
}

function message(input: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id: "msg-1",
    conversationId: "conversation-1",
    actorId: "agent-1",
    originNodeId: "node-local",
    class: "agent",
    body: "done",
    visibility: "workspace",
    policy: "durable",
    createdAt: 100,
    ...input,
  };
}

function invocation(input: Partial<InvocationRequest> = {}): InvocationRequest {
  return {
    id: "invocation-1",
    requesterId: "operator",
    requesterNodeId: "node-local",
    targetAgentId: "agent-1",
    action: "consult",
    task: "work",
    ensureAwake: true,
    stream: false,
    conversationId: "conversation-1",
    messageId: "msg-parent",
    createdAt: 90,
    ...input,
  };
}

function flight(input: Partial<FlightRecord> = {}): FlightRecord {
  return {
    id: "flight-1",
    invocationId: "invocation-1",
    targetAgentId: "agent-1",
    state: "working",
    createdAt: 90,
    updatedAt: 90,
    startedAt: 90,
    metadata: { dispatch: "ok" },
    ...input,
  };
}

describe("broker conversation helpers", () => {
  test("formats actor names, channel labels, metadata strings, and target labels", () => {
    const snapshot = createRuntimeRegistrySnapshot({
      actors: {
        operator: actor({ displayName: "Configured Operator" }),
        human: actor({ id: "human", displayName: "Human Sender", handle: "human" }),
      },
      agents: {
        "agent-1": agent(),
      },
      conversations: {
        "channel.shared": conversation(),
        "channel.voice": conversation({ id: "channel.voice", metadata: {} }),
      },
    });

    expect(brokerActorDisplayName(snapshot, "operator", {
      operatorActorId: "operator",
      operatorDisplayName: "Arach",
    })).toBe("Arach");
    expect(brokerActorDisplayName(snapshot, "agent-1")).toBe("Agent One");
    expect(brokerActorDisplayName(snapshot, "human")).toBe("Human Sender");
    expect(brokerActorDisplayName(snapshot, "missing")).toBe("missing");
    expect(brokerConversationChannel(snapshot, "channel.shared")).toBe("shared");
    expect(brokerConversationChannel(snapshot, "channel.voice")).toBeNull();
    expect(titleCaseName("agent_main-worker")).toBe("Agent Main Worker");
    expect(metadataStringValue({ projectRoot: " /repo " }, "projectRoot")).toBe("/repo");
    expect(metadataStringValue({ projectRoot: "   " }, "projectRoot")).toBeNull();
    expect(brokerTargetProjectRoot(agent({ metadata: { projectRoot: "/from-agent" } }), null)).toBe("/from-agent");
    expect(brokerTargetProjectRoot(agent(), endpoint({ projectRoot: "/from-endpoint" }))).toBe("/from-endpoint");
    expect(brokerTargetLabel(agent({ selector: undefined, defaultSelector: undefined, handle: "worker" }))).toBe("@worker");
  });

  test("classifies broker route targets and message refs", () => {
    expect(brokerRouteKind(conversation({ kind: "direct", id: "direct-1" }))).toBe("dm");
    expect(brokerRouteKind(conversation())).toBe("broadcast");
    expect(brokerRouteKind(conversation({ id: "channel.docs", metadata: { channel: "docs" } }))).toBe("channel");
    expect(isLocalScoutProductTarget({ targetLabel: "@Scout" })).toBe(true);
    expect(isLocalScoutProductTarget({ target: { kind: "agent_label", label: "openscout" } })).toBe(true);
    expect(isLocalScoutProductTarget({ target: { kind: "binding_ref", ref: "msg-1" } })).toBe(false);
    expect(isOperatorDeliveryTarget({ targetLabel: "@operator" })).toBe(true);
    expect(isOperatorDeliveryTarget({ target: { kind: "agent_id", agentId: "operator" } })).toBe(true);
    expect(messageRefCandidateForRouteTarget({ targetLabel: "ref: msg-abc.1" })).toBe("msg-abc.1");
    expect(messageRefCandidateForRouteTarget({ target: { kind: "agent_label", label: "@agent" } })).toBeNull();
  });

  test("resolves message refs and conversation identity without ambiguous suffix matches", () => {
    const shared = conversation();
    const snapshot = createRuntimeRegistrySnapshot({
      conversations: { [shared.id]: shared },
      messages: {
        "msg-alpha": message({ id: "msg-alpha" }),
        "prefix-msg-beta": message({ id: "prefix-msg-beta" }),
        "other-msg-beta": message({ id: "other-msg-beta" }),
      },
    });

    expect(resolveBrokerMessageRef(snapshot, "msg-alpha")?.id).toBe("msg-alpha");
    expect(resolveBrokerMessageRef(snapshot, "MSG-ALPHA")?.id).toBe("msg-alpha");
    expect(resolveBrokerMessageRef(snapshot, "msg-beta")).toBeNull();
    expect(findConversationByIdentity(snapshot, namedChannelNaturalKey("shared"))?.id).toBe("channel.shared");
  });

  test("prefers the stable named-channel record over its structural alias", () => {
    const naturalKey = namedChannelNaturalKey("huddle-v1");
    const stableId = stableChannelId(naturalKey);
    const snapshot = createRuntimeRegistrySnapshot({
      conversations: {
        "channel.huddle-v1": conversation({
          id: "channel.huddle-v1",
          title: "huddle-v1",
          metadata: { channel: "huddle-v1" },
        }),
        [stableId]: conversation({
          id: stableId,
          title: "huddle-v1",
          metadata: { channel: "huddle-v1", naturalKey },
        }),
      },
    });

    expect(findConversationByIdentity(snapshot, naturalKey)?.id).toBe(stableId);
  });

  test("detects shared conversation mode when any participant is remote", () => {
    const snapshot = createRuntimeRegistrySnapshot({
      agents: {
        local: agent({ id: "local", authorityNodeId: "node-local" }),
        remote: agent({ id: "remote", authorityNodeId: "node-peer" }),
      },
    });

    expect(resolveConversationShareMode(snapshot, ["local"], "local", "node-local")).toBe("local");
    expect(resolveConversationShareMode(snapshot, ["local", "remote"], "local", "node-local")).toBe("shared");
    expect(resolveConversationShareMode(snapshot, ["local"], "shared", "node-local")).toBe("shared");
  });

  test("builds return addresses from agent, actor, endpoint, and explicit options", () => {
    const snapshot = createRuntimeRegistrySnapshot({
      actors: { "agent-1": actor({ id: "agent-1", handle: "actor-handle" }) },
      agents: {
        "agent-1": agent({
          selector: undefined,
          defaultSelector: undefined,
          metadata: {
            selector: "@from-metadata",
            defaultSelector: "@default-metadata",
          },
        }),
      },
      endpoints: {
        "endpoint-1": endpoint(),
      },
    });

    expect(buildBrokerReturnAddressForActor(snapshot, "agent-1", {
      conversationId: "conversation-1",
      replyToMessageId: "msg-parent",
    })).toEqual(expect.objectContaining({
      actorId: "agent-1",
      handle: "agent-one",
      selector: "@from-metadata",
      defaultSelector: "@default-metadata",
      conversationId: "conversation-1",
      replyToMessageId: "msg-parent",
      nodeId: "node-local",
      projectRoot: "/repo",
      sessionId: "session-1",
    }));
  });

  test("summarizes endpoint state and preserves visibility rules", () => {
    expect(summarizeHomeAgent(null)).toEqual(expect.objectContaining({
      state: "offline",
      reachable: false,
    }));
    expect(summarizeHomeAgent(endpoint({ state: "active" }))).toEqual(expect.objectContaining({
      state: "available",
      reachable: true,
      statusLabel: "Available",
      statusDetail: "codex · tmux",
    }));
    expect(summarizeHomeAgent(endpoint({ state: "active" }), true)).toEqual(expect.objectContaining({
      state: "working",
      reachable: true,
      statusLabel: "Working",
      statusDetail: "codex · tmux",
    }));
    expect(summarizeHomeAgent(endpoint({ state: "idle" }))).toEqual(expect.objectContaining({
      state: "available",
      statusLabel: "Available",
    }));
    expect(messageVisibilityForConversation(conversation({ visibility: "private" }))).toBe("private");
    expect(messageVisibilityForConversation(conversation({ visibility: "workspace" }))).toBe("workspace");
    expect(messageVisibilityForConversation()).toBe("workspace");
  });

  test("derives scoutbot provenance and broker-reply flight completion", () => {
    expect(scoutbotReplyProvenanceMetadata(invocation({
      targetAgentId: "scoutbot",
      metadata: {
        source: "dispatcher",
        requestedBy: "operator",
        sourceMessageId: "msg-source",
      },
    }))).toEqual(expect.objectContaining({
      source: "dispatcher",
      requestedBy: "operator",
      sourceMessageId: "msg-source",
      generatedBy: "scoutbot",
    }));
    expect(scoutbotReplyProvenanceMetadata(invocation({ targetAgentId: "agent-1" }))).toEqual({});

    const reply = message({
      actorId: "agent-1",
      conversationId: "conversation-1",
      replyToMessageId: "msg-parent",
      body: "All done",
      metadata: { source: "broker-reply" },
      createdAt: 120,
    });
    expect(messageAnswersInvocation(reply, invocation())).toBe(true);
    expect(messageAnswersInvocation(reply, invocation({ action: "wake" }))).toBe(false);
    expect(completedFlightFromBrokerReply(invocation(), flight(), reply, "Agent One")).toEqual(expect.objectContaining({
      state: "completed",
      summary: "Agent One replied.",
      output: "All done",
      completedAt: 120,
      metadata: expect.objectContaining({
        dispatch: "ok",
        completedByBrokerReply: true,
        replyMessageId: "msg-1",
        replySource: "broker-reply",
      }),
    }));
  });
});
