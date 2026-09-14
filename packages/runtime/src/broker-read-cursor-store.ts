import { readRuntimeMessage } from "./broker-message-records.js";
import { selectMessageRecordsAsync } from "./broker-message-records.js";
import type {
  ConversationDefinition,
  ConversationReadCursor,
  DeliveryIntent,
  MessageRecord,
} from "@openscout/protocol";

import type { BrokerJournalEntry } from "./broker-journal.js";
import type { DeliveryStatusUpdateInput } from "./broker-delivery-store.js";

type DurableStore = {
  runWrite<T>(work: () => Promise<T>): Promise<T>;
  commitEntries(
    entries: BrokerJournalEntry | BrokerJournalEntry[],
    applyRuntime: (entries: BrokerJournalEntry[]) => Promise<void>,
    options?: { enqueueProjection?: boolean },
  ): Promise<BrokerJournalEntry[]>;
};

type ReadCursorRuntime = {
  snapshot(): {
    messages: Record<string, MessageRecord>;
    readCursors: Record<string, ConversationReadCursor>;
  };
  conversation(conversationId: string): ConversationDefinition | undefined;
  message(messageId: string): MessageRecord | undefined;
  readMessage?(messageId:string):Promise<MessageRecord|undefined>;
  readCursor(conversationId: string, actorId: string): ConversationReadCursor | undefined;
  upsertReadCursor(cursor: ConversationReadCursor): Promise<void>;
};

type ReadCursorProjection = {
  latestThreadSeq(conversationId: string): Promise<number>;

};

export type ReadCursorResolveInput = {
  actorId?: string;
  readerNodeId?: string;
  lastReadMessageId?: string;
  lastReadSeq?: number;
  lastReadAt?: number;
  metadata?: Record<string, unknown>;
};

export type BrokerReadCursorStoreOptions = {
  runtime: ReadCursorRuntime;
  projection: ReadCursorProjection;
  durableStore: DurableStore;
  operatorActorId: string;
  nodeId: string;
  ensureActor: (actorId: string) => Promise<void>;
  journal: { visitDeliveries(visitor: (delivery: DeliveryIntent) => void | Promise<void>, options?: { activeOnly?: boolean }): Promise<void> };
  updateDeliveryStatusIf: (
    input: DeliveryStatusUpdateInput,
    eligible: (current: DeliveryIntent) => boolean | Promise<boolean>,
  ) => Promise<boolean>;
};

function finitePositiveNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

const readableDeliveryStatuses = new Set<DeliveryIntent["status"]>([
  "pending",
  "accepted",
  "deferred",
  "sent",
]);

const readDeliveryReasons = new Set<DeliveryIntent["reason"]>([
  "conversation_visibility",
  "direct_message",
  "mention",
  "thread_reply",
]);

export class BrokerReadCursorStore {
  constructor(private readonly options: BrokerReadCursorStoreOptions) {}

  readonly listForConversation = (conversationId: string): ConversationReadCursor[] => {
    return Object.values(this.options.runtime.snapshot().readCursors)
      .filter((cursor) => cursor.conversationId === conversationId)
      .sort((left, right) => right.updatedAt - left.updatedAt);
  };

  readonly resolve = async (
    conversationId: string,
    input: ReadCursorResolveInput,
  ): Promise<ConversationReadCursor> => {
    const conversation = this.options.runtime.conversation(conversationId);
    if (!conversation) {
      throw new Error(`conversation ${conversationId} not found`);
    }

    const actorId = input.actorId?.trim() || this.options.operatorActorId;
    await this.options.ensureActor(actorId);

    const explicitMessageId = input.lastReadMessageId?.trim();
    const lastReadMessage = explicitMessageId
      ? await readRuntimeMessage(this.options.runtime,explicitMessageId)
      : await this.latestMessageForConversation(conversationId);

    if (explicitMessageId && !lastReadMessage) {
      throw new Error(`message ${explicitMessageId} not found`);
    }
    if (lastReadMessage && lastReadMessage.conversationId !== conversationId) {
      throw new Error(`message ${lastReadMessage.id} does not belong to ${conversationId}`);
    }

    const latestThreadSeq = await this.options.projection.latestThreadSeq(conversationId);
    const providedSeq = finitePositiveNumber(input.lastReadSeq);
    let lastReadSeq = providedSeq
      ?? (!explicitMessageId && latestThreadSeq > 0 ? latestThreadSeq : undefined);
    let lastReadAt = finitePositiveNumber(input.lastReadAt) ?? Date.now();
    let lastReadMessageId = lastReadMessage?.id;

    const current = this.options.runtime.readCursor(conversationId, actorId);
    if (current) {
      const currentRank = await this.cursorProgressRank(current);
      const nextRank = await this.cursorProgressRank({ lastReadSeq, lastReadMessageId });
      if (
        currentRank !== undefined
        && (nextRank === undefined || nextRank < currentRank)
      ) {
        lastReadMessageId = current.lastReadMessageId;
        lastReadSeq = current.lastReadSeq;
        lastReadAt = current.lastReadAt;
      }
    }

    return {
      conversationId,
      actorId,
      readerNodeId: input.readerNodeId?.trim() || this.options.nodeId,
      lastReadMessageId,
      lastReadSeq,
      lastReadAt,
      updatedAt: Date.now(),
      metadata: input.metadata,
    };
  };

  readonly record = async (cursor: ConversationReadCursor): Promise<void> => {
    await this.options.durableStore.runWrite(async () => {
      await this.options.durableStore.commitEntries(
        { kind: "conversation.read_cursor.upsert", cursor },
        async () => {
          await this.options.runtime.upsertReadCursor(cursor);
        },
      );
    });
  };

  readonly acknowledgeDeliveries = async (cursor: ConversationReadCursor): Promise<number> => {
    const boundaryMessage = cursor.lastReadMessageId
      ? await readRuntimeMessage(this.options.runtime,cursor.lastReadMessageId)
      : await this.latestMessageForConversation(cursor.conversationId);
    if (!boundaryMessage) {
      return 0;
    }

    let acknowledged = 0;

    const eligible = async (delivery: DeliveryIntent): Promise<boolean> => {
      if (delivery.targetId !== cursor.actorId || !delivery.messageId) return false;
      if (!readableDeliveryStatuses.has(delivery.status) || !readDeliveryReasons.has(delivery.reason)) return false;
      const message = await readRuntimeMessage(this.options.runtime,delivery.messageId);
      return Boolean(message && message.conversationId === cursor.conversationId
        && message.createdAt <= boundaryMessage.createdAt);
    };
    await this.options.journal.visitDeliveries(async (delivery) => {
      if (!await eligible(delivery)) return;
      const changed = await this.options.updateDeliveryStatusIf({
        deliveryId: delivery.id,
        status: "acknowledged",
        metadata: {
          acknowledgedByReadCursor: true,
          readAt: cursor.lastReadAt,
          readCursorUpdatedAt: cursor.updatedAt,
          readMessageId: cursor.lastReadMessageId,
        },
        leaseOwner: null,
        leaseExpiresAt: null,
      }, eligible);
      if (changed) acknowledged += 1;
    }, { activeOnly: true });

    return acknowledged;
  };

  private async latestMessageForConversation(conversationId: string): Promise<MessageRecord | undefined> {
    return (await selectMessageRecordsAsync(this.options.runtime.snapshot().messages ?? {}, 1,
      (left, right) => right.createdAt - left.createdAt,
      (message) => message.conversationId === conversationId,{selection:{conversationIds:[conversationId],newestFirst:true}}))[0];
  }

  private async messageCreatedAt(messageId: string | undefined): Promise<number | undefined> {
    return messageId ? (await readRuntimeMessage(this.options.runtime,messageId))?.createdAt : undefined;
  }

  private async cursorProgressRank(cursor: {
    lastReadSeq?: number;
    lastReadMessageId?: string;
  }): Promise<number | undefined> {
    if (typeof cursor.lastReadSeq === "number" && Number.isFinite(cursor.lastReadSeq)) {
      return cursor.lastReadSeq;
    }
    return this.messageCreatedAt(cursor.lastReadMessageId);
  }
}
