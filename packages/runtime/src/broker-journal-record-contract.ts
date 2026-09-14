import type { BrokerJournalEntry } from "./broker-journal.js";
import type { MessageRecord } from "@openscout/protocol";

// Exhaustive classification: a newly added journal kind must be considered
// before this reader can certify historical message absence at a boundary.
export const readableJournalKinds: Record<BrokerJournalEntry["kind"], true> = {
  "control.event.record": true,
  "node.upsert": true, "actor.upsert": true, "agent.upsert": true,
  "agent.endpoint.upsert": true, "agent.endpoint.delete": true,
  "conversation.upsert": true, "binding.upsert": true, "message.record": true,
  "conversation.read_cursor.upsert": true, "invocation.record": true,
  "invocation.dispatch_job.record": true, "flight.record": true,
  "collaboration.record": true, "collaboration.event.record": true,
  "deliveries.record": true, "delivery.attempt.record": true,
  "durable.action.record": true, "durable.action.heartbeat": true,
  "durable.attempt.record": true, "durable.checkpoint.record": true,
  "durable.signal.record": true, "journal.replay_barrier": true,
  "delivery.status.update": true, "scout.dispatch.record": true,
};

export function readableCanonicalMessage(message: unknown): message is MessageRecord {
  const m = message as MessageRecord | null;
  return Boolean(m && typeof m === "object"
    && [m.id, m.conversationId, m.actorId, m.originNodeId, m.body].every(v => typeof v === "string")
    && Number.isFinite(m.createdAt)
    && ["agent", "log", "system", "status", "artifact"].includes(m.class)
    && ["private", "workspace", "public", "system"].includes(m.visibility)
    && ["best_effort", "must_ack", "durable", "ephemeral"].includes(m.policy));
}
