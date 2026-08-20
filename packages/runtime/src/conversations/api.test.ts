import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CHAT_ID_PREFIX,
  directChannelNaturalKey,
  namedChannelNaturalKey,
  stableChannelId,
  type ConversationDefinition,
} from "@openscout/protocol";

import { SQLiteControlPlaneStore } from "../sqlite-store.ts";

const dbRoots = new Set<string>();

afterEach(() => {
  for (const root of dbRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  dbRoots.clear();
});

function createStore(): SQLiteControlPlaneStore {
  const root = mkdtempSync(join(tmpdir(), "openscout-conversations-repo-"));
  dbRoots.add(root);
  return new SQLiteControlPlaneStore(join(root, "control-plane.sqlite"));
}

function seedActorsAndNode(store: SQLiteControlPlaneStore, actorIds: string[]): void {
  store.upsertNode({
    id: "node-1",
    meshId: "mesh-1",
    name: "Test node",
    advertiseScope: "local",
    registeredAt: Date.now(),
  });
  for (const actorId of actorIds) {
    const isOperator = actorId === "operator";
    store.upsertActor({
      id: actorId,
      kind: isOperator ? "person" : "agent",
      displayName: isOperator ? "Operator" : actorId,
    });
    if (!isOperator) {
      store.upsertAgent({
        id: actorId,
        kind: "agent",
        definitionId: actorId,
        displayName: actorId,
        agentClass: "general",
        capabilities: ["chat"],
        wakePolicy: "on_demand",
        homeNodeId: "node-1",
        authorityNodeId: "node-1",
        advertiseScope: "local",
      });
    }
  }
}

function makeConversation(overrides: Partial<ConversationDefinition> = {}): ConversationDefinition {
  return {
    id: "conv-1",
    kind: "direct",
    title: "Direct",
    visibility: "private",
    shareMode: "local",
    authorityNodeId: "node-1",
    participantIds: ["operator", "agent-1"],
    ...overrides,
  };
}

describe("Conversations", () => {
  test("exposes a singleton via store.conversations", () => {
    const store = createStore();
    try {
      const first = store.conversations;
      const second = store.conversations;
      expect(first).toBe(second);
    } finally {
      store.close();
    }
  });

  test("findById returns the canonical ConversationDefinition", () => {
    const store = createStore();
    try {
      seedActorsAndNode(store, ["operator", "agent-1"]);
      const conversation = makeConversation();
      store.conversations.upsert(conversation);

      const loaded = store.conversations.findById("conv-1");
      expect(loaded).not.toBeNull();
      expect(loaded?.id).toBe("conv-1");
      expect(loaded?.kind).toBe("direct");
      expect(loaded?.participantIds.sort()).toEqual(["agent-1", "operator"]);
    } finally {
      store.close();
    }
  });

  test("findById returns null for an unknown id", () => {
    const store = createStore();
    try {
      expect(store.conversations.findById("missing")).toBeNull();
    } finally {
      store.close();
    }
  });

  test("findByNaturalKey returns null when no metadata natural key exists", () => {
    const store = createStore();
    try {
      seedActorsAndNode(store, ["operator", "agent-1"]);
      store.conversations.upsert(makeConversation());
      expect(store.conversations.findByNaturalKey("dm.operator.agent-1")).toBeNull();
    } finally {
      store.close();
    }
  });

  test("findByAgent resolves opaque operator↔agent direct conversations by natural key", () => {
    const store = createStore();
    try {
      seedActorsAndNode(store, ["operator", "agent-1"]);
      const naturalKey = directChannelNaturalKey(["operator", "agent-1"]);
      const created = store.conversations.ensureByNaturalKey({
        naturalKey,
        kind: "direct",
        title: "Direct",
        visibility: "private",
        shareMode: "local",
        authorityNodeId: "node-1",
        participantIds: ["operator", "agent-1"],
      });

      const found = store.conversations.findByAgent("agent-1");
      expect(found?.id).toBe(created.id);
      expect(found?.kind).toBe("direct");
    } finally {
      store.close();
    }
  });

  test("findByAgent returns null when no canonical conversation exists", () => {
    const store = createStore();
    try {
      expect(store.conversations.findByAgent("nobody")).toBeNull();
    } finally {
      store.close();
    }
  });

  test("findByParent returns child conversations", () => {
    const store = createStore();
    try {
      seedActorsAndNode(store, ["operator", "agent-1"]);
      store.conversations.upsert(makeConversation({ id: "parent-1", kind: "channel" }));
      store.conversations.upsert(makeConversation({ id: "parent-other", kind: "channel" }));
      store.conversations.upsert(makeConversation({
        id: "thread-1",
        kind: "thread",
        parentConversationId: "parent-1",
      }));
      store.conversations.upsert(makeConversation({
        id: "thread-2",
        kind: "thread",
        parentConversationId: "parent-1",
      }));
      store.conversations.upsert(makeConversation({
        id: "thread-other",
        kind: "thread",
        parentConversationId: "parent-other",
      }));

      const children = store.conversations.findByParent("parent-1");
      const childIds = children.map((c) => c.id).sort();
      expect(childIds).toEqual(["thread-1", "thread-2"]);
    } finally {
      store.close();
    }
  });

  test("findByParticipants matches exact-membership conversations", () => {
    const store = createStore();
    try {
      seedActorsAndNode(store, ["operator", "agent-1", "agent-2"]);

      store.conversations.upsert(makeConversation({
        id: "dm-op-agent1",
        participantIds: ["operator", "agent-1"],
      }));
      store.conversations.upsert(makeConversation({
        id: "dm-op-agent2",
        participantIds: ["operator", "agent-2"],
      }));
      store.conversations.upsert(makeConversation({
        id: "group",
        kind: "group_direct",
        participantIds: ["operator", "agent-1", "agent-2"],
      }));

      const dm = store.conversations.findByParticipants(["operator", "agent-1"]);
      expect(dm?.id).toBe("dm-op-agent1");

      const group = store.conversations.findByParticipants(["operator", "agent-1", "agent-2"]);
      expect(group?.id).toBe("group");

      const missing = store.conversations.findByParticipants(["operator", "ghost"]);
      expect(missing).toBeNull();
    } finally {
      store.close();
    }
  });

  test("upsert + delete round-trip", () => {
    const store = createStore();
    try {
      seedActorsAndNode(store, ["operator", "agent-1"]);
      store.conversations.upsert(makeConversation());
      expect(store.conversations.findById("conv-1")).not.toBeNull();

      store.conversations.delete("conv-1");
      expect(store.conversations.findById("conv-1")).toBeNull();
    } finally {
      store.close();
    }
  });

  test("delete is a no-op for an unknown id", () => {
    const store = createStore();
    try {
      expect(() => store.conversations.delete("missing")).not.toThrow();
    } finally {
      store.close();
    }
  });

  test("ensureByNaturalKey mints an opaque id and stores the natural key", () => {
    const store = createStore();
    try {
      seedActorsAndNode(store, ["operator", "agent-1"]);
      const naturalKey = directChannelNaturalKey(["operator", "agent-1"]);
      const created = store.conversations.ensureByNaturalKey({
        naturalKey,
        kind: "direct",
        title: "Direct",
        visibility: "private",
        shareMode: "local",
        authorityNodeId: "node-1",
        participantIds: ["operator", "agent-1"],
      });
      expect(created.id).toMatch(new RegExp(`^${CHAT_ID_PREFIX}[0-9a-f]{32}$`));
      expect(created.metadata?.naturalKey).toBe(naturalKey);

      const reloaded = store.conversations.findById(created.id);
      expect(reloaded?.kind).toBe("direct");
      expect(reloaded?.participantIds.sort()).toEqual(["agent-1", "operator"]);
      expect(store.conversations.findByNaturalKey(naturalKey)?.id).toBe(created.id);

      const duplicate = store.conversations.ensureByNaturalKey({
        naturalKey,
        kind: "direct",
        title: "Direct again",
        visibility: "private",
        shareMode: "local",
        authorityNodeId: "node-1",
        participantIds: ["operator", "agent-1"],
      });
      expect(duplicate.id).toBe(created.id);
    } finally {
      store.close();
    }
  });

  test("promotes a structural named channel to its definitive stable id", () => {
    const store = createStore();
    try {
      seedActorsAndNode(store, ["operator", "agent-1"]);
      store.conversations.upsert(makeConversation({
        id: "channel.huddle-v1",
        kind: "channel",
        title: "huddle-v1",
        participantIds: ["agent-1"],
        metadata: { channel: "huddle-v1" },
      }));
      const naturalKey = namedChannelNaturalKey("huddle-v1");

      const created = store.conversations.ensureByNaturalKey({
        naturalKey,
        kind: "channel",
        title: "huddle-v1",
        visibility: "workspace",
        shareMode: "local",
        authorityNodeId: "node-1",
        participantIds: ["operator"],
      });

      expect(created.id).toBe(stableChannelId(naturalKey));
      expect(created.participantIds).toEqual(["agent-1", "operator"]);
      expect(store.conversations.findByNaturalKey(naturalKey)?.id).toBe(created.id);
    } finally {
      store.close();
    }
  });

  test("findByAgent ignores structural ids without a natural key", () => {
    const store = createStore();
    try {
      seedActorsAndNode(store, ["operator", "agent-1"]);
      store.conversations.upsert(makeConversation({
        id: "dm.operator.agent-1",
        participantIds: ["operator", "agent-1"],
      }));

      expect(store.conversations.findById("dm.operator.agent-1")?.id).toBe("dm.operator.agent-1");
      expect(store.conversations.findByAgent("agent-1")).toBeNull();
    } finally {
      store.close();
    }
  });
});
