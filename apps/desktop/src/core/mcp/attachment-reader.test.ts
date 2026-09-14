import { describe, expect, test } from "bun:test";
import type { MessageRecord, ScoutReplyContext } from "@openscout/protocol";
import { readScopedAttachment, type AttachmentReaderDependencies } from "./attachment-reader.ts";

// Bun augments fetch with preconnect; these tests only exercise requests.
function mockFetch(implementation: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>): typeof fetch {
  return Object.assign(implementation, { preconnect: () => undefined });
}

const context: ScoutReplyContext = { mode: "broker_reply", fromAgentId: "operator", toAgentId: "scoutbot", conversationId: "chat-one", messageId: "message-one", replyToMessageId: "message-one", replyPath: "final_response" };
const message = { id: "message-one", conversationId: "chat-one", actorId: "operator", attachments: [{ id: "att-one", mediaType: "text/plain", fileName: "notes.txt", url: "http://localhost:43120/api/blobs/blob-one" }] } as MessageRecord;
function deps(overrides: Partial<AttachmentReaderDependencies> = {}): AttachmentReaderDependencies {
  return { currentContext: () => context, message: async () => message, webOrigin: "http://localhost:43120", env: {}, fetchImpl: mockFetch(async () => new Response("project notes", { headers: { "content-type": "text/plain" } })), ...overrides };
}
const read = (overrides: Partial<AttachmentReaderDependencies> = {}) => readScopedAttachment({ attachmentId: "att-one" }, deps(overrides));

describe("authorized Scoutbot attachment inspection", () => {
  test("reads canonical operator text and explicitly marks it as untrusted", async () => {
    const result = await read();
    expect(result).toMatchObject({ supported: true, text: "project notes", mediaType: "text/plain", truncated: false, sourceTrust: "untrusted_operator_attachment" });
  });
  test("rejects missing context, cross-conversation messages, and non-operator attachments before fetching", async () => {
    let fetched = false;
    const fetchImpl = mockFetch(async () => { fetched = true; throw new Error("unexpected fetch"); });
    await expect(read({ currentContext: () => null, fetchImpl })).rejects.toThrow("active authorized");
    await expect(read({ message: async () => ({ ...message, conversationId: "other-chat" }), fetchImpl })).rejects.toThrow("current authorized");
    await expect(read({ message: async () => ({ ...message, actorId: "untrusted-agent" }), fetchImpl })).rejects.toThrow("operator message");
    await expect(readScopedAttachment({ attachmentId: "invented" }, deps({ fetchImpl }))).rejects.toThrow("missing");
    expect(fetched).toBe(false);
  });
  test("rejects arbitrary destinations, credentials, paths and query strings", async () => {
    for (const url of ["https://example.com/api/blobs/blob-one", "http://localhost:43120/api/sessions", "file:///etc/passwd", "http://user:password@localhost:43120/api/blobs/blob-one", "http://localhost:43120/api/blobs/blob-one?path=secret"]) {
      await expect(read({ message: async () => ({ ...message, attachments: [{ ...message.attachments![0]!, url }] }), fetchImpl: mockFetch(async () => { throw new Error("unexpected fetch"); }) })).rejects.toThrow("same-origin");
    }
  });
  test("does not fetch unsupported image, audio, video or PDF content", async () => {
    for (const mediaType of ["image/png", "audio/wav", "video/mp4", "application/pdf"]) {
      expect(await read({ message: async () => ({ ...message, attachments: [{ ...message.attachments![0]!, mediaType }] }), fetchImpl: mockFetch(async () => { throw new Error("unexpected fetch"); }) })).toMatchObject({ supported: false, mediaType });
    }
  });
  test("forbids redirects on blob and auth requests and authenticates using bootstrap cookie", async () => {
    const seen: string[] = [];
    const fetchImpl = mockFetch(async (input: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      seen.push(path);
      if (path === "/api/bootstrap.js") return new Response("// bootstrap", { headers: { "set-cookie": "openscout_web_session=cookie; Path=/" } });
      if (new Headers(init?.headers).get("cookie") !== "openscout_web_session=cookie") return new Response("unauthorized", { status: 401 });
      return new Response("authenticated notes", { headers: { "content-type": "text/plain" } });
    });
    expect(await read({ fetchImpl })).toMatchObject({ text: "authenticated notes" });
    expect(seen).toEqual(["/api/blobs/blob-one", "/api/bootstrap.js", "/api/blobs/blob-one"]);
  });
  test("rejects mismatched response media and declared/streamed oversized content", async () => {
    await expect(read({ fetchImpl: mockFetch(async () => new Response("binary", { headers: { "content-type": "image/png" } })) })).rejects.toThrow("media type");
    await expect(read({ fetchImpl: mockFetch(async () => new Response("small", { headers: { "content-type": "text/plain", "content-length": "262145" } })) })).rejects.toThrow("256 KiB");
    await expect(read({ fetchImpl: mockFetch(async () => new Response("x".repeat(262145), { headers: { "content-type": "text/plain" } })) })).rejects.toThrow("256 KiB");
  });
  test("returns bounded UTF-8 text with honest truncation and rejects binary text", async () => {
    const result = await read({ fetchImpl: mockFetch(async () => new Response("x".repeat(33000), { headers: { "content-type": "text/plain" } })) });
    expect(result).toMatchObject({ truncated: true, bytes: 33000 });
    expect("text" in result ? result.text?.length : 0).toBe(32000);
    await expect(read({ fetchImpl: mockFetch(async () => new Response("bad\u0000text", { headers: { "content-type": "text/plain" } })) })).rejects.toThrow("binary");
  });
  test("reads earlier message only while its conversation still matches current context", async () => {
    let active = context;
    const readerDeps = deps({ currentContext: () => active, message: async (id) => id === "earlier" ? { ...message, id } : null });
    expect(await readScopedAttachment({ attachmentId: "att-one", messageId: "earlier" }, readerDeps)).toMatchObject({ supported: true });
    active = { ...context, conversationId: "new-chat" };
    await expect(readScopedAttachment({ attachmentId: "att-one", messageId: "earlier" }, readerDeps)).rejects.toThrow("current authorized");
  });
});
