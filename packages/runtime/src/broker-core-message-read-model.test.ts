import { describe, expect, test } from "bun:test";

import {
  namedChannelNaturalKey,
  stableChannelId,
  type ConversationDefinition,
  type MessageRecord,
} from "@openscout/protocol";

import {
  isBrokerRequesterWaitTimeoutStatusMessage,
  listBrokerMessages,
} from "./broker-core-message-read-model.js";
import { createRuntimeRegistrySnapshot } from "./registry.js";

function conversation(input: Partial<ConversationDefinition> = {}): ConversationDefinition {
  return {
    id: "conversation-1",
    kind: "direct",
    title: "Direct",
    visibility: "workspace",
    shareMode: "local",
    authorityNodeId: "node-1",
    participantIds: ["operator", "agent-1"],
    metadata: {},
    ...input,
  };
}

function message(input: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id: "msg-1",
    conversationId: "conversation-1",
    actorId: "operator",
    originNodeId: "node-1",
    class: "human",
    body: "hello",
    visibility: "workspace",
    policy: "durable",
    createdAt: 1_000,
    ...input,
  };
}

describe("broker core message read model", () => {
  test("suppresses requester wait timeout status messages", () => {
    const timeout = message({
      id: "timeout",
      class: "status",
      body: "Scout stopped waiting for a synchronous result from agent-1.",
      metadata: { source: "broker" },
    });
    const normalStatus = message({
      id: "normal",
      class: "status",
      body: "Message stored for delivery.",
      metadata: { source: "broker" },
    });

    expect(isBrokerRequesterWaitTimeoutStatusMessage(timeout)).toBe(true);
    expect(isBrokerRequesterWaitTimeoutStatusMessage(normalStatus)).toBe(false);
    expect(listBrokerMessages({
      snapshot: () => createRuntimeRegistrySnapshot({
        conversations: { "conversation-1": conversation() },
        messages: { timeout, normal: normalStatus },
      }),
    }).map((item) => item.id)).toEqual(["normal"]);
  });

  test("returns the newest bounded message window in chronological order", () => {
    const snapshot = createRuntimeRegistrySnapshot({
      conversations: { "conversation-1": conversation() },
      messages: {
        "msg-1": message({ id: "msg-1", createdAt: 1_000 }),
        "msg-2": message({ id: "msg-2", createdAt: 2_000 }),
        "msg-3": message({ id: "msg-3", createdAt: 3_000 }),
      },
    });

    expect(listBrokerMessages({ snapshot: () => snapshot }, { limit: 2 }).map((item) => item.id)).toEqual([
      "msg-2",
      "msg-3",
    ]);
  });

  test("reads structural channel history through the definitive opaque channel id", () => {
    const naturalKey = namedChannelNaturalKey("huddle-v1");
    const canonicalId = stableChannelId(naturalKey);
    const snapshot = createRuntimeRegistrySnapshot({
      conversations: {
        "channel.huddle-v1": conversation({
          id: "channel.huddle-v1",
          kind: "channel",
          title: "huddle-v1",
          metadata: { channel: "huddle-v1" },
        }),
        [canonicalId]: conversation({
          id: canonicalId,
          kind: "channel",
          title: "huddle-v1",
          metadata: { channel: "huddle-v1", naturalKey },
        }),
      },
      messages: {
        legacy: message({ id: "legacy", conversationId: "channel.huddle-v1", createdAt: 1_000 }),
        canonical: message({ id: "canonical", conversationId: canonicalId, createdAt: 2_000 }),
      },
    });

    expect(listBrokerMessages(
      { snapshot: () => snapshot },
      { conversationId: canonicalId },
    ).map((item) => item.id)).toEqual(["legacy", "canonical"]);
  });

  test("filters participant and inbox views by authorship, conversations, and audience", () => {
    const snapshot = createRuntimeRegistrySnapshot({
      conversations: {
        direct: conversation({ id: "direct", kind: "direct", participantIds: ["operator", "agent-1"] }),
        channel: conversation({ id: "channel", kind: "channel", participantIds: ["operator", "agent-1"] }),
        other: conversation({ id: "other", kind: "direct", participantIds: ["operator", "agent-2"] }),
      },
      messages: {
        authored: message({ id: "authored", conversationId: "other", actorId: "agent-1" }),
        direct: message({ id: "direct", conversationId: "direct", actorId: "operator", createdAt: 2_000 }),
        channel: message({ id: "channel", conversationId: "channel", actorId: "operator", createdAt: 3_000 }),
        addressed: message({
          id: "addressed",
          conversationId: "channel",
          actorId: "operator",
          audience: { notify: ["agent-1"] },
          createdAt: 4_000,
        }),
      },
    });
    const runtime = { snapshot: () => snapshot };

    expect(listBrokerMessages(runtime, { participantId: "agent-1" }).map((item) => item.id)).toEqual([
      "authored",
      "direct",
      "channel",
      "addressed",
    ]);
    expect(listBrokerMessages(runtime, { participantId: "agent-1", inboxOnly: true }).map((item) => item.id)).toEqual([
      "direct",
      "addressed",
    ]);
  });
});
