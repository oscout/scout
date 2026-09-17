import type { ScoutBrokerChildServiceSnapshot } from "../broker-api.js";
import type { BrokerJournalEntry } from "../broker-journal.js";
import { resolveJetStreamConfig, type JetStreamRuntimeConfig } from "./config.js";
import { ScoutJetStreamConnection } from "./connection.js";
import {
  JetStreamJournalPublisher,
  type JetStreamPublisherJournal,
  type JetStreamPublisherStatus,
} from "./publisher.js";
import { NatsJetStreamSidecar } from "./sidecar.js";

export type BrokerJetStreamServiceOptions = {
  config?: JetStreamRuntimeConfig;
  journal: JetStreamPublisherJournal;
  publisherNodeId: string;
  /** Provided so the broker can publish without owning the sidecar process. */
  manageSidecar?: boolean;
  log?: (message: string, detail?: unknown) => void;
  warn?: (message: string, detail?: unknown) => void;
  error?: (message: string, detail?: unknown) => void;
};

export type BrokerJetStreamStatus = ScoutBrokerChildServiceSnapshot & {
  publisher: JetStreamPublisherStatus | null;
};

/**
 * The broker's side of the JetStream slice: a connection and a durable
 * publisher, optionally with a sidecar it owns.
 *
 * Failure here is never fatal to the broker. Scout's journal remains the
 * canonical record; JetStream is a transport that can be absent, and the
 * service reports `unavailable` instead of refusing writes.
 *
 * The one thing it will not do on failure is connect anyway. When this service
 * owns the sidecar and the sidecar does not come up, it publishes nothing
 * rather than risk speaking to whatever else is listening on that port.
 */
export class BrokerJetStreamService {
  readonly config: JetStreamRuntimeConfig;
  private readonly sidecar: NatsJetStreamSidecar | null;
  private connection: ScoutJetStreamConnection | null = null;
  private publisher: JetStreamJournalPublisher | null = null;
  private startError: string | null = null;
  private starting: Promise<void> | null = null;

  constructor(private readonly options: BrokerJetStreamServiceOptions) {
    this.config = options.config ?? resolveJetStreamConfig();
    this.sidecar = options.manageSidecar
      ? new NatsJetStreamSidecar({
          config: this.config,
          log: options.log,
          warn: options.warn,
          error: options.error,
        })
      : null;
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Capture the source boundary before the broker admits any write.
   *
   * Network-free and fast. Awaiting it at startup is what keeps a first-enable
   * `now` position honest: every record accepted from here on is *after* the
   * committed barrier, so none of them can be skipped by a boundary placed
   * later, once the sidecar happens to become reachable.
   */
  async establishStartBoundary(): Promise<void> {
    if (!this.config.enabled) return;
    try {
      await this.ensurePublisher().establishStartBoundary();
    } catch (error) {
      this.startError = error instanceof Error ? error.message : String(error);
      this.options.error?.("[openscout-jetstream] start boundary failed", error);
    }
  }

  private ensurePublisher(): JetStreamJournalPublisher {
    if (!this.connection) {
      this.connection = new ScoutJetStreamConnection({
        config: this.config,
        name: `openscout-broker-${this.options.publisherNodeId}`,
        log: this.options.log,
        warn: this.options.warn,
      });
    }
    if (!this.publisher) {
      this.publisher = new JetStreamJournalPublisher({
        config: this.config,
        connection: this.connection,
        journal: this.options.journal,
        publisherNodeId: this.options.publisherNodeId,
        log: this.options.log,
        warn: this.options.warn,
        error: this.options.error,
      });
    }
    return this.publisher;
  }

  /** Never throws: a JetStream outage must not take the broker down with it. */
  async start(): Promise<void> {
    if (!this.config.enabled) return;
    if (this.starting) return this.starting;
    this.starting = this.startInner().catch((error) => {
      this.startError = error instanceof Error ? error.message : String(error);
      this.options.error?.("[openscout-jetstream] start failed", error);
    });
    return this.starting;
  }

  private async startInner(): Promise<void> {
    // Sidecar first so a healthy boot has a server to ack against, but never
    // fatally: an unavailable transport must not stop the broker.
    if (this.sidecar) {
      try {
        await this.sidecar.start();
      } catch (error) {
        this.startError = error instanceof Error ? error.message : String(error);
        this.options.error?.("[openscout-jetstream] sidecar start failed", error);
        // Stop here, deliberately. The usual reason an owned start fails is
        // that something else already holds the port, and the publisher's
        // first catch-up pass would open a connection to exactly that port —
        // adopting a NATS server OpenScout does not manage and creating
        // SCOUT_EVENTS inside it. Attaching to a foreign server is an explicit
        // operator decision (OPENSCOUT_JETSTREAM_MANAGE_SERVER=0), never a
        // fallback.
        //
        // Nothing is lost by stopping: the enable barrier was already committed
        // by establishStartBoundary() before the broker admitted any write, so
        // a restart after the port is freed resumes from it and republishes
        // everything accepted in between. The service reports unavailable and
        // the broker stays fully usable.
        this.ensurePublisher();
        return;
      }
    }

    // The publisher starts *before* any network round trip. If NATS is down at
    // boot, the enable barrier is still written, so a later restart resumes
    // from it instead of re-taking a `now` start position and silently skipping
    // every message accepted in between. The publisher's own checkpoint
    // interval retries publication while the transport is down.
    const publisher = this.ensurePublisher();
    const connection = this.connection!;
    await publisher.start();

    try {
      await connection.connect();
      await connection.ensureStream();
      this.startError = null;
      this.options.log?.(
        `[openscout-jetstream] publishing to ${this.config.streamName} `
          + `at ${connection.config.host}:${connection.config.port}`,
      );
    } catch (error) {
      // Degraded, not dead. Publication retries on the checkpoint interval.
      this.startError = error instanceof Error ? error.message : String(error);
      this.options.warn?.(
        "[openscout-jetstream] transport unavailable at startup; publisher will retry",
        error,
      );
    }
  }

  notifyCommitted(entries: BrokerJournalEntry[]): void {
    this.publisher?.notifyCommitted(entries);
  }

  status(): BrokerJetStreamStatus {
    if (!this.config.enabled) {
      return {
        state: "stopped",
        managed: false,
        detail: "OPENSCOUT_JETSTREAM_ENABLED is not set",
        publisher: null,
      };
    }
    const base: ScoutBrokerChildServiceSnapshot = this.sidecar
      ? this.sidecar.status()
      : {
          state: this.connection?.isConnected() ? "running" : "unavailable",
          managed: false,
          managedBy: "external",
          port: this.config.port,
          url: `nats://${this.config.host}:${this.config.port}`,
          healthy: Boolean(this.connection?.isConnected()),
          detail: this.startError,
        };
    const publisher = this.publisher?.snapshot() ?? null;
    // A live sidecar with a degraded publisher is not a healthy service: the
    // transport being up says nothing about whether events are reaching it.
    const publisherHealthy = publisher ? publisher.state !== "degraded" : false;
    return {
      ...base,
      state: base.state === "running" && !publisherHealthy ? "unavailable" : base.state,
      healthy: Boolean(base.healthy) && publisherHealthy,
      detail: publisher?.state === "degraded"
        ? publisher.detail ?? this.startError ?? base.detail ?? null
        : this.startError ?? base.detail ?? null,
      publisher,
    };
  }

  /**
   * Shut down publisher-first, then the connection, then the sidecar.
   *
   * Reversing that order would strand the final checkpoint: the publisher's
   * last catch-up pass needs a live server to ack against.
   */
  async stop(): Promise<void> {
    // Never tear down underneath an in-flight start: that would leave the
    // sidecar or connection owned by a promise nobody is waiting on.
    await this.starting?.catch(() => undefined);
    await this.publisher?.stop().catch(() => undefined);
    this.publisher = null;
    await this.connection?.close().catch(() => undefined);
    this.connection = null;
    await this.sidecar?.stop().catch(() => undefined);
    this.starting = null;
  }
}
