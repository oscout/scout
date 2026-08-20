import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { isOpaqueChannelId } from "@openscout/protocol";
import { ScoutbotThreadMapStore } from "./thread-map.ts";

describe("ScoutbotThreadMapStore", () => {
  test("auto-creates default thread from an existing opaque scoutbot conversation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scoutbot-thread-map-"));
    try {
      const store = new ScoutbotThreadMapStore(join(dir, "threads.json"));
      const thread = await store.ensureDefaultThread({
        transportSessionId: "codex-thread-1",
        snapshot: {
          actors: {},
          agents: {},
          endpoints: {},
          nodes: {},
          messages: {},
          conversations: {
            "c.scoutbot-default": {
              id: "c.scoutbot-default",
              kind: "direct",
              title: "Scout",
              visibility: "private",
              shareMode: "local",
              authorityNodeId: "node-1",
              participantIds: ["operator", "scoutbot"],
              metadata: {
                scoutbotThreadId: "thr-default",
              },
            },
          },
        },
        now: 99,
      });
      expect(thread).toMatchObject({
        threadId: "thr-default",
        name: "default",
        conversationId: "c.scoutbot-default",
        transportSessionId: "codex-thread-1",
        transport: "codex_app_server",
        lastActiveAt: 99,
      });
      expect(await store.list()).toEqual({ threads: [thread], defaultThreadId: "thr-default" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does not reuse a structural scoutbot conversation id from broker snapshot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scoutbot-thread-map-"));
    try {
      const store = new ScoutbotThreadMapStore(join(dir, "threads.json"));
      const thread = await store.ensureDefaultThread({
        snapshot: {
          actors: {},
          agents: {},
          endpoints: {},
          nodes: {},
          messages: {},
          conversations: {
            "dm.operator.scoutbot.default": {
              id: "dm.operator.scoutbot.default",
              kind: "direct",
              title: "Scout",
              visibility: "private",
              shareMode: "local",
              authorityNodeId: "node-1",
              participantIds: ["operator", "scoutbot"],
              metadata: {
                scoutbotThreadId: "thr-default",
              },
            },
          },
        },
        now: 100,
      });

      expect(thread.conversationId).not.toBe("dm.operator.scoutbot.default");
      expect(thread.conversationId.startsWith("chn-")).toBe(true);
      expect(isOpaqueChannelId(thread.conversationId)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("migrates a persisted structural default thread conversation id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scoutbot-thread-map-"));
    try {
      const filePath = join(dir, "threads.json");
      await writeFile(
        filePath,
        JSON.stringify({
          version: 1,
          defaultThreadId: "thr-default",
          threads: [{
            threadId: "thr-default",
            name: "default",
            conversationId: "dm.operator.scoutbot.default",
            transportSessionId: null,
            transport: "codex_app_server",
            pins: null,
            lastActiveAt: 1,
          }],
        }),
        "utf8",
      );

      const store = new ScoutbotThreadMapStore(filePath);
      const thread = await store.ensureDefaultThread({
        transportSessionId: "codex-thread-2",
        now: 101,
      });

      expect(thread.conversationId).not.toBe("dm.operator.scoutbot.default");
      expect(thread.conversationId.startsWith("chn-")).toBe(true);
      expect(isOpaqueChannelId(thread.conversationId)).toBe(true);
      expect(thread.transportSessionId).toBe("codex-thread-2");
      expect(await store.list()).toEqual({ threads: [thread], defaultThreadId: "thr-default" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
