import { z } from "zod";
import type { ScoutDeliverRequest, ScoutDeliverResponse } from "@openscout/protocol";
import { BrokerIntegrationSetupService, IntegrationSetupError } from "./broker-integration-setup.js";
import type { ControlPlaneSqliteTransactionalDatabase } from "./sqlite-adapter.js";
import { slackActorId, slackDeliveryId } from "./slack-identities.js";

export const INTEGRATION_SLACK_DELIVERY_SCHEMA = `
CREATE TABLE IF NOT EXISTS integration_slack_threads (
  operation_id TEXT NOT NULL REFERENCES integration_setup_operations(id) ON DELETE RESTRICT,
  channel_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  binding_revision INTEGER NOT NULL,
  binding_ref TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (operation_id, channel_id, thread_ts)
);
CREATE TABLE IF NOT EXISTS integration_slack_deliveries (
  operation_id TEXT NOT NULL REFERENCES integration_setup_operations(id) ON DELETE RESTRICT,
  event_key TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  user_id TEXT NOT NULL,
  binding_revision INTEGER NOT NULL,
  request_json TEXT NOT NULL,
  response_json TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (operation_id, event_key)
);
CREATE INDEX IF NOT EXISTS idx_integration_slack_pending_thread
  ON integration_slack_deliveries (operation_id, channel_id, thread_ts)
  WHERE response_json IS NULL;
`;
const timestamp = z.string().regex(/^\d+\.\d+$/);
const schema = z.object({
  generation: z.number().int().positive(), token: z.string().min(1).max(256),
  teamId: z.string().regex(/^T[A-Z0-9]+$/), channelId: z.string().regex(/^[CGD][A-Z0-9]+$/),
  threadTs: timestamp, eventTs: timestamp, userId: z.string().regex(/^[UW][A-Z0-9]+$/),
  userName: z.string().min(1).max(256), title: z.string().min(1).max(512), prompt: z.string().min(1).max(200_000),
  attachments: z.array(z.object({ id: z.string().max(256), mediaType: z.string().max(256), fileName: z.string().max(512).optional(), blobKey: z.string().max(4096).optional(), url: z.string().max(4096).optional(), metadata: z.record(z.string(), z.unknown()).optional() }).strict()).max(20),
}).strict();
type DeliveryRow = { user_id: string; channel_id: string; thread_ts: string; binding_revision: number; request_json: string; response_json: string | null };

/** Canonical project routing and thread lineage. The worker carries content,
 * never an agent target, runtime override, or trusted continuation reference.
 */
export class IntegrationSlackDeliveryService {
  private readonly serial = new Map<string, Promise<unknown>>();
  constructor(private readonly database: ControlPlaneSqliteTransactionalDatabase, private readonly setup: BrokerIntegrationSetupService) {}
  async deliver(id: string, input: unknown, accept: (request: ScoutDeliverRequest) => Promise<ScoutDeliverResponse>): Promise<ScoutDeliverResponse> {
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw new IntegrationSetupError("invalid_delivery", "Invalid project Slack delivery fields.", 400);
    const value = parsed.data;
    const key = JSON.stringify([id, value.channelId, value.threadTs]);
    const prior = this.serial.get(key) ?? Promise.resolve();
    const work = prior.catch(() => {}).then(async () => {
      this.setup.workerRequest(id, { action: "check", generation: value.generation, token: value.token });
      const operation = this.setup.authorizeWorker({ operationId: id, generation: value.generation, token: value.token, expiresAt: 0 });
      if (operation.workspaceId !== value.teamId || !operation.credentials?.allowedUserIds.includes(value.userId)
        || (!value.channelId.startsWith("D") && !operation.credentials.allowedChannelIds.includes(value.channelId))) {
        throw new IntegrationSetupError("slack_access_denied", "Slack user, channel, or workspace is outside this installation's policy.", 403);
      }
      const eventKey = slackDeliveryId(value.teamId, value.channelId, value.eventTs, id);
      const observedEvent = this.database.query<{ envelope_json: string }>("SELECT envelope_json FROM integration_slack_events WHERE operation_id = ?1 AND delivery_key = ?2").get(id, eventKey);
      if (observedEvent && JSON.parse(observedEvent.envelope_json).routingIssue === "ambiguous_project_mentions") throw new IntegrationSetupError("ambiguous_project_mentions", "Mention exactly one project bot per request. No task was dispatched.", 409);
      let payload!: ScoutDeliverRequest;
      let cached: ScoutDeliverResponse | undefined;
      this.database.transaction(() => {
        const row = this.database.query<DeliveryRow>("SELECT * FROM integration_slack_deliveries WHERE operation_id = ?1 AND event_key = ?2").get(id, eventKey);
        if (row) {
          if (row.user_id !== value.userId || row.channel_id !== value.channelId || row.thread_ts !== value.threadTs || row.binding_revision !== operation.binding.revision) throw new IntegrationSetupError("event_conflict", "This Slack event belongs to a different binding or requester.");
          payload = JSON.parse(row.request_json);
          if (row.response_json) cached = JSON.parse(row.response_json);
          return;
        }
        const pending = this.database.query("SELECT event_key FROM integration_slack_deliveries WHERE operation_id = ?1 AND channel_id = ?2 AND thread_ts = ?3 AND response_json IS NULL LIMIT 1").get(id, value.channelId, value.threadTs);
        if (pending) throw new IntegrationSetupError("thread_recovery_pending", "An earlier request in this thread needs recovery before continuing.");
        const thread = this.database.query<{ binding_revision: number; binding_ref: string }>("SELECT * FROM integration_slack_threads WHERE operation_id = ?1 AND channel_id = ?2 AND thread_ts = ?3").get(id, value.channelId, value.threadTs);
        if (thread && thread.binding_revision !== operation.binding.revision) throw new IntegrationSetupError("binding_changed", "This Slack thread belongs to an earlier project binding.");
        const requesterId = slackActorId(value.teamId, value.userId);
        const metadata = { source: "slack", slackTeamId: value.teamId, slackChannelId: value.channelId, slackThreadTs: value.threadTs, slackEventTs: value.eventTs,
          integrationId: id, integrationBindingRevision: operation.binding.revision, clientMessageId: eventKey };
        payload = {
          id: eventKey, body: value.prompt, attachments: value.attachments, intent: "consult", requesterId, requesterNodeId: operation.binding.nodeId,
          caller: { actorId: requesterId, nodeId: operation.binding.nodeId, displayName: value.userName, currentDirectory: operation.binding.projectPath, metadata },
          target: thread ? { kind: "binding_ref", ref: thread.binding_ref } : { kind: "agent_id", agentId: operation.binding.agentId },
          routePolicy: { ambiguous: "reject" }, ensureAwake: true, execution: { placement: "background" }, createdAt: Date.now(),
          labels: ["slack", `integration:${id}`], messageMetadata: metadata, invocationMetadata: metadata,
          ...(thread ? {} : { workItem: { title: value.title, acceptanceState: "pending" as const, metadata } }),
        };
        this.database.query("INSERT INTO integration_slack_deliveries (operation_id,event_key,channel_id,thread_ts,user_id,binding_revision,request_json,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)")
          .run(id, eventKey, value.channelId, value.threadTs, value.userId, operation.binding.revision, JSON.stringify(payload), Date.now());
      })();
      if (cached) return cached;
      const response = await accept(payload);
      // Prefer an exact canonical message ID over a short display alias.
      const result = response.kind === "delivery" ? { ...response, bindingRef: response.receipt.messageId, receipt: { ...response.receipt, bindingRef: response.receipt.messageId } } : response;
      this.database.transaction(() => {
        if (result.kind === "delivery") {
          this.database.query(`INSERT INTO integration_slack_threads (operation_id,channel_id,thread_ts,binding_revision,binding_ref,updated_at) VALUES (?1,?2,?3,?4,?5,?6)
            ON CONFLICT(operation_id,channel_id,thread_ts) DO UPDATE SET binding_ref=excluded.binding_ref, updated_at=excluded.updated_at`)
            .run(id, value.channelId, value.threadTs, operation.binding.revision, result.receipt.messageId, Date.now());
        }
        this.database.query("UPDATE integration_slack_deliveries SET response_json = ?1, updated_at = ?2 WHERE operation_id = ?3 AND event_key = ?4")
          .run(JSON.stringify(result), Date.now(), id, eventKey);
      })();
      return result;
    });
    this.serial.set(key, work);
    try { return await work; } finally { if (this.serial.get(key) === work) this.serial.delete(key); }
  }
}
