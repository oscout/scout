import { describe, expect, test } from "bun:test";
import { chatLocalKey, createChatLocalStore, EMPTY_CHAT_DRAFT, parseChatDraft, type ChatStorage } from "./chat-local-state.ts";

function memoryStorage(): ChatStorage {
  const records = new Map<string, string>();
  return {
    getItem: (key) => records.get(key) ?? null,
    setItem: (key, value) => { records.set(key, value); },
    removeItem: (key) => { records.delete(key); },
  };
}
const scope = { actorId: "maya", space: "work", channelId: "release" };
const body = "Review **the release**\n\n日本語 draft 👋";
const makeStore = (storage: ChatStorage | null, key = chatLocalKey("draft", scope)) =>
  createChatLocalStore(key, EMPTY_CHAT_DRAFT, parseChatDraft, storage);

describe("durable chat drafts", () => {
  test("mention recipients survive reopening and a late acknowledgement preserves changed recipients", () => {
    const storage = memoryStorage();
    const store = makeStore(storage);
    store.write({ body, targetActorId: null, mentions: [{ actorId: "alex", label: "Alex" }] });
    const submitted = store.read();
    expect(makeStore(storage).read().mentions).toEqual([{ actorId: "alex", label: "Alex" }]);
    store.update(current => ({ ...current, mentions: [{ actorId: "maya", label: "Maya" }] }));
    store.clearIfUnchanged(submitted);
    expect(store.read().mentions?.[0]?.actorId).toBe("maya");
    expect(makeStore(storage, chatLocalKey("draft", { ...scope, actorId: "other" })).read()).toEqual(EMPTY_CHAT_DRAFT);
  });

  test("reopening restores exact multiline text and explicit agent target", () => {
    const storage = memoryStorage();
    makeStore(storage).write({ body, targetActorId: "maya-codex" });
    expect(makeStore(storage).read()).toEqual({ body, targetActorId: "maya-codex" });
  });

  test("person, space, channel and thread are separate even with delimiter characters", () => {
    const storage = memoryStorage();
    makeStore(storage).write({ body, targetActorId: null });
    for (const key of [
      chatLocalKey("draft", { ...scope, actorId: "alex" }),
      chatLocalKey("draft", { ...scope, space: "personal" }),
      chatLocalKey("draft", { ...scope, channelId: "general" }),
      chatLocalKey("draft", scope, "thread-a"),
      chatLocalKey("draft", scope, "thread-b"),
    ]) expect(makeStore(storage, key).read()).toBe(EMPTY_CHAT_DRAFT);
    expect(chatLocalKey("draft", { ...scope, actorId: "a:b", space: "c" }))
      .not.toBe(chatLocalKey("draft", { ...scope, actorId: "a", space: "b:c" }));
  });

  test("a late send acknowledgement preserves newer edits and target changes", () => {
    const storage = memoryStorage();
    const store = makeStore(storage);
    store.write({ body, targetActorId: null });
    const sent = store.read();
    store.update((current) => ({ ...current, body: "Next message" }));
    store.clearIfUnchanged(sent);
    expect(makeStore(storage).read().body).toBe("Next message");
    // Even an edit returning to the same text is newer work.
    store.write({ ...sent });
    store.clearIfUnchanged(sent);
    expect(store.read().body).toBe(body);
  });

  test("successful send removes only the unchanged composer", () => {
    const storage = memoryStorage();
    const store = makeStore(storage);
    const reply = makeStore(storage, chatLocalKey("draft", scope, "root"));
    store.write({ body, targetActorId: "agent" });
    reply.write({ body: "Reply in progress", targetActorId: null });
    store.clearIfUnchanged(store.read());
    expect(makeStore(storage).read()).toBe(EMPTY_CHAT_DRAFT);
    expect(reply.read().body).toBe("Reply in progress");
  });

  test("other tabs cannot be erased by a late acknowledgement", () => {
    const storage = memoryStorage();
    const first = makeStore(storage);
    first.write({ body, targetActorId: null });
    const sent = first.read();
    makeStore(storage).write({ body: "From another tab", targetActorId: null });
    first.clearIfUnchanged(sent);
    expect(first.read().body).toBe("From another tab");
  });

  test("malformed or outdated data does not prevent composing", () => {
    const storage = memoryStorage();
    const key = chatLocalKey("draft", scope);
    for (const raw of ["{broken", "null", "12", '{"body":42}', '{"text":"old"}']) {
      storage.setItem(key, raw);
      const store = makeStore(storage);
      expect(store.read()).toBe(EMPTY_CHAT_DRAFT);
      store.write({ body, targetActorId: null });
      expect(store.read().body).toBe(body);
    }
  });

  test("denied or full storage retains edits in memory", () => {
    for (const storage of [null, {
      getItem() { throw new Error("Denied"); },
      setItem() { throw new Error("Quota exceeded"); },
      removeItem() { throw new Error("Denied"); },
    }, { ...memoryStorage(), setItem() { throw new Error("Quota exceeded"); } }]) {
      const store = makeStore(storage);
      store.read();
      store.write({ body, targetActorId: "agent" });
      expect(store.read()).toEqual({ body, targetActorId: "agent" });
      store.clearIfUnchanged(store.read());
      expect(store.read()).toBe(EMPTY_CHAT_DRAFT);
    }
  });

  test("an unauthenticated composer cannot write a shared anonymous draft", () => {
    const store = createChatLocalStore(null, EMPTY_CHAT_DRAFT, parseChatDraft, memoryStorage());
    store.write({ body, targetActorId: null });
    expect(store.read()).toBe(EMPTY_CHAT_DRAFT);
  });
});
