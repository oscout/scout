import {
  openScoutEventConsumer,
  resolveJetStreamConfig,
  ScoutJetStreamConnection,
  type ScoutEventConsumer,
} from '@openscout/runtime/jetstream';

export type ChannelEventScope = { allowed: boolean; conversationIds: Set<string> };
type ConsumerConnection = { close(): Promise<void> };
export type ChannelEventStreamOptions = {
  channelId: string;
  /** Fresh credentials and roster, never the cached connection-time grant. */
  readScope(): Promise<ChannelEventScope>;
  heartbeatMs?: number;
  /** Tests can supply an event source without opening local sockets. */
  open?: () => Promise<{ connection: ConsumerConnection; consumer: ScoutEventConsumer }>;
};

/** Server-owned streams. Every browser receives only a channel invalidation. */
export class ChannelEventStreams {
  private readonly active = new Set<() => Promise<void>>();
  private stopped = false;

  async open(request: Request, options: ChannelEventStreamOptions): Promise<Response> {
    if (this.stopped || (!options.open && !/^(1|true|yes|on)$/i.test(process.env.OPENSCOUT_JETSTREAM_ENABLED ?? ''))) {
      return Response.json({ error: 'Channel live updates are unavailable.' }, { status: 503 });
    }
    const initial = await options.readScope().catch(() => null);
    if (!initial?.allowed) return Response.json({ error: 'Channel access denied.' }, { status: 403 });
    let connection: ConsumerConnection | undefined;
    let consumer: ScoutEventConsumer;
    try {
      if (options.open) {
        ({ connection, consumer } = await options.open());
      } else {
        const nats = new ScoutJetStreamConnection({ config: resolveJetStreamConfig(), name: 'openscout-web-channel-events' });
        connection = nats;
        // Broad server-side interest includes threads created after connection.
        // Delivery below always checks the current permitted conversation set.
        consumer = await openScoutEventConsumer({ connection: nats, deliver: 'new', maxAckPending: 16 });
      }
    } catch {
      await connection?.close().catch(() => undefined);
      return Response.json({ error: 'Channel live updates are unavailable.' }, { status: 503 });
    }
    let closed = false;
    let controller: ReadableStreamDefaultController<Uint8Array>;
    let heartbeat: ReturnType<typeof setTimeout> | undefined;
    const encoder = new TextEncoder();
    let cleanup: Promise<void> | undefined;
    const close = (): Promise<void> => {
      if (cleanup) return cleanup;
      closed = true;
      if (heartbeat) clearTimeout(heartbeat);
      request.signal.removeEventListener('abort', abort);
      this.active.delete(close);
      try { controller?.close(); } catch { /* already cancelled */ }
      cleanup = (async () => {
        await consumer.destroy().catch(() => undefined);
        await connection?.close().catch(() => undefined);
      })();
      return cleanup;
    };
    const abort = () => { void close(); };
    const emit = (text: string): boolean => {
      if (closed) return false;
      // A slow browser must not grow an unbounded in-memory queue. Reconnect
      // emits ready and refetches the snapshot, so dropping this stream is safe.
      if ((controller.desiredSize ?? 0) <= 0) { void close(); return false; }
      try { controller.enqueue(encoder.encode(text)); return true; }
      catch { void close(); return false; }
    };
    const checkScope = async (): Promise<ChannelEventScope | null> => {
      const scope = await options.readScope().catch(() => null);
      if (closed) return null;
      if (!scope?.allowed) { void close(); return null; }
      return scope;
    };
    const tick = async () => {
      if (await checkScope()) emit(': keep-alive\n\n');
      if (!closed) heartbeat = setTimeout(() => { void tick(); }, options.heartbeatMs ?? 5000);
    };
    const stream = new ReadableStream<Uint8Array>({
      start: (output) => {
        controller = output;
        this.active.add(close);
        request.signal.addEventListener('abort', abort, { once: true });
        if (request.signal.aborted || this.stopped) { void close(); return; }
        void (async () => {
          // Recheck after the asynchronous consumer setup before announcing ready.
          if (!(await checkScope())) return;
          emit(`event: ready\ndata: ${JSON.stringify({ channelId: options.channelId })}\n\n`);
          heartbeat = setTimeout(() => { void tick(); }, options.heartbeatMs ?? 5000);
          try {
            for await (const delivery of consumer.events()) {
              if (closed) break;
              const scope = await checkScope();
              if (!scope) break;
              if (scope.conversationIds.has(delivery.event.conversationId)) {
                emit(`event: channel.changed\ndata: ${JSON.stringify({ channelId: options.channelId })}\n\n`);
              }
              // This ACK covers receipt by the invalidation adapter, not the
              // browser applying data. Reconnect always refetches canonical state.
              delivery.ack();
            }
          } finally { await close(); }
        })().catch(() => { void close(); });
      },
      cancel: () => close(),
    }, { highWaterMark: 16 });
    return new Response(stream, { headers: {
      'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    } });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.active].map(close => close()));
  }
}
