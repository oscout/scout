import {
  AckPolicy,
  DeliverPolicy,
  type ConsumerConfig,
  type ConsumerInfo,
  type JsMsg,
} from "@nats-io/jetstream";

import type { ScoutJetStreamConnection } from "./connection.js";
import {
  decodeScoutStreamEvent,
  jetStreamFilterSubject,
  SCOUT_STREAM_EVENT_KINDS,
  type ScoutStreamEvent,
  type ScoutStreamEventKind,
} from "./events.js";

/**
 * One event handed to a consumer, with acknowledgement still in the caller's
 * hands. An unacked delivery is redelivered after `ackWaitMs`; that is the
 * recovery contract, so the API refuses to hide it behind an implicit ack
 * unless the caller opts in with `autoAck`.
 */
export type ScoutStreamDelivery = {
  event: ScoutStreamEvent;
  streamSeq: number;
  /** 1 on first delivery; higher after an ack-wait expiry. */
  deliveryCount: number;
  ack(): void;
  nak(delayMs?: number): void;
  term(): void;
};

/**
 * Per-event authorization, evaluated at delivery time against current state.
 *
 * Deliberately not a subject-encoded grant: membership can be revoked after an
 * event is already sitting in the stream, and only a delivery-time check can
 * withhold a replay of it.
 */
export type ScoutStreamAuthorizer = (event: ScoutStreamEvent) => boolean | Promise<boolean>;

export type ScoutStreamIterationOptions = {
  /** Stops this iteration without closing the consumer. */
  signal?: AbortSignal;
};

export type ScoutEventConsumerOptions = {
  connection: ScoutJetStreamConnection;
  /**
   * Durable name. Omitted means an ephemeral consumer that only lives as long
   * as this process holds it — the right shape for one browser stream.
   */
  durableName?: string;
  deliver?: "new" | "all";
  conversationIds?: string[];
  kinds?: ScoutStreamEventKind[];
  publisherNodeId?: string;
  ackWaitMs?: number;
  maxDeliver?: number;
  maxAckPending?: number;
  inactiveThresholdMs?: number;
  autoAck?: boolean;
  authorize?: ScoutStreamAuthorizer;
  warn?: (message: string, detail?: unknown) => void;
};

export type ScoutEventConsumer = {
  name: string;
  info(): Promise<ConsumerInfo>;
  /**
   * Iterate deliveries until the signal aborts or the consumer closes.
   *
   * The signal is the only way to stop waiting mid-poll. An async generator's
   * `return()` queues behind a pending `next()` rather than interrupting it, so
   * a caller that stops reading while no event is in flight — a browser that
   * closed its SSE connection, a reader with a deadline — would otherwise block
   * until the next event happens to arrive. Aborting leaves the consumer itself
   * open and re-iterable; `close()` is what ends it.
   */
  events(options?: ScoutStreamIterationOptions): AsyncGenerator<ScoutStreamDelivery>;
  close(): Promise<void>;
  /** Delete the durable/ephemeral consumer server-side. Tests and teardown. */
  destroy(): Promise<void>;
};

/**
 * An explicitly empty selector is a bug, not a wildcard.
 *
 * `conversationIds: []` from a caller that resolved zero authorized
 * conversations must never widen into "every conversation on this machine".
 * Absent means unfiltered; empty means nothing was selected, and that is an error.
 */
function filterSubjectsFor(options: ScoutEventConsumerOptions, prefix: string): string[] {
  if (options.conversationIds && options.conversationIds.length === 0) {
    throw new Error(
      "openScoutEventConsumer: conversationIds was provided but empty. "
        + "Omit it to consume every conversation; an empty list selects nothing.",
    );
  }
  if (options.kinds && options.kinds.length === 0) {
    throw new Error(
      "openScoutEventConsumer: kinds was provided but empty. "
        + "Omit it to consume every supported kind; an empty list selects nothing.",
    );
  }
  const kinds = options.kinds ?? SCOUT_STREAM_EVENT_KINDS;
  const conversations: Array<string | undefined> = options.conversationIds ?? [undefined];
  const subjects = new Set<string>();
  for (const kind of kinds) {
    for (const conversationId of conversations) {
      subjects.add(jetStreamFilterSubject({
        prefix,
        publisherNodeId: options.publisherNodeId,
        kind,
        conversationId,
      }));
    }
  }
  return [...subjects];
}

/**
 * Open an independent durable (or ephemeral) consumer over the Scout event
 * stream.
 *
 * "Independent" is the point: each consumer carries its own server-side
 * position, so an agent adapter, a Slack adapter, and a browser stream each
 * receive every matching event and one acking does not advance another.
 *
 * The NATS connection stays on this side of the boundary. A caller exposing
 * events to a browser must pass `authorize`; nothing here ever surfaces a
 * server URL, credential, or subject to a client.
 */
export async function openScoutEventConsumer(
  options: ScoutEventConsumerOptions,
): Promise<ScoutEventConsumer> {
  const { connection } = options;
  await connection.ensureStreamOnce();
  const jsm = await connection.manager();
  const js = await connection.client();
  const streamName = connection.config.streamName;

  const config: Partial<ConsumerConfig> = {
    ...connection.baseConsumerConfig(),
    ack_policy: AckPolicy.Explicit,
    deliver_policy: options.deliver === "all" ? DeliverPolicy.All : DeliverPolicy.New,
    filter_subjects: filterSubjectsFor(options, connection.config.subjectPrefix),
    ack_wait: (options.ackWaitMs ?? 30_000) * 1_000_000,
    max_deliver: options.maxDeliver ?? 5,
    max_ack_pending: options.maxAckPending ?? 512,
  };
  if (options.durableName) {
    config.durable_name = options.durableName;
  } else {
    // An ephemeral consumer must not outlive the process that opened it.
    config.inactive_threshold = (options.inactiveThresholdMs ?? 60_000) * 1_000_000;
  }

  const created = await jsm.consumers.add(streamName, config);
  const name = created.name;
  const consumer = await js.consumers.get(streamName, name);

  type MessageStream = Awaited<ReturnType<typeof consumer.consume>>;
  const active = new Set<MessageStream>();
  let closed = false;

  const stopAll = (): void => {
    for (const stream of active) stream.stop();
    active.clear();
  };

  const toDelivery = (msg: JsMsg, event: ScoutStreamEvent): ScoutStreamDelivery => ({
    event,
    streamSeq: msg.seq,
    deliveryCount: msg.info.deliveryCount,
    ack: () => msg.ack(),
    nak: (delayMs?: number) => msg.nak(delayMs),
    term: () => msg.term(),
  });

  async function* events(
    iteration: ScoutStreamIterationOptions = {},
  ): AsyncGenerator<ScoutStreamDelivery> {
    // `close()` or an abort can land during any of the awaits below — a browser
    // dropping its SSE connection mid-authorization is the ordinary case — so
    // both are rechecked after each one, and the stream is always stopped on exit.
    const { signal } = iteration;
    if (closed || signal?.aborted) return;
    const messages = await consumer.consume();
    active.add(messages);
    // Stopping the underlying stream is what unblocks a pending read; the
    // generator then finishes on its own and its `finally` runs.
    const onAbort = () => messages.stop();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (closed || signal?.aborted) return;
      for await (const msg of messages) {
        if (closed || signal?.aborted) return;
        const event = decodeScoutStreamEvent(msg.data);
        if (!event) {
          // Never redeliver a payload we cannot parse; it will never parse.
          options.warn?.(`[openscout-jetstream] terminating unparseable message seq=${msg.seq}`);
          msg.term();
          continue;
        }
        if (options.authorize) {
          let allowed = false;
          try {
            allowed = await options.authorize(event);
          } catch (error) {
            options.warn?.("[openscout-jetstream] authorization check failed", error);
            // Fail closed, and let ack-wait retry rather than dropping silently.
            if (!closed) msg.nak(1_000);
            continue;
          }
          if (closed || signal?.aborted) return;
          if (!allowed) {
            // Withheld, not lost: consumed for this subscriber's position and
            // never surfaced. Another consumer with its own position is unaffected.
            msg.ack();
            continue;
          }
        }
        yield toDelivery(msg, event);
        if (options.autoAck && !closed) msg.ack();
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      active.delete(messages);
      messages.stop();
    }
  }

  return {
    name,
    info: () => consumer.info(),
    events,
    close: async () => {
      closed = true;
      stopAll();
    },
    destroy: async () => {
      closed = true;
      stopAll();
      await jsm.consumers.delete(streamName, name).catch(() => undefined);
    },
  };
}

/**
 * In-memory, bounded suppression of repeated event ids.
 *
 * JetStream's `Nats-Msg-Id` dedupe is a finite time window, so a redelivery or
 * a crash-recovery republish outside that window reaches the consumer twice.
 * This collapses those repeats for a *process-local, non-durable* consumer —
 * an SSE invalidation stream, a test adapter — and nothing more. It forgets
 * everything on restart and evicts its oldest entries at capacity.
 *
 * It is explicitly **not** side-effect idempotency. An adapter that writes,
 * pays, notifies, or dispatches must key its own transactional idempotency on
 * `event.eventId`; this class cannot make that safe.
 */
export class ScoutStreamDeduplicator {
  private readonly seen = new Map<string, number>();

  constructor(private readonly capacity = 4_096) {}

  /** True the first time an event id is observed, false for a repeat. */
  admit(eventId: string): boolean {
    if (this.seen.has(eventId)) return false;
    this.seen.set(eventId, Date.now());
    if (this.seen.size > this.capacity) {
      const oldest = this.seen.keys().next();
      if (!oldest.done) this.seen.delete(oldest.value);
    }
    return true;
  }

  get size(): number {
    return this.seen.size;
  }
}
