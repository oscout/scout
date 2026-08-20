import { describe, expect, test } from "bun:test";

import { planMessageDeliveries, type DeliveryRoute } from "./planner.js";
import type { ConversationDefinition, MessageRecord } from "@openscout/protocol";

const route: DeliveryRoute = {
  targetId: "fabric",
  nodeId: "node-1",
  targetKind: "agent",
  transport: "codex_app_server",
};

const conversation: ConversationDefinition = {
  id: "channel.ops",
  kind: "channel",
  title: "ops",
  visibility: "workspace",
  shareMode: "local",
  authorityNodeId: "node-1",
  participantIds: ["operator", "fabric"],
};

const baseMessage: MessageRecord = {
  id: "msg-1",
  conversationId: "channel.ops",
  actorId: "operator",
  originNodeId: "node-1",
  class: "agent",
  body: "status",
  visibility: "workspace",
  policy: "durable",
  createdAt: 1,
};

describe("planMessageDeliveries", () => {
  test("keeps channel activity notify as durable conversation visibility", () => {
    const deliveries = planMessageDeliveries({
      localNodeId: "node-1",
      message: {
        ...baseMessage,
        audience: {
          notify: ["fabric"],
          reason: "conversation_visibility",
        },
      },
      conversation,
      participantRoutes: [route],
    });

    expect(deliveries).toEqual([
      expect.objectContaining({
        targetId: "fabric",
        reason: "conversation_visibility",
        policy: "durable",
      }),
    ]);
  });

  test("keeps explicit mentions as must-ack mention deliveries", () => {
    const deliveries = planMessageDeliveries({
      localNodeId: "node-1",
      message: {
        ...baseMessage,
        mentions: [{ actorId: "fabric", label: "@fabric" }],
      },
      conversation,
      participantRoutes: [route],
    });

    expect(deliveries).toContainEqual(expect.objectContaining({
      targetId: "fabric",
      reason: "mention",
      policy: "must_ack",
    }));
  });

  test("coalesces direct visibility and notify into one must-ack direct delivery", () => {
    const directConversation: ConversationDefinition = {
      ...conversation,
      id: "dm.operator.fabric",
      kind: "direct",
      visibility: "private",
      participantIds: ["operator", "fabric"],
    };

    const deliveries = planMessageDeliveries({
      localNodeId: "node-1",
      message: {
        ...baseMessage,
        conversationId: directConversation.id,
        visibility: "private",
        audience: {
          notify: ["fabric"],
          reason: "direct_message",
        },
        mentions: [{ actorId: "fabric", label: "@fabric" }],
      },
      conversation: directConversation,
      participantRoutes: [route],
    });

    expect(deliveries).toEqual([
      expect.objectContaining({
        targetId: "fabric",
        reason: "direct_message",
        policy: "must_ack",
      }),
    ]);
  });

  test("keeps store-only direct replies durable without planning a delivery", () => {
    const directConversation: ConversationDefinition = {
      ...conversation,
      id: "dm.operator.fabric",
      kind: "direct",
      visibility: "private",
      participantIds: ["operator", "fabric"],
    };

    const deliveries = planMessageDeliveries({
      localNodeId: "node-1",
      message: {
        ...baseMessage,
        conversationId: directConversation.id,
        actorId: "fabric",
        visibility: "private",
        audience: { delivery: "none" },
      },
      conversation: directConversation,
      participantRoutes: [{ ...route, targetId: "operator" }],
      bindingRoutes: [{ ...route, targetId: "bridge", transport: "webhook" }],
    });

    expect(deliveries).toEqual([]);
  });
});
