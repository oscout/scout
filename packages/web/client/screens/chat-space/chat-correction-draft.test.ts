import { describe, expect, mock, test } from "bun:test";
import { chatLocalKey, createChatLocalStore, type ChatStorage } from "./chat-local-state.ts";
import type { ChatCorrectionDraft } from "./chat-correction-draft.ts";

// @ts-expect-error Bun tests load React's runtime entrypoint directly to avoid local TS path aliases.
const React = await import("../../../node_modules/react/index.js");
// @ts-expect-error Bun tests load React's runtime entrypoint directly to avoid local TS path aliases.
const ReactJsxRuntime = await import("../../../node_modules/react/jsx-runtime.js");
// @ts-expect-error Bun tests load React's runtime entrypoint directly to avoid local TS path aliases.
const ReactJsxDevRuntime = await import("../../../node_modules/react/jsx-dev-runtime.js");

mock.module("react", () => React);
mock.module("react/jsx-runtime", () => ReactJsxRuntime);
mock.module("react/jsx-dev-runtime", () => ReactJsxDevRuntime);

const { parseChatCorrectionDraft } = await import("./chat-correction-draft.ts");

const scope = { actorId: "maya", space: "home", channelId: "general" };
function memoryStorage(): ChatStorage {
  const values = new Map<string, string>();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } };
}
function store(storage: ChatStorage, key = chatLocalKey("correction", scope, "message-1")) {
  return createChatLocalStore<ChatCorrectionDraft | null>(key, null, parseChatCorrectionDraft, storage);
}

describe("correction draft recovery", () => {
  test("restores text and the original revision without rebasing", () => {
    const storage = memoryStorage();
    store(storage).write({ body: "Unfinished correction", expectedRevision: 3 });
    expect(store(storage).read()).toEqual({ body: "Unfinished correction", expectedRevision: 3 });
  });
  test("person, space, channel and message drafts are isolated", () => {
    const storage = memoryStorage();
    store(storage).write({ body: "Private unfinished edit", expectedRevision: 0 });
    for (const alternate of [{ ...scope, actorId: "alex" }, { ...scope, space: "work" }, { ...scope, channelId: "release" }]) {
      expect(store(storage, chatLocalKey("correction", alternate, "message-1")).read()).toBeNull();
    }
    expect(store(storage, chatLocalKey("correction", scope, "message-2")).read()).toBeNull();
  });
  test("an acknowledgement cannot erase a newer edit from another tab", () => {
    const storage = memoryStorage();
    const first = store(storage);
    first.write({ body: "Sent correction", expectedRevision: 2 });
    const sent = first.read();
    store(storage).write({ body: "Newer correction", expectedRevision: 2 });
    first.clearIfUnchanged(sent);
    expect(first.read()?.body).toBe("Newer correction");
    first.clearIfUnchanged(first.read());
    expect(store(storage).read()).toBeNull();
  });
  test("rejects malformed revisions and oversized drafts", () => {
    for (const expectedRevision of [-1, 0.5, "1", Infinity, undefined]) {
      expect(parseChatCorrectionDraft({ body: "text", expectedRevision })).toBeNull();
    }
    expect(parseChatCorrectionDraft({ body: "x".repeat(32001), expectedRevision: 1 })).toBeNull();
    expect(parseChatCorrectionDraft({ body: "", expectedRevision: 0 })).toEqual({ body: "", expectedRevision: 0 });
  });
});
