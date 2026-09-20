import { describe, expect, test } from 'bun:test';
import { ChannelEventStreams, type ChannelEventScope } from './channel-event-stream.ts';
import type { ScoutEventConsumer, ScoutStreamDelivery } from '@openscout/runtime/jetstream';

function fixture() {
  let stopped = false;
  let waiting: ((item: ScoutStreamDelivery | null) => void) | undefined;
  const pending: ScoutStreamDelivery[] = [];
  let destroyed = 0, disconnected = 0, acknowledged = 0;
  const consumer: ScoutEventConsumer = {
    name: 'fixture',
    info: async () => { throw new Error('not used'); },
    async *events() {
      while (!stopped) {
        const item = pending.shift() ?? await new Promise<ScoutStreamDelivery | null>(r => { waiting = r; });
        if (item) yield item;
      }
    },
    close: async () => { stopped = true; waiting?.(null); },
    destroy: async () => { destroyed++; stopped = true; waiting?.(null); },
  };
  return {
    open: async () => ({ consumer, connection: { close: async () => { disconnected++; } } }),
    push(conversationId: string) {
      const item = { event: { conversationId, secret: 'private payload' }, ack: () => acknowledged++ } as unknown as ScoutStreamDelivery;
      if (waiting) { const resolve = waiting; waiting = undefined; resolve(item); } else pending.push(item);
    },
    counts: () => ({ destroyed, disconnected, acknowledged }),
  };
}
const allowed = (): ChannelEventScope => ({ allowed: true, conversationIds: new Set(['room', 'thread']) });
const request = () => new Request('http://localhost/api/channels/room/events');
const decode = (data: Uint8Array | undefined) => new TextDecoder().decode(data);

describe('channel event invalidation boundary', () => {
  test('without JetStream, serves an idle stream instead of 503', async () => {
    const previous = process.env.OPENSCOUT_JETSTREAM_ENABLED;
    delete process.env.OPENSCOUT_JETSTREAM_ENABLED;
    const streams = new ChannelEventStreams();
    try {
      const response = await streams.open(request(), { channelId: 'room', readScope: async () => allowed() });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type') ?? '').toContain('text/event-stream');
      const reader = response.body!.getReader();
      expect(decode((await reader.read()).value)).toContain('event: ready');
      await streams.stop();
      reader.cancel().catch(() => undefined);
    } finally {
      if (previous === undefined) delete process.env.OPENSCOUT_JETSTREAM_ENABLED;
      else process.env.OPENSCOUT_JETSTREAM_ENABLED = previous;
    }
  });

  test('denied scope never opens a transport connection', async () => {
    const streams = new ChannelEventStreams(); let opened = false;
    const response = await streams.open(request(), { channelId: 'room', readScope: async () => ({ ...allowed(), allowed: false }), open: async () => { opened = true; return fixture().open(); } });
    expect(response.status).toBe(403); expect(opened).toBe(false); await streams.stop();
  });
  test('emits minimal scoped invalidation, including new thread events, and closes on revocation', async () => {
    const streams = new ChannelEventStreams(); const source = fixture(); let permit = true;
    const response = await streams.open(request(), { channelId: 'room', readScope: async () => ({ ...allowed(), allowed: permit }), open: source.open });
    const reader = response.body!.getReader();
    expect(decode((await reader.read()).value)).toContain('event: ready');
    source.push('unrelated'); source.push('thread');
    const text = decode((await reader.read()).value);
    expect(text).toContain('event: channel.changed'); expect(text).toContain('"channelId":"room"');
    expect(text).not.toContain('private payload'); expect(source.counts().acknowledged).toBe(2);
    permit = false; source.push('room');
    expect((await reader.read()).done).toBe(true);
    await streams.stop(); await Bun.sleep(0);
    expect(source.counts().destroyed).toBe(1); expect(source.counts().disconnected).toBe(1);
  });
  test('revalidates after connection setup and never emits ready after revocation', async () => {
    const streams = new ChannelEventStreams(); const source = fixture(); let reads = 0;
    const response = await streams.open(request(), { channelId: 'room', readScope: async () => ({ ...allowed(), allowed: ++reads === 1 }), open: source.open });
    expect((await response.body!.getReader().read()).done).toBe(true);
    await streams.stop(); await Bun.sleep(0); expect(source.counts().destroyed).toBe(1);
  });
  test('abort closes transport even while idle', async () => {
    const streams = new ChannelEventStreams(); const source = fixture(); const abort = new AbortController();
    const response = await streams.open(new Request('http://localhost/', { signal: abort.signal }), { channelId: 'room', readScope: async () => allowed(), open: source.open });
    const reader = response.body!.getReader(); await reader.read(); abort.abort();
    expect((await reader.read()).done).toBe(true); await streams.stop(); await Bun.sleep(0);
    expect(source.counts().destroyed).toBe(1); expect(source.counts().disconnected).toBe(1);
  });
  test('periodic authorization closes a revoked idle stream', async () => {
    const streams = new ChannelEventStreams(); const source = fixture(); let permit = true;
    const response = await streams.open(request(), { channelId: 'room', readScope: async () => ({ ...allowed(), allowed: permit }), heartbeatMs: 10, open: source.open });
    const reader = response.body!.getReader(); await reader.read(); permit = false;
    expect((await reader.read()).done).toBe(true); await streams.stop();
  });
  test('server stop during asynchronous setup closes the eventual consumer', async () => {
    const streams = new ChannelEventStreams(); const source = fixture(); let resolve!: () => void;
    const wait = new Promise<void>(r => { resolve = r; });
    const pending = streams.open(request(), { channelId: 'room', readScope: async () => allowed(), open: async () => { await wait; return source.open(); } });
    await Bun.sleep(0); await streams.stop(); resolve();
    const response = await pending; expect((await response.body!.getReader().read()).done).toBe(true);
    await Bun.sleep(0); expect(source.counts().destroyed).toBe(1);
  });
});
