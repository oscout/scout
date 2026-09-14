/** Bounded diagnostic state: counts are occurrences, not unique lost records. */
const kinds = new Set([
  'node.upsert', 'actor.upsert', 'agent.upsert', 'agent.endpoint.upsert', 'agent.endpoint.delete',
  'conversation.upsert', 'binding.upsert', 'message.record', 'conversation.read_cursor.upsert',
  'invocation.record', 'invocation.dispatch_job.record', 'flight.record', 'collaboration.record',
  'collaboration.event.record', 'deliveries.record', 'delivery.attempt.record', 'durable.action.record',
  'durable.action.heartbeat', 'durable.attempt.record', 'durable.checkpoint.record', 'durable.signal.record',
  'journal.replay_barrier', 'delivery.status.update', 'scout.dispatch.record',
]);
export type ProjectionSkipCount = { count: number; firstReason: string; lastReason: string };
export class ProjectionSkipLedger {
  private readonly counts = new Map<string, ProjectionSkipCount>();
  private total = 0;
  record(kind: string, error: unknown): boolean {
    const key = kinds.has(kind) ? kind : 'unknown';
    const reason = (error instanceof Error ? error.message : String(error)).slice(0, 256);
    const previous = this.counts.get(key);
    this.total = Math.min(Number.MAX_SAFE_INTEGER, this.total + 1);
    this.counts.set(key, { count: Math.min(Number.MAX_SAFE_INTEGER, (previous?.count ?? 0) + 1), firstReason: previous?.firstReason ?? reason, lastReason: reason });
    return previous === undefined;
  }
  snapshot(): { total: number; byKind: Record<string, ProjectionSkipCount> } {
    return { total: this.total, byKind: Object.fromEntries([...this.counts].map(([kind,value]) => [kind,{...value}])) };
  }
}
