import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { isOpaqueChannelId } from "@openscout/protocol";
import { ScoutbotThreadMapStore } from "./thread-map.ts";

describe("ScoutbotThreadMapStore", () => {
  test("concurrent creation and provider replies preserve all thread mappings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scoutbot-thread-map-"));
    try {
      const path = join(dir, "threads.json");
      const firstStore = new ScoutbotThreadMapStore(path);
      const secondStore = new ScoutbotThreadMapStore(path);
      const initial = await firstStore.createThread("Existing", { transportSessionId: null, model: "gpt-6-astra" });
      const [created] = await Promise.all([
        secondStore.createThread("Fresh", { transportSessionId: null, model: "gpt-5.6-sol" }),
        firstStore.setThreadTransportSessionId(initial.threadId, "provider-existing"),
        firstStore.ensureDefaultThread({}),
      ]);
      expect(await firstStore.getThread(created.threadId)).toMatchObject({ model: "gpt-5.6-sol" });
      expect(await secondStore.getThread(initial.threadId)).toMatchObject({ transportSessionId: "provider-existing" });
      expect((await firstStore.list()).threads).toHaveLength(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("retains each conversation's selected runtime and provider continuation across reload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scoutbot-thread-map-"));
    try {
      const path = join(dir, "threads.json");
      const store = new ScoutbotThreadMapStore(path);
      const first = await store.createThread("Find last build", {
        model: "gpt-6-astra", reasoningEffort: "high", transportSessionId: null,
        pins: { projectRoot: "/workspace/example" },
      });
      const second = await store.createThread("General question", {
        model: "gpt-5.6-sol", reasoningEffort: "low", transportSessionId: null,
      });
      await store.setThreadTransportSessionId(first.threadId, "provider-history-1");
      const reloaded = new ScoutbotThreadMapStore(path);
      expect(await reloaded.getThread(first.threadId)).toMatchObject({
        model: "gpt-6-astra", reasoningEffort: "high", transportSessionId: "provider-history-1",
        conversationId: first.conversationId, pins: { projectRoot: "/workspace/example" },
      });
      expect(await reloaded.getThread(second.threadId)).toMatchObject({
        model: "gpt-5.6-sol", reasoningEffort: "low", transportSessionId: null, pins: null,
      });
      expect(first.conversationId).not.toBe(second.conversationId);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

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
