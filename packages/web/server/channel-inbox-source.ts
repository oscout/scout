import { openScoutEventConsumer, resolveJetStreamConfig, ScoutJetStreamConnection } from "@openscout/runtime/jetstream";

/** Optional push accelerator for one leased channel, never one consumer per waiter.
 * The coalesced high-water watchdog covers disabled/unavailable JetStream and
 * newly-created thread ids not yet observed in the channel scope. */
export function subscribeInboxChanges(conversationIds: ReadonlySet<string>, changed: () => void): () => void {
  if (!/^(1|true|yes|on)$/i.test(process.env.OPENSCOUT_JETSTREAM_ENABLED ?? "")) return () => {};
  let stopped = false;
  const connection = new ScoutJetStreamConnection({ config: resolveJetStreamConfig(), name: "openscout-web-inbox" });
  let consumer: Awaited<ReturnType<typeof openScoutEventConsumer>> | undefined;
  const close = () => { stopped = true; void consumer?.destroy().catch(() => {}); void connection.close().catch(() => {}); };
  void (async () => {
    try {
      consumer = await openScoutEventConsumer({ connection, deliver: "new", maxAckPending: 16 });
      if (stopped) { await consumer.destroy(); return; }
      for await (const delivery of consumer.events()) {
        if (stopped) break;
        if (conversationIds.has(delivery.event.conversationId)) changed();
        delivery.ack();
      }
    } catch { /* The single cheap channel watchdog remains authoritative. */ }
    finally { close(); }
  })();
  return close;
}
