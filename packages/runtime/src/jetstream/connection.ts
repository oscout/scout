import { connect, type NatsConnection } from "@nats-io/transport-node";
import {
  AckPolicy,
  DeliverPolicy,
  DiscardPolicy,
  RetentionPolicy,
  StorageType,
  jetstream,
  jetstreamManager,
  type ConsumerConfig,
  type JetStreamClient,
  type JetStreamManager,
  type StreamConfig,
  type StreamInfo,
} from "@nats-io/jetstream";

import {
  JETSTREAM_STREAM_OWNER_TAG,
  jetStreamServerUrl,
  type JetStreamRuntimeConfig,
} from "./config.js";
import {
  encodeScoutStreamEvent,
  jetStreamStreamSubjects,
  type ScoutStreamEvent,
} from "./events.js";

export class JetStreamStreamOwnershipError extends Error {
  constructor(streamName: string, reason: string) {
    super(
      `JetStream stream "${streamName}" exists but is not owned by OpenScout: ${reason}.\n`
        + "OpenScout will not rewrite a stream it did not create. Choose a different "
        + "OPENSCOUT_JETSTREAM_STREAM or remove the conflicting stream deliberately.",
    );
    this.name = "JetStreamStreamOwnershipError";
  }
}

export type JetStreamPublishReceipt = {
  /** Stream sequence assigned by the server. */
  seq: number;
  /** True when the server collapsed this publish onto an existing `Nats-Msg-Id`. */
  duplicate: boolean;
  attempts: number;
};

export type JetStreamConnectionOptions = {
  config: JetStreamRuntimeConfig;
  name?: string;
  log?: (message: string, detail?: unknown) => void;
  warn?: (message: string, detail?: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * One NATS connection plus the stream this runtime owns.
 *
 * The broker holds one of these; an independent consumer process (the web
 * server) holds its own. Neither ever hands the connection, its URL, or any
 * credential to a browser.
 */
export class ScoutJetStreamConnection {
  private nc: NatsConnection | null = null;
  private js: JetStreamClient | null = null;
  private jsm: JetStreamManager | null = null;
  private streamReady = false;
  private closed = false;
  private connecting: Promise<void> | null = null;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: JetStreamConnectionOptions) {
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get config(): JetStreamRuntimeConfig {
    return this.options.config;
  }

  isConnected(): boolean {
    return Boolean(this.nc && !this.nc.isClosed());
  }

  async connect(): Promise<void> {
    if (this.closed) throw new Error("This JetStream connection has been closed.");
    if (this.isConnected()) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.connectInner();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async connectInner(): Promise<void> {
    const nc = await connect({
      servers: `${this.config.host}:${this.config.port}`,
      name: this.options.name ?? "openscout",
      timeout: this.config.connectTimeoutMs,
      maxReconnectAttempts: this.config.maxReconnectAttempts,
      reconnectTimeWait: this.config.reconnectTimeWaitMs,
      waitOnFirstConnect: false,
    });
    try {
      const js = jetstream(nc);
      const jsm = await jetstreamManager(nc);
      // close() can arrive during either network await. Never install a socket
      // into an already-closed owner, and keep partial contexts local until ready.
      if (this.closed) throw new Error("This JetStream connection has been closed.");
      this.nc = nc;
      this.js = js;
      this.jsm = jsm;
      this.streamReady = false;
    } catch (error) {
      await nc.close().catch(() => undefined);
      throw error;
    }
  }

  async client(): Promise<JetStreamClient> {
    await this.connect();
    if (!this.js) throw new Error("JetStream client unavailable.");
    return this.js;
  }

  async manager(): Promise<JetStreamManager> {
    await this.connect();
    if (!this.jsm) throw new Error("JetStream manager unavailable.");
    return this.jsm;
  }

  desiredStreamConfig(): Partial<StreamConfig> & { name: string } {
    return {
      name: this.config.streamName,
      subjects: jetStreamStreamSubjects(this.config.subjectPrefix),
      description: JETSTREAM_STREAM_OWNER_TAG,
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      discard: DiscardPolicy.Old,
      max_age: this.config.maxAgeMs * 1_000_000,
      max_bytes: this.config.maxBytes,
      duplicate_window: this.config.duplicateWindowMs * 1_000_000,
      num_replicas: 1,
    };
  }

  /**
   * Create the stream, or validate that an existing one is ours and correctly
   * shaped. Retention limits are reconciled; identity and subject coverage are
   * not silently taken over.
   */
  async ensureStream(): Promise<StreamInfo> {
    const jsm = await this.manager();
    const desired = this.desiredStreamConfig();
    let info: StreamInfo | null = null;
    try {
      info = await jsm.streams.info(this.config.streamName);
    } catch {
      info = null;
    }
    if (!info) {
      const created = await jsm.streams.add(desired);
      this.streamReady = true;
      return created;
    }
    if (info.config.description !== JETSTREAM_STREAM_OWNER_TAG) {
      throw new JetStreamStreamOwnershipError(
        this.config.streamName,
        `description is ${JSON.stringify(info.config.description ?? "")}, expected `
          + JSON.stringify(JETSTREAM_STREAM_OWNER_TAG),
      );
    }
    const expectedSubjects = jetStreamStreamSubjects(this.config.subjectPrefix);
    const missing = expectedSubjects.filter((subject) => !info!.config.subjects?.includes(subject));
    const next: Partial<StreamConfig> & { name: string } = { ...info.config, ...desired };
    if (missing.length > 0) {
      this.options.warn?.(
        `[openscout-jetstream] stream ${this.config.streamName} is missing subjects `
          + `${missing.join(", ")}; reconciling`,
      );
    }
    const updated = await jsm.streams.update(this.config.streamName, next);
    this.streamReady = true;
    return updated;
  }

  async ensureStreamOnce(): Promise<void> {
    if (this.streamReady && this.isConnected()) return;
    await this.ensureStream();
  }

  /**
   * Publish one event and wait for the server's acknowledgement.
   *
   * At-least-once by construction: a timed-out publish that actually landed is
   * retried, and the stable `Nats-Msg-Id` is what collapses the retry. No
   * exactly-once or global-order claim is made or implied.
   */
  async publishEvent(
    subject: string,
    event: ScoutStreamEvent,
  ): Promise<JetStreamPublishReceipt> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.config.publishMaxAttempts; attempt += 1) {
      try {
        await this.ensureStreamOnce();
        const js = await this.client();
        const ack = await js.publish(subject, encodeScoutStreamEvent(event), {
          msgID: event.eventId,
          // Fail loudly if the subject ever resolves onto a stream that is not ours.
          expect: { streamName: this.config.streamName },
          timeout: this.config.publishTimeoutMs,
        });
        return { seq: ack.seq, duplicate: Boolean(ack.duplicate), attempts: attempt };
      } catch (error) {
        lastError = error;
        if (error instanceof JetStreamStreamOwnershipError) throw error;
        this.streamReady = false;
        if (attempt >= this.config.publishMaxAttempts) break;
        const backoff = Math.min(
          this.config.publishTimeoutMs,
          100 * 2 ** (attempt - 1),
        ) + Math.floor(Math.random() * 100);
        await this.sleep(backoff);
      }
    }
    throw new Error(
      `JetStream publish failed after ${this.config.publishMaxAttempts} attempts `
        + `(${jetStreamServerUrl(this.config)} subject=${subject}): ${String(lastError)}`,
      { cause: lastError },
    );
  }

  /** Durable or ephemeral consumer config shared by every consumer we open. */
  baseConsumerConfig(): Partial<ConsumerConfig> {
    return {
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.New,
      max_ack_pending: 512,
    };
  }

  async drain(): Promise<void> {
    if (!this.nc || this.nc.isClosed()) return;
    await this.nc.drain().catch(() => undefined);
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.connecting?.catch(() => undefined);
    const nc = this.nc;
    this.nc = null;
    this.js = null;
    this.jsm = null;
    this.streamReady = false;
    if (!nc || nc.isClosed()) return;
    await nc.drain().catch(() => undefined);
    await nc.close().catch(() => undefined);
  }
}
