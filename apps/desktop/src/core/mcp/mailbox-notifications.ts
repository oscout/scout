import { z } from "zod";

const queuedMailboxEvent = z.object({
  kind: z.literal("delivery.state.changed"),
  payload: z.object({
    delivery: z.object({
      id: z.string().min(1),
      targetId: z.string().min(1),
      targetKind: z.literal("agent"),
      transport: z.literal("mcp_poll"),
      status: z.literal("accepted"),
      metadata: z.object({
        externalSession: z.literal(true),
        phase: z.literal("mailbox_queued"),
        sessionId: z.string().min(1),
      }),
    }),
    // Only the queue-entry event (no prior status) is new work. Later mutations of a
    // still-accepted delivery (e.g. a reply hash) re-publish the snapshot with one.
    previousStatus: z.undefined().optional(),
  }),
});

export function mailboxNotification(input: unknown) {
  const parsed = queuedMailboxEvent.safeParse(input);
  if (!parsed.success) return null;
  const delivery = parsed.data.payload.delivery;
  return {
    agent: delivery.targetId,
    payload: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/scout/mailbox",
      params: { sessionId: delivery.metadata.sessionId, deliveryId: delivery.id },
    }),
  };
}

/** Notification hints are ephemeral; clients reconcile their durable mailbox after reconnect. */
export async function watchMailboxNotifications(options: {
  brokerUrl: string;
  signal: AbortSignal;
  onNotification: (notification: NonNullable<ReturnType<typeof mailboxNotification>>) => void;
  fetch?: (url: URL, init: RequestInit) => Promise<Response>;
}): Promise<void> {
  const response = await (options.fetch ?? fetch)(new URL("/v1/events/stream", options.brokerUrl), {
    headers: { accept: "text/event-stream" }, signal: options.signal,
  });
  if (!response.ok || !response.body) throw new Error(`broker event stream returned ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!options.signal.aborted) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const separator = /\r?\n\r?\n/.exec(buffer);
        if (!separator || separator.index === undefined) break;
        const block = buffer.slice(0, separator.index);
        if (block.length > 1_048_576) throw new Error("broker event stream frame exceeds limit");
        buffer = buffer.slice(separator.index + separator[0].length);
        const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, "")).join("\n");
        if (!data) continue;
        let event: unknown;
        try { event = JSON.parse(data); } catch { continue; }
        const notification = mailboxNotification(event);
        if (notification) options.onNotification(notification);
      }
      if (buffer.length > 1_048_576) throw new Error("broker event stream frame exceeds limit");
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
