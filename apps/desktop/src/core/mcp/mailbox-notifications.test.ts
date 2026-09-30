import { expect, test } from "bun:test";
import { mailboxNotification, watchMailboxNotifications } from "./mailbox-notifications.ts";

const queued = (owner = "muse", sessionId = "sess.muse") => ({
  kind: "delivery.state.changed",
  payload: { delivery: {
    id: "delivery-1", targetId: owner, targetKind: "agent", transport: "mcp_poll", status: "accepted",
    metadata: { externalSession: true, phase: "mailbox_queued", sessionId, mailboxBody: "private message body" },
  } },
});

test("mailbox hint preserves owner and exact session without disclosing message body", () => {
  const notification = mailboxNotification(queued())!;
  expect(notification.agent).toBe("muse");
  expect(JSON.parse(notification.payload)).toEqual({ jsonrpc: "2.0", method: "notifications/scout/mailbox",
    params: { sessionId: "sess.muse", deliveryId: "delivery-1" } });
  expect(notification.payload).not.toContain("private message body");
  expect(mailboxNotification(queued("other", "sess.other"))?.agent).toBe("other");
});

test("only durable queued external mailbox deliveries produce hints", () => {
  for (const status of ["pending", "acknowledged", "completed", "failed", "cancelled"]) {
    const event = queued(); event.payload.delivery.status = status;
    expect(mailboxNotification(event)).toBeNull();
  }
  for (const input of [null, {}, { kind: "message.posted" }, { ...queued(), payload: {} }]) {
    expect(mailboxNotification(input)).toBeNull();
  }
  const event = queued(); event.payload.delivery.metadata.externalSession = false;
  expect(mailboxNotification(event)).toBeNull();
});

test("a later mutation of a still-queued delivery does not re-announce it", () => {
  const mutated = { ...queued(), payload: { ...queued().payload, previousStatus: "accepted" } };
  expect(mailboxNotification(mutated)).toBeNull();
  const entry = { ...queued(), payload: { ...queued().payload, previousStatus: undefined } };
  expect(mailboxNotification(entry)?.agent).toBe("muse");
});

test("reads chunked LF/CRLF SSE and ignores keepalives and malformed data", async () => {
  const encoder = new TextEncoder();
  const wire = `: hello\n\ndata: broken\n\nevent: delivery.state.changed\r\ndata: ${JSON.stringify(queued())}\r\n\r\n`;
  const notifications: unknown[] = [];
  await watchMailboxNotifications({
    brokerUrl: "http://localhost:43110", signal: new AbortController().signal,
    onNotification: (event) => notifications.push(event),
    fetch: async (url, init) => {
      expect(String(url)).toBe("http://localhost:43110/v1/events/stream");
      expect(init?.headers).toEqual({ accept: "text/event-stream" });
      return new Response(new ReadableStream({ start(controller) {
        for (let i = 0; i < wire.length; i += 7) controller.enqueue(encoder.encode(wire.slice(i, i + 7)));
        controller.close();
      } }));
    },
  });
  expect(notifications).toEqual([mailboxNotification(queued())]);
});

test("fails closed on HTTP errors and oversized partial frames", async () => {
  const options = { brokerUrl: "http://localhost:43110", signal: new AbortController().signal, onNotification: () => {} };
  await expect(watchMailboxNotifications({ ...options, fetch: async () => new Response("unavailable", { status: 503 }) }))
    .rejects.toThrow("503");
  await expect(watchMailboxNotifications({ ...options, fetch: async () => new Response("x".repeat(1_048_577)) }))
    .rejects.toThrow("frame exceeds limit");
});
