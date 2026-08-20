import { EventEmitter } from "node:events";

import { describe, expect, test } from "bun:test";

import type {
  ControlEvent,
  DeliveryIntent,
  InvocationRequest,
  MessageRecord,
} from "@openscout/protocol";

import {
  BrokerControlStreamService,
  invocationIdsForEvent,
  parseInboxReasons,
  parseInboxStatuses,
} from "./broker-control-stream-service.js";

class FakeRequest extends EventEmitter {}

class FakeResponse {
  readonly chunks: string[] = [];
  headers: Record<string, string> | undefined;
  status: number | undefined;
  ended = false;

  writeHead(status: number, headers: Record<string, string>): void {
    this.status = status;
    this.headers = headers;
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  end(): void {
    this.ended = true;
  }

  body(): string {
    return this.chunks.join("");
  }
}

function delivery(input: Partial<DeliveryIntent> = {}): DeliveryIntent {
  return {
    id: "delivery-1",
    messageId: "message-1",
    targetId: "agent-1",
    targetKind: "agent",
    transport: "local_socket",
    reason: "direct_message",
    policy: "best_effort",
    status: "pending",
    ...input,
  };
}

function message(input: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id: "message-1",
    conversationId: "conversation-1",
    actorId: "operator",
    originNodeId: "node-1",
    class: "person",
    body: "hello",
    visibility: "workspace",
    policy: "best_effort",
    createdAt: 1,
    ...input,
  };
}

function invocation(input: Partial<InvocationRequest> = {}): InvocationRequest {
  return {
    id: "invocation-1",
    requesterId: "operator",
    requesterNodeId: "node-1",
    targetAgentId: "agent-1",
    action: "consult",
    task: "queued work",
    ensureAwake: true,
    stream: false,
    createdAt: 1,
    ...input,
  };
}

function createService(input: {
  deliveries?: DeliveryIntent[];
  messages?: MessageRecord[];
  invocations?: InvocationRequest[];
} = {}) {
  const deliveries = new Map((input.deliveries ?? []).map((item) => [item.id, item]));
  const messages = new Map((input.messages ?? []).map((item) => [item.id, item]));
  const invocations = new Map((input.invocations ?? []).map((item) => [item.id, item]));
  const enqueuedEvents: ControlEvent[] = [];
  const service = new BrokerControlStreamService({
    enqueueEvent: (event) => enqueuedEvents.push(event),
    findDeliveryById: (deliveryId) => deliveries.get(deliveryId),
    listDeliveries: () => [...deliveries.values()],
    messageById: (messageId) => messages.get(messageId),
    invocationById: (invocationId) => invocations.get(invocationId),
  });
  return { enqueuedEvents, service };
}

describe("broker control stream service", () => {
  test("parses comma-separated inbox filters", () => {
    const url = new URL("http://broker.test/v1/inbox?status=pending,leased&reason=direct_message&reason=invocation");

    expect(parseInboxStatuses(url)).toEqual(new Set(["pending", "leased"]));
    expect(parseInboxReasons(url)).toEqual(new Set(["direct_message", "invocation"]));
  });

  test("routes delivery attempts to invocation subscribers through the delivery record", () => {
    const relatedDelivery = delivery({ id: "delivery-1", invocationId: "invocation-1" });
    const event = {
      kind: "delivery.attempted",
      payload: {
        attempt: {
          id: "attempt-1",
          deliveryId: relatedDelivery.id,
          attempt: 1,
          status: "sent",
          createdAt: 10,
        },
      },
    } as ControlEvent;

    expect(invocationIdsForEvent(event, {
      findDeliveryById: (deliveryId) => deliveryId === relatedDelivery.id ? relatedDelivery : undefined,
    })).toEqual(["invocation-1"]);
  });

  test("streams invocation snapshots and cleans up subscribers on close", () => {
    const { service } = createService();
    const request = new FakeRequest();
    const response = new FakeResponse();

    service.addInvocationStream({
      request: request as never,
      response: response as never,
      invocationId: "invocation-1",
      snapshot: { invocationId: "invocation-1" },
    });

    expect(response.status).toBe(200);
    expect(response.headers?.["content-type"]).toBe("text/event-stream");
    expect(response.body()).toContain("event: snapshot");
    expect(service.invocationSubscriberCount("invocation-1")).toBe(1);

    request.emit("close");

    expect(service.invocationSubscriberCount("invocation-1")).toBe(0);
    expect(response.ended).toBe(true);
  });

  test("fans control events to global, invocation, and inbox subscribers", () => {
    const relatedDelivery = delivery({ invocationId: "invocation-1" });
    const { enqueuedEvents, service } = createService({
      deliveries: [relatedDelivery],
      messages: [message()],
      invocations: [invocation()],
    });
    const eventRequest = new FakeRequest();
    const eventResponse = new FakeResponse();
    const invocationRequest = new FakeRequest();
    const invocationResponse = new FakeResponse();
    const inboxRequest = new FakeRequest();
    const inboxResponse = new FakeResponse();

    service.addEventStream({
      request: eventRequest as never,
      response: eventResponse as never,
      hello: { nodeId: "node-1" },
    });
    service.addInvocationStream({
      request: invocationRequest as never,
      response: invocationResponse as never,
      invocationId: "invocation-1",
      snapshot: { invocationId: "invocation-1" },
    });
    service.addInboxStream({
      request: inboxRequest as never,
      response: inboxResponse as never,
      targetId: "agent-1",
      snapshot: { targetId: "agent-1", items: [] },
    });

    const event = {
      kind: "delivery.planned",
      payload: {
        delivery: relatedDelivery,
      },
    } as ControlEvent;
    service.streamEvent(event);

    expect(enqueuedEvents).toEqual([event]);
    expect(eventResponse.body()).toContain("event: delivery.planned");
    expect(invocationResponse.body()).toContain("event: delivery.planned");
    expect(inboxResponse.body()).toContain("event: inbox.item");
    expect(inboxResponse.body()).toContain("\"conversationId\":\"conversation-1\"");
  });

  test("keeps event and invocation streams alive without touching inbox streams", () => {
    const { service } = createService();
    const eventResponse = new FakeResponse();
    const invocationResponse = new FakeResponse();
    const inboxResponse = new FakeResponse();

    service.addEventStream({
      request: new FakeRequest() as never,
      response: eventResponse as never,
      hello: {},
    });
    service.addInvocationStream({
      request: new FakeRequest() as never,
      response: invocationResponse as never,
      invocationId: "invocation-1",
      snapshot: {},
    });
    service.addInboxStream({
      request: new FakeRequest() as never,
      response: inboxResponse as never,
      targetId: "agent-1",
      snapshot: {},
    });

    service.streamKeepAlive();

    expect(eventResponse.body()).toContain(": keepalive");
    expect(invocationResponse.body()).toContain(": keepalive");
    expect(inboxResponse.body()).not.toContain(": keepalive");
  });
});
