import type {
  ControlEvent,
  DeliveryAttempt,
  DeliveryIntent,
  DeliveryReason,
  DeliveryStatus,
  DurableAction,
  DurableActionHeartbeatInput,
} from "@openscout/protocol";

import type { BrokerJournalEntry } from "./broker-journal.js";

type DurableStore = {
  runWrite<T>(work: () => Promise<T>): Promise<T>;
  commitEntries(
    entries: BrokerJournalEntry | BrokerJournalEntry[],
    applyRuntime: (entries: BrokerJournalEntry[]) => Promise<void>,
    options?: { enqueueProjection?: boolean },
  ): Promise<BrokerJournalEntry[]>;
};

type DeliveryJournal = {
  getDelivery(deliveryId: string): DeliveryIntent | undefined;
  findDelivery(predicate: (delivery: DeliveryIntent) => boolean, options?: { activeOnly?: boolean }): DeliveryIntent | undefined;
  getDurableAction(actionId: string): DurableAction | null | undefined;
};

export type DeliveryStatusUpdateInput = {
  deliveryId: string;
  status: DeliveryIntent["status"];
  metadata?: Record<string, unknown>;
  leaseOwner?: string | null;
  leaseExpiresAt?: number | null;
  expectedLeaseOwner?: string;
  requireActiveLease?: boolean;
};

export type DeliveryClaimInput = {
  itemId?: string;
  messageId?: string;
  targetId: string;
  reasons?: DeliveryReason[];
  leaseOwner?: string;
  leaseMs?: number;
};

export type BrokerDeliveryStoreOptions = {
  journal: DeliveryJournal;
  durableStore: DurableStore;
  nodeId: string;
  createEventId: () => string;
  publishEvent: (event: ControlEvent) => void;
};

export function isDeliveryClaimable(delivery: DeliveryIntent, now: number): boolean {
  if (delivery.status === "pending" || delivery.status === "accepted" || delivery.status === "deferred") {
    return true;
  }
  return delivery.status === "leased"
    && typeof delivery.leaseExpiresAt === "number"
    && delivery.leaseExpiresAt <= now;
}

export class BrokerDeliveryStore {
  constructor(private readonly options: BrokerDeliveryStoreOptions) {}

  readonly recordDelivery = async (delivery: DeliveryIntent): Promise<void> => {
    await this.options.durableStore.runWrite(async () => {
      await this.options.durableStore.commitEntries(
        { kind: "deliveries.record", deliveries: [delivery] },
        async () => {},
      );
    });
  };

  readonly recordDeliveryAttempt = async (attempt: DeliveryAttempt): Promise<void> => {
    await this.options.durableStore.runWrite(async () => {
      await this.options.durableStore.commitEntries(
        {
          kind: "delivery.attempt.record",
          attempt,
        },
        async () => {},
      );
    });
  };

  readonly heartbeatDurableAction = async (
    input: DurableActionHeartbeatInput,
  ): Promise<DurableAction | null> => {
    return this.options.durableStore.runWrite(async () => {
      const current = this.options.journal.getDurableAction(input.actionId);
      if (
        !current
        || current.leaseOwner !== input.owner
        || current.leaseGeneration !== input.generation
        || current.state === "completed"
        || current.state === "failed"
        || current.state === "cancelled"
      ) {
        return null;
      }
      const heartbeat = {
        ...current,
        leaseExpiresAt: input.heartbeatAt + input.leaseMs,
        updatedAt: input.heartbeatAt,
      };
      await this.options.durableStore.commitEntries(
        { kind: "durable.action.heartbeat", input },
        async () => {},
      );
      return heartbeat;
    });
  };

  readonly updateDeliveryStatus = async (input: DeliveryStatusUpdateInput): Promise<void> => {
    await this.updateDeliveryStatusIf(input, () => true, true);
  };

  /** Internal conditional update; eligibility is checked under the canonical writer. */
  readonly updateDeliveryStatusIf = async (
    input: DeliveryStatusUpdateInput,
    eligible: (current: DeliveryIntent) => boolean | Promise<boolean>,
    allowMissing = false,
  ): Promise<boolean> => {
    return this.options.durableStore.runWrite(async () => {
      const previous = this.options.journal.getDelivery(input.deliveryId);
      if ((!previous && !allowMissing) || (previous && !await eligible(previous))) return false;
      if (input.expectedLeaseOwner || input.requireActiveLease) {
        if (!previous) {
          throw new Error("delivery not found");
        }
        const now = Date.now();
        if (
          previous.status !== "leased"
          || !previous.leaseOwner
          || previous.leaseOwner !== input.expectedLeaseOwner
          || typeof previous.leaseExpiresAt !== "number"
          || previous.leaseExpiresAt <= now
        ) {
          throw new Error("delivery lease is missing, expired, or owned by another worker");
        }
      }

      await this.options.durableStore.commitEntries(
        {
          kind: "delivery.status.update",
          deliveryId: input.deliveryId,
          status: input.status,
          metadata: input.metadata,
          leaseOwner: input.leaseOwner,
          leaseExpiresAt: input.leaseExpiresAt,
        },
        async () => {},
      );
      const updated = this.options.journal.getDelivery(input.deliveryId);
      if (updated) this.publishDeliveryChanged(updated, previous?.status);
      return Boolean(updated);
    });
  };

  readonly claimDelivery = async (input: DeliveryClaimInput): Promise<DeliveryIntent | null> => {
    let previousStatus: DeliveryStatus | undefined;
    const claimed = await this.options.durableStore.runWrite(async () => {
      const now = Date.now();
      const reasons = input.reasons?.length ? new Set(input.reasons) : null;
      const matches = (candidate: DeliveryIntent) => (
          (!input.itemId || candidate.id === input.itemId)
          && (!input.messageId || candidate.messageId === input.messageId)
          && candidate.targetId === input.targetId
          && (!reasons || reasons.has(candidate.reason))
          && isDeliveryClaimable(candidate, now)
        );
      const exact = input.itemId ? this.options.journal.getDelivery(input.itemId) : undefined;
      const delivery = input.itemId
        ? (exact && matches(exact) ? exact : undefined)
        : this.options.journal.findDelivery(matches, { activeOnly: true });

      if (!delivery) {
        return null;
      }
      previousStatus = delivery.status;

      const leaseOwner = input.leaseOwner?.trim() || `delivery-claim-${this.options.nodeId}`;
      const leaseMs = Number.isFinite(input.leaseMs) && input.leaseMs! > 0 ? input.leaseMs! : 30_000;
      const leaseExpiresAt = now + leaseMs;
      const metadata = {
        claimedAt: now,
        claimedBy: leaseOwner,
      };

      await this.options.durableStore.commitEntries(
        {
          kind: "delivery.status.update",
          deliveryId: delivery.id,
          status: "leased",
          leaseOwner,
          leaseExpiresAt,
          metadata,
        },
        async () => {},
      );

      return {
        ...delivery,
        status: "leased" as const,
        leaseOwner,
        leaseExpiresAt,
        metadata: {
          ...(delivery.metadata ?? {}),
          ...metadata,
        },
      };
    });
    if (claimed) {
      this.publishDeliveryChanged(claimed, previousStatus);
    }
    return claimed;
  };

  private publishDeliveryChanged(delivery: DeliveryIntent, previousStatus: DeliveryStatus | undefined): void {
    this.options.publishEvent({
      id: this.options.createEventId(),
      kind: "delivery.state.changed",
      ts: Date.now(),
      actorId: "system",
      nodeId: this.options.nodeId,
      payload: {
        delivery,
        previousStatus,
      },
    });
  }
}
