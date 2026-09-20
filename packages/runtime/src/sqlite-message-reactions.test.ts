import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SQLiteControlPlaneStore } from "./sqlite-store.ts";

const dbRoots = new Set<string>();

afterEach(() => {
  for (const root of dbRoots) rmSync(root, { recursive: true, force: true });
  dbRoots.clear();
});

function createStore(): SQLiteControlPlaneStore {
  const root = mkdtempSync(join(tmpdir(), "openscout-message-reactions-"));
  dbRoots.add(root);
  return new SQLiteControlPlaneStore(join(root, "control-plane.sqlite"));
}

function seedChannel(store: SQLiteControlPlaneStore) {
  store.upsertNode({
    id: "node-1",
    meshId: "mesh-1",
    name: "Test node",
    advertiseScope: "local",
    registeredAt: Date.now(),
  });
  store.upsertActor({ id: "actor-1", kind: "person", displayName: "Maya" });
  store.upsertActor({ id: "actor-2", kind: "agent", displayName: "Codex" });
  store.upsertConversation({
    id: "chn-1",
    kind: "channel",
    title: "general",
    visibility: "workspace",
    shareMode: "shared",
    authorityNodeId: "node-1",
    participantIds: ["actor-1", "actor-2"],
  });
  store.recordMessage({
    id: "m1",
    conversationId: "chn-1",
    actorId: "actor-1",
    originNodeId: "node-1",
    class: "agent",
    body: "hello",
    visibility: "workspace",
    policy: "durable",
    createdAt: Date.now(),
  });
}

describe("message_reactions", () => {
  test("add is idempotent, remove of a missing row succeeds, and wrong channel is denied", () => {
    const store = createStore();
    try {
      seedChannel(store);
      const first = store.upsertMessageReaction({
        channelId: "chn-1",
        messageId: "m1",
        actorId: "actor-1",
        emoji: "👍",
        createdAt: 10,
      });
      const replay = store.upsertMessageReaction({
        channelId: "chn-1",
        messageId: "m1",
        actorId: "actor-1",
        emoji: "👍",
        createdAt: 20,
      });
      expect(first.replayed).toBe(false);
      expect(replay.replayed).toBe(true);
      expect(store.listMessageReactions("chn-1")).toEqual([
        { messageId: "m1", actorId: "actor-1", emoji: "👍", createdAt: 10 },
      ]);

      expect(store.removeMessageReaction({
        channelId: "chn-1",
        messageId: "m1",
        actorId: "actor-1",
        emoji: "👍",
      }).replayed).toBe(false);
      expect(store.removeMessageReaction({
        channelId: "chn-1",
        messageId: "m1",
        actorId: "actor-1",
        emoji: "👍",
      }).replayed).toBe(true);

      store.upsertConversation({
        id: "chn-other",
        kind: "channel",
        title: "other",
        visibility: "workspace",
        shareMode: "shared",
        authorityNodeId: "node-1",
        participantIds: ["actor-1"],
      });
      expect(() => store.upsertMessageReaction({
        channelId: "chn-other",
        messageId: "m1",
        actorId: "actor-1",
        emoji: "🎉",
        createdAt: 30,
      })).toThrow("message is not in this channel");
    } finally {
      store.close();
    }
  });

  test("deleting a message cascades its reactions", () => {
    const store = createStore();
    try {
      seedChannel(store);
      store.upsertMessageReaction({
        channelId: "chn-1",
        messageId: "m1",
        actorId: "actor-2",
        emoji: "🎉",
        createdAt: 10,
      });
      const db = (store as unknown as { db: { query: (sql: string) => { run: (...args: unknown[]) => unknown; get: (...args: unknown[]) => unknown } } }).db;
      db.query("DELETE FROM messages WHERE id = ?1").run("m1");
      expect(store.listMessageReactions("chn-1")).toEqual([]);
    } finally {
      store.close();
    }
  });
});
