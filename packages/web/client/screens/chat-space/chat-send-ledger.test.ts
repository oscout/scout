import { describe, expect, test } from "bun:test";
import { createChatSendLedger, type ChatSendIntent } from "./chat-send-ledger.ts";

const intent: ChatSendIntent = { actorId: "maya", space: "work", channelId: "general", body: "Hello", replyToMessageId: null, targetActorId: null, files: [], mentionActorIds: [] };
function ledger() { let id = 0; return createChatSendLedger(() => `request-${++id}`); }

describe("Chat uncertain send recovery", () => {
  test("another channel's success cannot forget an uncertain send", () => {
    const sends = ledger();
    const uncertain = sends.begin(intent);
    const other = sends.begin({ ...intent, channelId: "release" });
    sends.acknowledge(other);
    expect(sends.begin(intent)).toBe(uncertain);
    expect(sends.begin(intent).requestId).toBe("request-1");
  });

  test("a late root acknowledgement cannot clear a pending reply", () => {
    const sends = ledger();
    const root = sends.begin(intent);
    const reply = sends.begin({ ...intent, replyToMessageId: "root-1" });
    sends.acknowledge(root);
    expect(sends.begin({ ...intent, replyToMessageId: "root-1" })).toBe(reply);
    expect(sends.begin(intent).requestId).not.toBe(root.requestId);
  });

  test("identity, workspace, target, body and actual files define independent sends", () => {
    const sends = ledger();
    const original = sends.begin(intent);
    const file = new File(["a"], "notes.txt");
    const variants = [
      { actorId: "alex" }, { space: "personal" }, { targetActorId: "agent" },
      { body: "Edited" }, { files: [file] }, { mentionActorIds: ["alex"] },
    ];
    for (const variant of variants) expect(sends.begin({ ...intent, ...variant }).requestId).not.toBe(original.requestId);
    const withFile = sends.begin({ ...intent, files: [file] });
    expect(sends.begin({ ...intent, files: [file] })).toBe(withFile);
    expect(sends.begin({ ...intent, files: [new File(["b"], "notes.txt")] }).requestId).not.toBe(withFile.requestId);
    expect(sends.begin(intent)).toBe(original);
  });

  test("retry reuses uploaded attachments and canonical mentions", () => {
    const sends = ledger();
    const entry = sends.begin({ ...intent, mentionActorIds: ["b", "a", "b"] });
    entry.attachments = [{ id: "notes", mediaType: "text/plain", fileName: "notes.txt", url: "/media/notes.txt" }];
    const retry = sends.begin({ ...intent, mentionActorIds: ["a", "b"] });
    expect(retry).toBe(entry);
    expect(retry.attachments).toBe(entry.attachments);
  });

  test("capacity refuses new writes without discarding retry identities", () => {
    const sends = ledger();
    const first = sends.begin(intent);
    for (let i = 1; i < 100; i++) sends.begin({ ...intent, body: `message ${i}` });
    expect(() => sends.begin({ ...intent, body: "overflow" })).toThrow("awaiting confirmation");
    expect(sends.begin(intent)).toBe(first);
    sends.acknowledge(first);
    expect(sends.begin({ ...intent, body: "overflow" }).requestId).toBe("request-101");
  });
});

describe("Chat text-send recovery after reload", () => {
  function storage() {
    const values = new Map<string, string>();
    return { values, getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); } };
  }
  test("a reconstructed ledger reuses an uncertain request, including its explicit target", () => {
    const disk = storage();
    const original = createChatSendLedger(() => "before-refresh", disk);
    const submitted = original.begin({ ...intent, targetActorId: "codex" });
    const reloaded = createChatSendLedger(() => "after-refresh", disk);
    expect(reloaded.begin({ ...intent, targetActorId: "codex" }).requestId).toBe(submitted.requestId);
    expect(reloaded.begin(intent).requestId).toBe("after-refresh");
    reloaded.acknowledge(submitted);
    expect(createChatSendLedger(() => "new-send", disk).begin({ ...intent, targetActorId: "codex" }).requestId).toBe("new-send");
  });
  test("independent ledgers persist independently and cannot erase a later identity", () => {
    const disk = storage();
    const first = createChatSendLedger(() => "first", disk);
    const old = first.begin(intent);
    const second = createChatSendLedger(() => "second", disk);
    second.begin({ ...intent, channelId: "release" });
    first.acknowledge(old);
    const next = second.begin(intent);
    first.acknowledge(old);
    expect(createChatSendLedger(() => "third", disk).begin(intent).requestId).toBe(next.requestId);
    expect(disk.values.size).toBe(2);
  });
  test("actor, space and thread boundaries survive reconstruction", () => {
    const disk = storage();
    createChatSendLedger(() => "original", disk).begin(intent);
    for (const change of [{ actorId: "alex" }, { space: "private" }, { replyToMessageId: "thread" }]) {
      expect(createChatSendLedger(() => "isolated", disk).begin({ ...intent, ...change }).requestId).toBe("isolated");
    }
  });
  test("unavailable storage preserves retries in the mounted surface", () => {
    const denied = () => { throw new Error("Storage disabled"); };
    const sends = createChatSendLedger(() => "memory", { getItem: denied, setItem: denied, removeItem: denied });
    const entry = sends.begin(intent);
    expect(sends.begin(intent)).toBe(entry);
    expect(() => sends.acknowledge(entry)).not.toThrow();
  });
  test("files are not mistaken for a recoverable text-only send", () => {
    const disk = storage();
    createChatSendLedger(() => "file-send", disk).begin({ ...intent, files: [new File(["a"], "a.txt")] });
    expect(disk.values.size).toBe(1);
    expect(createChatSendLedger(() => "text-send", disk).begin(intent).requestId).toBe("text-send");
  });
});

test("attachment retries recover the prepared upload reference", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const file = new File(["content"], "notes.md");
  const original = createChatSendLedger(() => "original-upload", storage);
  const entry = original.begin({ ...intent, files: [file] });
  original.prepared(entry, [{ id: "uploaded-file", mediaType: "text/markdown", url: "/media/notes" }]);
  const restored = createChatSendLedger(() => "must-not-create", storage).begin({ ...intent, files: [file] });
  expect(restored.requestId).toBe(entry.requestId);
  expect(restored.attachments).toEqual(entry.attachments);
});
