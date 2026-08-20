import type {
  ConversationDefinition,
  MessageRecord,
  ScoutOperatorSignal,
} from "@openscout/protocol";

import type {
  MobilePushAlert,
  MobilePushBroadcastResult,
} from "./mobile-push.js";

export type OperatorDeliveryIssueKind = "unassigned_scout" | "rejected" | "unavailable";

export type OperatorDeliveryIssueInput = {
  kind: OperatorDeliveryIssueKind;
  requestId: string;
  requesterId: string;
  requesterNodeId: string;
  targetLabel: string;
  detail: string;
  originConversationId?: string;
  originMessageId?: string;
};

export type OperatorSignalInput = {
  signal: ScoutOperatorSignal;
  messageId: string;
  conversationId: string;
  requesterId: string;
  requesterNodeId: string;
};

export type BrokerOperatorAttentionServiceOptions = {
  nodeId: string;
  systemActorId: string;
  operatorActorId: string;
  createId: (prefix: string) => string;
  ensureBrokerActorForDelivery: (actorId: string) => Promise<void>;
  ensureBrokerDeliveryConversation: (input: {
    requesterId: string;
    targetAgentId?: string;
    channel?: string;
  }) => Promise<ConversationDefinition>;
  conversationById?: (conversationId: string) => ConversationDefinition | undefined;
  messageVisibilityForConversation: (conversation?: ConversationDefinition) => MessageRecord["visibility"];
  postConversationMessage: (message: MessageRecord) => Promise<unknown>;
  broadcastApnsAlertToActiveMobileDevices: (
    alert: MobilePushAlert,
  ) => Promise<MobilePushBroadcastResult>;
  warn?: (message: string) => void;
  now?: () => number;
};

export class BrokerOperatorAttentionService {
  private loggedMissingOperatorApnsCredentials = false;

  constructor(private readonly options: BrokerOperatorAttentionServiceOptions) {}

  queueDeliveryIssue(input: OperatorDeliveryIssueInput): void {
    void this.recordDeliveryIssue(input).catch((error) => {
      this.options.warn?.(
        `[openscout-runtime] failed to notify operator about delivery issue: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  queueOperatorSignal(input: OperatorSignalInput): void {
    if (input.requesterId === this.options.operatorActorId) {
      return;
    }

    void this.sendOperatorSignalAlert(input).catch((error) => {
      this.options.warn?.(
        `[openscout-runtime] failed to notify operator about agent signal: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  async sendOperatorSignalAlert(input: OperatorSignalInput): Promise<void> {
    const signal = input.signal;
    // A `need` is blocking, so it is the one signal that earns an interrupt and
    // a sound. It also carries its own body: the agent authored a question, and
    // "Open Scout for details" on top of a real question is how an alert ends up
    // saying nothing. notify/consult keep the quiet generic copy — they have no
    // authored text to show.
    const isNeed = signal.kind === "need";
    const result = await this.options.broadcastApnsAlertToActiveMobileDevices({
      title: isNeed
        ? "An agent needs you"
        : signal.kind === "consult"
          ? "An agent would value your input"
          : "Agent update",
      body: isNeed ? signal.question : "Open Scout for details.",
      sound: isNeed ? "default" : null,
      urgency: isNeed ? "interrupt" : "silent",
      threadId: "scout.agent-signal",
      payload: {
        destination: "inbox",
        itemId: input.messageId,
        kind: "operator_signal",
        signalKind: input.signal.kind,
        messageId: input.messageId,
        conversationId: input.conversationId,
        requesterId: input.requesterId,
        requesterNodeId: input.requesterNodeId,
      },
    });

    this.warnForBroadcastResult(result);
  }

  async recordDeliveryIssue(input: OperatorDeliveryIssueInput): Promise<void> {
    await this.recordOriginDeliveryIssue(input);

    // The originating conversation already tells the operator the truth. The
    // system lane exists to draw operator attention to failures reported by
    // other actors; duplicating the operator's own failure there is noise.
    if (input.requesterId === this.options.operatorActorId) {
      return;
    }

    await this.options.ensureBrokerActorForDelivery(this.options.operatorActorId);
    const conversation = await this.options.ensureBrokerDeliveryConversation({
      requesterId: this.options.systemActorId,
      channel: "system",
    });
    const itemId = `delivery:${input.requestId}`;
    const messageId = this.options.createId("msg");
    const targetLabel = input.targetLabel.trim() || "Scout";
    const detail = input.detail.trim();

    await this.options.postConversationMessage({
      id: messageId,
      conversationId: conversation.id,
      actorId: this.options.systemActorId,
      originNodeId: this.options.nodeId,
      class: "system",
      body: detail,
      audience: {
        notify: [this.options.operatorActorId],
        reason: "mention",
      },
      visibility: this.options.messageVisibilityForConversation(conversation),
      policy: "durable",
      createdAt: this.now(),
      metadata: {
        source: "broker",
        operatorAttention: "delivery_issue",
        deliveryIssueKind: input.kind,
        requestId: input.requestId,
        requesterId: input.requesterId,
        requesterNodeId: input.requesterNodeId,
        targetLabel,
        itemId,
      },
    });

    const result = await this.options.broadcastApnsAlertToActiveMobileDevices({
      title: "Scout delivery needs attention",
      body: "Open Scout for details.",
      sound: "default",
      urgency: "interrupt",
      threadId: "scout.delivery",
      payload: {
        destination: "inbox",
        itemId,
        kind: "delivery_issue",
        messageId,
        conversationId: conversation.id,
        requestId: input.requestId,
        requesterId: input.requesterId,
        requesterNodeId: input.requesterNodeId,
        targetLabel,
        reason: input.kind,
      },
    });

    this.warnForBroadcastResult(result);
  }

  private async recordOriginDeliveryIssue(input: OperatorDeliveryIssueInput): Promise<void> {
    const conversationId = input.originConversationId?.trim();
    const replyToMessageId = input.originMessageId?.trim();
    if (!conversationId || !replyToMessageId) return;

    const conversation = this.options.conversationById?.(conversationId);
    if (!conversation) return;

    await this.options.postConversationMessage({
      id: this.options.createId("msg"),
      conversationId,
      actorId: this.options.systemActorId,
      originNodeId: this.options.nodeId,
      class: "status",
      body: input.detail.trim(),
      replyToMessageId,
      audience: {
        notify: [input.requesterId],
        reason: "mention",
      },
      visibility: this.options.messageVisibilityForConversation(conversation),
      policy: "durable",
      createdAt: this.now(),
      metadata: {
        source: "broker",
        routingState: "failed",
        deliveryIssueKind: input.kind,
        requestId: input.requestId,
        requesterId: input.requesterId,
        requesterNodeId: input.requesterNodeId,
        targetLabel: input.targetLabel.trim() || "Scout",
      },
    });
  }

  private warnForBroadcastResult(result: MobilePushBroadcastResult): void {
    if (result.configMissing && !this.loggedMissingOperatorApnsCredentials) {
      this.loggedMissingOperatorApnsCredentials = true;
      this.options.warn?.("[openscout-runtime] mobile push credentials are missing; operator attention was recorded without APNS.");
    }
    if (result.rateLimited) {
      this.options.warn?.(
        `[openscout-runtime] push relay rate-limited (${result.rateLimitWindow ?? "unknown"}); retry in ${result.retryAfterSeconds ?? "?"}s.`,
      );
    }
    for (const failure of result.failures) {
      this.options.warn?.(
        `[openscout-runtime] failed to send operator delivery issue push to ${failure.deviceId} (${failure.tokenSuffix}): ${failure.reason ?? failure.status ?? "unknown"}`,
      );
    }
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}
