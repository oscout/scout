import { afterEach, expect, test } from "bun:test";
import { openControlPlaneSqliteDatabase, type ControlPlaneSqliteTransactionalDatabase } from "./sqlite-adapter.js";
import { migrateControlPlaneDatabaseSchema } from "./control-plane-migrations.js";
import { BrokerIntegrationSetupService } from "./broker-integration-setup.js";
import { IntegrationSlackDeliveryService } from "./integration-slack-delivery.js";
import type { ScoutDeliverRequest, ScoutDeliverResponse } from "@openscout/protocol";
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
async function fixture() {
  const database = openControlPlaneSqliteDatabase(":memory:", { create: true }) as ControlPlaneSqliteTransactionalDatabase;
  cleanup.push(() => database.close?.()); migrateControlPlaneDatabaseSchema(database);
  const setup = new BrokerIntegrationSetupService({ database, ownerRealmId: "realm", nodeId: "node", snapshot: () => ({
    agents: Object.fromEntries(["alpha", "beta"].map(id => [id, { id, definitionId: id, displayName: id, homeNodeId: "node", authorityNodeId: "node", metadata: { projectRoot: `/work/${id}` } }])), endpoints: {},
  }) as never, verifyCredentials: async input => ({ teamId: input.teamId, appId: input.appId, botId: "B123", botUserId: "U123" }) });
  const operations = [];
  for (const [agent, appId] of [["alpha", "A123"], ["beta", "A456"]]) {
    const op = setup.setup({ provider: "slack", mode: "project_agent", projectPath: `/work/${agent}`, workspaceId: "T123" }).operation;
    setup.resume(op.id, { action: "confirm_authority", expectedRevision: 1 }); setup.resume(op.id, { action: "register_app", expectedRevision: 2, appId });
    await setup.attachCredentials(op.id, { expectedRevision: 3, reference: { backend: "secret_cli", appTokenKey: "APP", botTokenKey: "BOT" }, allowedUserIds: ["U1"], allowedChannelIds: ["C1"] });
    setup.setLifecycle(op.id, { action: "start", expectedRevision: 4 }); operations.push(setup.claimWorker(op.id));
  }
  const service = new IntegrationSlackDeliveryService(database, setup);
  const calls: ScoutDeliverRequest[] = [];
  const accept = async (request: ScoutDeliverRequest): Promise<ScoutDeliverResponse> => {
    calls.push(request);
    return { kind: "delivery", accepted: true, receipt: { messageId: `message-${calls.length}`, bindingRef: "short" } } as ScoutDeliverResponse;
  };
  const input = (index = 0, eventTs = "100.1") => ({ generation: operations[index]!.grant.generation, token: operations[index]!.grant.token,
    teamId: "T123", channelId: "C1", threadTs: "100.1", eventTs, userId: "U1", userName: "User", title: "Test", prompt: "Do this", attachments: [] });
  return { database, setup, service, operations, calls, accept, input };
}
test("the broker chooses exact agent and canonical thread refs independently for two project bots", async () => {
  const f = await fixture();
  const a = f.operations[0]!.operation.id, b = f.operations[1]!.operation.id;
  await f.service.deliver(a, f.input(), f.accept);
  await f.service.deliver(b, f.input(1), f.accept);
  await f.service.deliver(a, f.input(0, "100.2"), f.accept);
  expect(f.calls.map(call => call.target)).toEqual([{ kind: "agent_id", agentId: "alpha" }, { kind: "agent_id", agentId: "beta" }, { kind: "binding_ref", ref: "message-1" }]);
  expect(f.calls[0]!.id).not.toBe(f.calls[1]!.id);
  expect(f.calls[0]!.messageMetadata?.clientMessageId).toBe(f.calls[0]!.id);
});
test("cached receipts survive service reconstruction without dispatching work twice", async () => {
  const f = await fixture(); const id = f.operations[0]!.operation.id;
  const first = await f.service.deliver(id, f.input(), f.accept);
  const recovered = new IntegrationSlackDeliveryService(f.database, f.setup);
  expect(await recovered.deliver(id, { ...f.input(), prompt: "context changed after reconnect" }, f.accept)).toEqual(first);
  expect(f.calls).toHaveLength(1);
});
test("unknown outcome retries preserve the original request and block later thread work", async () => {
  const f = await fixture(); const id = f.operations[0]!.operation.id;
  let original: ScoutDeliverRequest | undefined;
  await expect(f.service.deliver(id, f.input(), async request => { original = request; throw new Error("lost acknowledgement"); })).rejects.toThrow("lost acknowledgement");
  await expect(f.service.deliver(id, f.input(0, "100.2"), f.accept)).rejects.toThrow("earlier request");
  await f.service.deliver(id, { ...f.input(), prompt: "changed" }, f.accept);
  expect(f.calls[0]).toEqual(original);
});
test("rejects routing overrides, foreign users, wrong workspace, and revoked workers before dispatch", async () => {
  const f = await fixture(); const id = f.operations[0]!.operation.id;
  for (const patch of [{ target: { kind: "agent_id", agentId: "beta" } }, { userId: "UOTHER" }, { teamId: "TOTHER" }, { channelId: "COTHER" }]) {
    await expect(f.service.deliver(id, { ...f.input(), ...patch }, f.accept)).rejects.toThrow();
  }
  f.setup.setLifecycle(id, { action: "pause", expectedRevision: 5 });
  await expect(f.service.deliver(id, f.input(), f.accept)).rejects.toThrow("revoked");
  expect(f.calls).toHaveLength(0);
});
test("simultaneous retries share persisted acceptance rather than racing duplicate work", async () => {
  const f = await fixture(); const id = f.operations[0]!.operation.id;
  await Promise.all([f.service.deliver(id, f.input(), f.accept), f.service.deliver(id, f.input(), f.accept)]);
  expect(f.calls).toHaveLength(1);
});
