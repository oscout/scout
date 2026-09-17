/**
 * OpenScout ⇄ NATS JetStream — first implementation slice.
 *
 * Supported here: a locally managed, opt-in, loopback-only JetStream sidecar;
 * durable recoverable publication of `message.posted` from the canonical broker
 * journal; and independent durable/ephemeral consumers with delivery-time
 * authorization.
 *
 * Deliberately *not* here: subscription records, destination adapters, broker
 * federation, Slack, webhooks, resource scopes other than conversations, and
 * any kind other than `message.posted`. See
 * `docs/eng/jetstream-first-slice.md` for the supported/deferred ledger.
 *
 * Delivery is at-least-once, bounded by retention and consumer retry policy.
 * Server-side duplicate suppression has a finite window. No exactly-once or
 * global-ordering guarantee is offered.
 */
export {
  JETSTREAM_DEFAULT_STREAM,
  JETSTREAM_STREAM_OWNER_TAG,
  JETSTREAM_SUBJECT_PREFIX,
  assertLoopbackJetStreamHost,
  jetStreamMonitorUrl,
  jetStreamServerUrl,
  resolveJetStreamConfig,
  type JetStreamRuntimeConfig,
  type JetStreamStartPosition,
} from "./config.js";

export {
  SCOUT_STREAM_EVENT_KINDS,
  decodeScoutStreamEvent,
  encodeScoutStreamEvent,
  jetStreamFilterSubject,
  jetStreamStreamSubjects,
  jetStreamSubject,
  jetStreamToken,
  messagePostedStreamEvent,
  scoutStreamEventId,
  type ScoutStreamEvent,
  type ScoutStreamEventKind,
  type ScoutStreamMessageSummary,
} from "./events.js";

export {
  JetStreamStreamOwnershipError,
  ScoutJetStreamConnection,
  type JetStreamConnectionOptions,
  type JetStreamPublishReceipt,
} from "./connection.js";

export {
  JetStreamBinaryMissingError,
  JetStreamPortOccupiedError,
  NatsJetStreamSidecar,
  probeTcpPort,
  resolveNatsServerBinary,
  type JetStreamSidecarOptions,
} from "./sidecar.js";

export {
  JETSTREAM_PUBLISHER_PROJECTION_ID,
  JETSTREAM_PUBLISHER_PROJECTION_VERSION,
  JetStreamJournalPublisher,
  isPublishableEntry,
  readJetStreamPublisherProgress,
  streamEventForEntry,
  type JetStreamPublisherJournal,
  type JetStreamPublisherOptions,
  type JetStreamPublisherStatus,
} from "./publisher.js";

export {
  ScoutStreamDeduplicator,
  openScoutEventConsumer,
  type ScoutEventConsumer,
  type ScoutEventConsumerOptions,
  type ScoutStreamAuthorizer,
  type ScoutStreamDelivery,
  type ScoutStreamIterationOptions,
} from "./consumer.js";

export {
  BrokerJetStreamService,
  type BrokerJetStreamServiceOptions,
  type BrokerJetStreamStatus,
} from "./service.js";
