import type { RuntimeHttpRequestLike, RuntimeHttpResponseLike } from "./portable-types.js";

import type {
  ControlEvent,
  DeliveryIntent,
  DeliveryReason,
  DeliveryStatus,
  InboxItem,
  InvocationRequest,
  MessageRecord,
} from "@openscout/protocol";

export const DEFAULT_INBOX_STATUSES = new Set<DeliveryStatus>([
  "pending",
  "accepted",
  "deferred",
  "leased",
]);

export type BrokerControlStreamServiceDeps = {
  enqueueEvent: (event: ControlEvent) => void;
  findDeliveryById: (deliveryId: string) => DeliveryIntent | undefined;
  listDeliveries: (options: { limit: number }) => Promise<DeliveryIntent[]> | DeliveryIntent[];
  messageById: (messageId: string) => MessageRecord | undefined;
  invocationById: (invocationId: string) => InvocationRequest | undefined;
};

export function parseInboxStatuses(url: URL): Set<DeliveryStatus> | undefined {
  const values = url.searchParams.getAll("status")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length > 0 ? new Set(values as DeliveryStatus[]) : undefined;
}

export function parseInboxReasons(url: URL): Set<DeliveryReason> | undefined {
  const values = url.searchParams.getAll("reason")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length > 0 ? new Set(values as DeliveryReason[]) : undefined;
}

export function writeSseFrame(response: RuntimeHttpResponseLike, eventName: string, payload: unknown): void {
  response.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
}

export function invocationIdsForEvent(
  event: ControlEvent,
  options: { findDeliveryById?: (deliveryId: string) => DeliveryIntent | undefined } = {},
): string[] {
  switch (event.kind) {
    case "invocation.requested":
      return [event.payload.invocation.id];
    case "flight.updated":
      return event.payload.flight.invocationId ? [event.payload.flight.invocationId] : [];
    case "delivery.planned":
      return event.payload.delivery.invocationId ? [event.payload.delivery.invocationId] : [];
    case "delivery.attempted": {
      const deliveryId = event.payload.attempt.deliveryId;
      const delivery = options.findDeliveryById?.(deliveryId);
      return delivery?.invocationId ? [delivery.invocationId] : [];
    }
    case "delivery.state.changed":
      return event.payload.delivery.invocationId ? [event.payload.delivery.invocationId] : [];
    case "scout.dispatched":
      return event.payload.dispatch.invocationId ? [event.payload.dispatch.invocationId] : [];
    case "message.posted": {
      const dispatch = (event.payload.message.metadata as { scoutDispatch?: { invocationId?: string } } | undefined)
        ?.scoutDispatch;
      return dispatch?.invocationId ? [dispatch.invocationId] : [];
    }
    default:
      return [];
  }
}

export function inboxTargetsForEvent(event: ControlEvent): string[] {
  switch (event.kind) {
    case "delivery.planned":
    case "delivery.state.changed":
      return [event.payload.delivery.targetId];
    default:
      return [];
  }
}

export class BrokerControlStreamService {
  private readonly eventClients = new Set<RuntimeHttpResponseLike>();
  private readonly invocationStreamClients = new Map<string, Set<RuntimeHttpResponseLike>>();
  private readonly inboxStreamClients = new Map<string, Set<RuntimeHttpResponseLike>>();

  constructor(private readonly deps: BrokerControlStreamServiceDeps) {}

  eventSubscriberCount(): number {
    return this.eventClients.size;
  }

  invocationSubscriberCount(invocationId: string): number {
    return this.invocationStreamClients.get(invocationId)?.size ?? 0;
  }

  inboxSubscriberCount(targetId: string): number {
    return this.inboxStreamClients.get(targetId)?.size ?? 0;
  }

  inboxItemForDelivery(delivery: DeliveryIntent): InboxItem {
    const message = delivery.messageId ? this.deps.messageById(delivery.messageId) : undefined;
    const invocation = delivery.invocationId ? this.deps.invocationById(delivery.invocationId) : undefined;
    return {
      id: delivery.id,
      kind: delivery.invocationId ? "invocation" : "message",
      targetId: delivery.targetId,
      targetNodeId: delivery.targetNodeId,
      conversationId: message?.conversationId ?? invocation?.conversationId,
      messageId: delivery.messageId,
      invocationId: delivery.invocationId,
      reason: delivery.reason,
      status: delivery.status,
      leaseOwner: delivery.leaseOwner,
      leaseExpiresAt: delivery.leaseExpiresAt,
      delivery,
      message,
      invocation,
      metadata: delivery.metadata,
    };
  }

  async listInboxItems(options: {
    targetId: string;
    statuses?: Set<DeliveryStatus>;
    reasons?: Set<DeliveryReason>;
    limit?: number;
  }): Promise<InboxItem[]> {
    const statuses = options.statuses ?? DEFAULT_INBOX_STATUSES;
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const deliveries = await this.deps.listDeliveries({ limit: 5000 });
    return deliveries
      .filter((delivery) => delivery.targetId === options.targetId)
      .filter((delivery) => statuses.has(delivery.status))
      .filter((delivery) => !options.reasons || options.reasons.has(delivery.reason))
      .slice(0, limit)
      .map((delivery) => this.inboxItemForDelivery(delivery));
  }

  addInboxStream(options: {
    request: RuntimeHttpRequestLike;
    response: RuntimeHttpResponseLike;
    targetId: string;
    snapshot: unknown;
  }): void {
    options.response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    writeSseFrame(options.response, "snapshot", options.snapshot);

    const subscribers = this.inboxStreamClients.get(options.targetId) ?? new Set<RuntimeHttpResponseLike>();
    subscribers.add(options.response);
    this.inboxStreamClients.set(options.targetId, subscribers);
    options.request.on("close", () => {
      const set = this.inboxStreamClients.get(options.targetId);
      if (set) {
        set.delete(options.response);
        if (set.size === 0) this.inboxStreamClients.delete(options.targetId);
      }
      options.response.end();
    });
  }

  addInvocationStream(options: {
    request: RuntimeHttpRequestLike;
    response: RuntimeHttpResponseLike;
    invocationId: string;
    snapshot: unknown;
  }): void {
    options.response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    writeSseFrame(options.response, "snapshot", options.snapshot);

    let subscribers = this.invocationStreamClients.get(options.invocationId);
    if (!subscribers) {
      subscribers = new Set();
      this.invocationStreamClients.set(options.invocationId, subscribers);
    }
    subscribers.add(options.response);
    options.request.on("close", () => {
      const set = this.invocationStreamClients.get(options.invocationId);
      if (set) {
        set.delete(options.response);
        if (set.size === 0) this.invocationStreamClients.delete(options.invocationId);
      }
      options.response.end();
    });
  }

  addEventStream(options: {
    request: RuntimeHttpRequestLike;
    response: RuntimeHttpResponseLike;
    hello: unknown;
  }): void {
    options.response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    writeSseFrame(options.response, "hello", options.hello);
    this.eventClients.add(options.response);
    options.request.on("close", () => {
      this.eventClients.delete(options.response);
      options.response.end();
    });
  }

  streamEvent(event: ControlEvent): void {
    this.deps.enqueueEvent(event);
    const payload = `event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of this.eventClients) {
      client.write(payload);
    }
    for (const invocationId of invocationIdsForEvent(event, {
      findDeliveryById: this.deps.findDeliveryById,
    })) {
      const subscribers = this.invocationStreamClients.get(invocationId);
      if (!subscribers) continue;
      for (const client of subscribers) {
        client.write(payload);
      }
    }
    if (inboxTargetsForEvent(event).length > 0) {
      const delivery = (event as Extract<ControlEvent, { kind: "delivery.planned" | "delivery.state.changed" }>)
        .payload.delivery;
      this.publishInboxDeliveryEvent(delivery, event.kind === "delivery.planned" ? "inbox.item" : "inbox.item.updated");
    }
  }

  streamKeepAlive(): void {
    for (const client of this.eventClients) {
      client.write(": keepalive\n\n");
    }
    for (const subscribers of this.invocationStreamClients.values()) {
      for (const client of subscribers) {
        client.write(": keepalive\n\n");
      }
    }
  }

  closeAll(): void {
    for (const client of this.eventClients) {
      client.end();
    }
    for (const subscribers of this.invocationStreamClients.values()) {
      for (const client of subscribers) {
        client.end();
      }
    }
    for (const subscribers of this.inboxStreamClients.values()) {
      for (const client of subscribers) {
        client.end();
      }
    }
    this.eventClients.clear();
    this.invocationStreamClients.clear();
    this.inboxStreamClients.clear();
  }

  private publishInboxDeliveryEvent(delivery: DeliveryIntent, eventName: string): void {
    const subscribers = this.inboxStreamClients.get(delivery.targetId);
    if (!subscribers || subscribers.size === 0) {
      return;
    }
    const item = this.inboxItemForDelivery(delivery);
    for (const client of subscribers) {
      writeSseFrame(client, eventName, item);
    }
  }
}
