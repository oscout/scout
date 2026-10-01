import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrokerIntegrationSetupService } from "./broker-integration-setup.js";
import { openControlPlaneSqliteDatabase, type ControlPlaneSqliteTransactionalDatabase } from "./sqlite-adapter.js";
import { migrateControlPlaneDatabaseSchema } from "./control-plane-migrations.js";
import type { RuntimeSnapshot } from "./scout-dispatcher.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function fixture(path = ":memory:", realm = "realm", verifyCredentials?: ConstructorParameters<typeof BrokerIntegrationSetupService>[0]["verifyCredentials"]) {
  const database = openControlPlaneSqliteDatabase(path, { create: true }) as ControlPlaneSqliteTransactionalDatabase;
  migrateControlPlaneDatabaseSchema(database);
  cleanup.push(() => database.close?.());
  const snapshot = { agents: { alpha: { id: "alpha", definitionId: "alpha-def", displayName: "Alpha", homeNodeId: "local", authorityNodeId: "local", metadata: { projectRoot: "/work/alpha" } },
    beta: { id: "beta", definitionId: "beta-def", displayName: "Beta", homeNodeId: "local", authorityNodeId: "local", metadata: { projectRoot: "/work/beta" } } }, endpoints: {} } as unknown as RuntimeSnapshot;
  return { database, snapshot, service: new BrokerIntegrationSetupService({ database, ownerRealmId: realm, nodeId: "local", snapshot: () => snapshot, verifyCredentials }) };
}
const request = { provider: "slack", mode: "project_agent", projectPath: "/work/alpha" };
test("reuses a draft, advances it once, and retains idempotency through resume", () => {
  const { service } = fixture();
  const draft = service.setup({ ...request, idempotencyKey: "first" });
  expect(draft.operation.state).toBe("awaiting_workspace");
  const selected = service.setup({ ...request, workspaceId: "T123" });
  expect(selected.operation.id).toBe(draft.operation.id);
  expect(selected.operation.revision).toBe(2);
  expect(service.setup({ ...request, idempotencyKey: "first" })).toEqual(selected);
  expect(service.setup({ ...request, workspaceId: "T123" })).toEqual(selected);
  expect(() => service.setup({ ...request, workspaceId: "T999", idempotencyKey: "first" })).toThrow("different setup request");
});
test("resume requires current revision, ordered steps and keeps readiness unverified", () => {
  const { service } = fixture();
  const draft = service.setup(request).operation;
  expect(() => service.resume(draft.id, { action: "register_app", expectedRevision: 1, appId: "A123" })).toThrow("not the current");
  service.resume(draft.id, { action: "choose_workspace", expectedRevision: 1, workspaceId: "T123" });
  expect(() => service.resume(draft.id, { action: "confirm_authority", expectedRevision: 1 })).toThrow("Setup changed");
  service.resume(draft.id, { action: "confirm_authority", expectedRevision: 2 });
  const recorded = service.resume(draft.id, { action: "register_app", expectedRevision: 3, appId: "A123" });
  expect(recorded.operation.state).toBe("awaiting_credentials");
  expect(recorded.readiness).toBe("not_connected");
  expect(recorded.nextAction.kind).toBe("connect_secrets");
});
test("survives database reopen and rejects another realm", () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-integration-test-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "broker.sqlite");
  const first = fixture(path);
  const draft = first.service.setup({ ...request, idempotencyKey: "recover" });
  // Close before reopening, without calling the registered close callback twice.
  cleanup.pop()!();
  const second = fixture(path);
  expect(second.service.setup({ ...request, idempotencyKey: "recover" })).toEqual(draft);
  const foreign = fixture(path, "foreign");
  expect(() => foreign.service.get(draft.operation.id)).toThrow("not found");
});
test("cannot bind one Slack app to two project agents", () => {
  const { service } = fixture();
  const alpha = service.setup({ ...request, workspaceId: "T123" }).operation;
  const beta = service.setup({ ...request, projectPath: "/work/beta", workspaceId: "T123" }).operation;
  for (const op of [alpha, beta]) service.resume(op.id, { action: "confirm_authority", expectedRevision: 1 });
  service.resume(alpha.id, { action: "register_app", expectedRevision: 2, appId: "A123" });
  expect(() => service.resume(beta.id, { action: "register_app", expectedRevision: 2, appId: "A123" })).toThrow("already claimed");
  expect(service.get(beta.id).operation.revision).toBe(2);
});
test("rejects ambiguous, changed and foreign-node bindings", () => {
  const { service, snapshot } = fixture();
  const op = service.setup({ ...request, workspaceId: "T123" }).operation;
  snapshot.agents.alpha!.definitionId = "changed";
  expect(() => service.resume(op.id, { action: "confirm_authority", expectedRevision: 1 })).toThrow("definition changed");
  snapshot.agents.alpha!.homeNodeId = "remote";
  expect(() => service.setup(request)).toThrow("local project agent");
  snapshot.agents.alpha!.homeNodeId = "local";
  snapshot.endpoints.ambiguous = { agentId: "alpha", projectRoot: "/work/other" } as never;
  expect(() => service.setup(request)).toThrow("unambiguous project root");
});
test("strict input excludes tokens and arbitrary setup state, and never echoes input", () => {
  const { service, database } = fixture();
  expect(() => service.setup({ ...request, botToken: "SECRET_SENTINEL" })).toThrow("token-free fields");
  expect(database.query("SELECT * FROM integration_setup_operations").all()).toHaveLength(0);
  const op = service.setup(request).operation;
  expect(() => service.resume(op.id, { action: "verified", expectedRevision: 1 })).toThrow("token-free fields");
});
test("workspace omission cannot choose among multiple installations", () => {
  const { service } = fixture();
  service.setup({ ...request, workspaceId: "T123" });
  service.setup({ ...request, workspaceId: "T456" });
  expect(() => service.setup(request)).toThrow("Choose a workspace");
});


test("attaches verified references with explicit access policy, never raw tokens", async () => {
  const { service } = fixture(":memory:", "realm", async input => ({ teamId: input.teamId, appId: input.appId, botId: "B123", botUserId: "U123" }));
  const op = service.setup({ ...request, workspaceId: "T123" }).operation;
  service.resume(op.id, { action: "confirm_authority", expectedRevision: 1 });
  service.resume(op.id, { action: "register_app", expectedRevision: 2, appId: "A123" });
  const result = await service.attachCredentials(op.id, { expectedRevision: 3, reference: { backend: "secret_cli", appTokenKey: "LATTICES_APP", botTokenKey: "LATTICES_BOT" }, allowedUserIds: ["U1"], allowedChannelIds: ["C1"] });
  expect(result.operation.state).toBe("ready_to_start");
  expect(result.readiness).toBe("not_connected");
  expect(result.operation.credentials?.botUserId).toBe("U123");
  expect(result.operation.credentials?.allowedUserIds).toEqual(["U1"]);
});
test("a failed verifier preserves the resumable state and redacts its error", async () => {
  const { service } = fixture(":memory:", "realm", async () => { throw new Error("SECRET_SENTINEL"); });
  const op = service.setup({ ...request, workspaceId: "T123" }).operation;
  service.resume(op.id, { action: "confirm_authority", expectedRevision: 1 });
  service.resume(op.id, { action: "register_app", expectedRevision: 2, appId: "A123" });
  await expect(service.attachCredentials(op.id, { expectedRevision: 3, reference: { backend: "secret_cli", appTokenKey: "LATTICES_APP", botTokenKey: "LATTICES_BOT" }, allowedUserIds: ["U1"], allowedChannelIds: [] })).rejects.toThrow("Slack credentials could not be verified.");
  expect(service.get(op.id).operation.state).toBe("awaiting_credentials");
  expect(service.get(op.id).operation.revision).toBe(3);
});

test("manifest uses the operation identity and requires confirmed authority", () => {
  const { service } = fixture();
  const op = service.setup({ ...request, workspaceId: "T123", displayName: "Lattices" }).operation;
  expect(() => service.manifest(op.id)).toThrow("Confirm workspace");
  service.resume(op.id, { action: "confirm_authority", expectedRevision: 1 });
  const manifest = service.manifest(op.id) as { display_information: { name: string }; features: Record<string, unknown> };
  expect(manifest.display_information.name).toBe("Lattices");
  expect(manifest.features.slash_commands).toBeUndefined();
  expect(op.manifestHash).toHaveLength(64);
});
test("concurrent credential verification cannot overwrite a newer receipt", async () => {
  const resolveChecks: Array<() => void> = [];
  const { service } = fixture(":memory:", "realm", input => new Promise(resolve => {
    resolveChecks.push(() => resolve({ teamId: input.teamId, appId: input.appId, botId: "B123", botUserId: "U123" }));
  }));
  const op = service.setup({ ...request, workspaceId: "T123" }).operation;
  service.resume(op.id, { action: "confirm_authority", expectedRevision: 1 });
  service.resume(op.id, { action: "register_app", expectedRevision: 2, appId: "A123" });
  const input = { expectedRevision: 3, reference: { backend: "secret_cli", appTokenKey: "APP_KEY", botTokenKey: "BOT_KEY" }, allowedUserIds: ["U1"], allowedChannelIds: [] };
  const first = service.attachCredentials(op.id, input);
  const second = service.attachCredentials(op.id, { ...input, allowedUserIds: ["U2"] });
  resolveChecks[0]!(); await first;
  resolveChecks[1]!(); await expect(second).rejects.toThrow("changed during credential verification");
  expect(service.get(op.id).operation.credentials?.allowedUserIds).toEqual(["U1"]);
});

test("verification requires completed, delivered, correctly routed request and continuation evidence", async () => {
  const { service, database, snapshot } = fixture(":memory:", "realm", async input => ({ teamId: input.teamId, appId: input.appId, botId: "B123", botUserId: "U123" }));
  const op = service.setup({ ...request, workspaceId: "T123" }).operation;
  service.resume(op.id, { action: "confirm_authority", expectedRevision: 1 });
  service.resume(op.id, { action: "register_app", expectedRevision: 2, appId: "A123" });
  await service.attachCredentials(op.id, { expectedRevision: 3, reference: { backend: "private_file", appTokenKey: "APP", botTokenKey: "BOT" }, allowedUserIds: ["U1"], allowedChannelIds: ["C1"] });
  expect(() => service.verify(op.id, { expectedRevision: 4 })).toThrow("Connect");
  service.setLifecycle(op.id, { action: "start", expectedRevision: 4 });
  const { grant } = service.claimWorker(op.id);
  service.heartbeatWorker(grant, true);
  expect(() => service.verify(op.id, { expectedRevision: 5 })).toThrow("No completed request");
  snapshot.flights = {};
  const now = Date.now();
  for (const n of [1, 2]) {
    database.query("INSERT INTO integration_slack_events (operation_id,event_id,channel_id,thread_ts,binding_revision,envelope_json,delivery_key,progress_json,result_completed_at,state,next_attempt_at,received_at,updated_at) VALUES (?1,?2,'C1','100.1',1,json_object('payload',json_object('event',json_object('type','app_mention'))),?2,'{}',?3,'processed',?3,?3,?3)").run(op.id, `event${n}`, now + n);
    const response = { kind: "delivery", receipt: { conversationId: "conversation", messageId: `message${n}` }, flight: { id: `flight${n}`, invocationId: `invocation${n}` } };
    const target = n === 1 ? { kind: "agent_id", agentId: "alpha" } : { kind: "binding_ref", ref: "wrong-message" };
    database.query("INSERT INTO integration_slack_deliveries (operation_id,event_key,channel_id,thread_ts,user_id,binding_revision,request_json,response_json,updated_at) VALUES (?1,?2,'C1','100.1','U1',1,?3,?4,?5)").run(op.id, `event${n}`, JSON.stringify({ target }), JSON.stringify(response), now + n);
    snapshot.flights[`flight${n}`] = { id: `flight${n}`, invocationId: `invocation${n}`, requesterId: "user", targetAgentId: "alpha", state: "completed" };
  }
  expect(() => service.verify(op.id, { expectedRevision: 5 })).toThrow("No completed request");
  database.query("UPDATE integration_slack_deliveries SET request_json = ?1 WHERE event_key = 'event2'").run(JSON.stringify({ target: { kind: "binding_ref", ref: "message1" } }));
  snapshot.flights.flight2!.state = "failed";
  expect(() => service.verify(op.id, { expectedRevision: 5 })).toThrow("No completed request");
  snapshot.flights.flight2!.state = "completed";
  database.query("UPDATE integration_slack_events SET result_completed_at = NULL WHERE event_id = 'event2'").run();
  expect(() => service.verify(op.id, { expectedRevision: 5 })).toThrow("No completed request");
  database.query("UPDATE integration_slack_events SET result_completed_at = ?1 WHERE event_id = 'event2'").run(now + 10);
  const verified = service.verify(op.id, { expectedRevision: 5 });
  expect(verified.readiness).toBe("verified");
  expect(verified.operation.verification?.followUp.eventId).toBe("event2");
  expect(service.verify(op.id, { expectedRevision: 6 })).toEqual(verified);
  const paused = service.setLifecycle(op.id, { action: "pause", expectedRevision: 6 });
  expect(paused.readiness).toBe("not_connected");
  expect(paused.operation.verification).toEqual(verified.operation.verification);
});

test("rotation requires a paused worker and verifies replacements before atomic swap", async () => {
  let reject = false;
  const { service, database } = fixture(":memory:", "realm", async input => {
    if (reject) throw new Error("private provider failure");
    return { teamId: input.teamId, appId: input.appId, botId: "B123", botUserId: "U123" };
  });
  const op = service.setup({ ...request, workspaceId: "T123" }).operation;
  service.resume(op.id, { action: "confirm_authority", expectedRevision: 1 });
  service.resume(op.id, { action: "register_app", expectedRevision: 2, appId: "A123" });
  const credentials = { reference: { backend: "private_file", appTokenKey: "APP", botTokenKey: "BOT" }, allowedUserIds: ["U1"], allowedChannelIds: ["C1"] };
  const first = await service.attachCredentials(op.id, { ...credentials, expectedRevision: 3 });
  service.setLifecycle(op.id, { action: "start", expectedRevision: 4 });
  const { grant } = service.claimWorker(op.id);
  const replacement = { ...credentials, rotate: true, reference: { ...credentials.reference, appTokenKey: "NEW_APP", botTokenKey: "NEW_BOT" } };
  await expect(service.attachCredentials(op.id, { ...replacement, expectedRevision: 5 })).rejects.toThrow("Pause");
  service.setLifecycle(op.id, { action: "pause", expectedRevision: 5 });
  database.query("INSERT INTO integration_slack_events (operation_id,event_id,channel_id,thread_ts,binding_revision,envelope_json,delivery_key,state,next_attempt_at,received_at,updated_at) VALUES (?1,'pending','C1','100.1',1,'{}','key','pending',1,1,1)").run(op.id);
  await expect(service.attachCredentials(op.id, { ...replacement, allowedUserIds: ["U2"], expectedRevision: 6 })).rejects.toThrow("Drain pending intake");
  reject = true;
  await expect(service.attachCredentials(op.id, { ...replacement, expectedRevision: 6 })).rejects.toThrow("could not be verified");
  expect(service.get(op.id).operation.credentials).toEqual(first.operation.credentials);
  reject = false;
  const rotated = await service.attachCredentials(op.id, { ...replacement, expectedRevision: 6 });
  expect(rotated.operation.credentials?.reference.appTokenKey).toBe("NEW_APP");
  expect(rotated.operation.credentials!.verifiedAt).toBeGreaterThan(first.operation.credentials!.verifiedAt);
  expect(rotated.operation.desiredState).toBe("paused");
  expect(rotated.readiness).toBe("not_connected");
  expect(rotated.operation.verification).toBeUndefined();
  expect(() => service.authorizeWorker(grant)).toThrow();
});

test("rebind requires a paused drained installation and preserves old setup-key identity", async () => {
  const { service, database } = fixture(":memory:", "realm", async input => ({ teamId: input.teamId, appId: input.appId, botId: "B123", botUserId: "U123" }));
  const original = { ...request, workspaceId: "T123", idempotencyKey: "original" };
  const op = service.setup(original).operation;
  service.resume(op.id, { action: "confirm_authority", expectedRevision: 1 });
  service.resume(op.id, { action: "register_app", expectedRevision: 2, appId: "A123" });
  await service.attachCredentials(op.id, { expectedRevision: 3, reference: { backend: "private_file", appTokenKey: "APP", botTokenKey: "BOT" }, allowedUserIds: ["U1"], allowedChannelIds: ["C1"] });
  service.setLifecycle(op.id, { action: "start", expectedRevision: 4 });
  const { grant } = service.claimWorker(op.id);
  expect(() => service.rebind(op.id, { expectedRevision: 5, projectPath: "/work/beta" })).toThrow("Pause");
  service.setLifecycle(op.id, { action: "pause", expectedRevision: 5 });
  database.query("INSERT INTO integration_slack_events (operation_id,event_id,channel_id,thread_ts,binding_revision,envelope_json,delivery_key,state,next_attempt_at,received_at,updated_at) VALUES (?1,'pending','C1','100.1',1,'{}','key','pending',1,1,1)").run(op.id);
  expect(() => service.rebind(op.id, { expectedRevision: 6, projectPath: "/work/beta" })).toThrow("Finish event recovery");
  database.query("UPDATE integration_slack_events SET state = 'processed', result_completed_at = 2").run();
  database.query("INSERT INTO integration_slack_threads (operation_id,channel_id,thread_ts,binding_revision,binding_ref,updated_at) VALUES (?1,'C1','100.1',1,'old-message',1)").run(op.id);
  const rebound = service.rebind(op.id, { expectedRevision: 6, projectPath: "/work/beta" });
  expect(rebound.operation.binding).toMatchObject({ agentId: "beta", projectPath: "/work/beta", revision: 2 });
  expect(rebound.operation.desiredState).toBe("paused");
  expect(rebound.operation.verification).toBeUndefined();
  expect(() => service.authorizeWorker(grant)).toThrow();
  expect(() => service.setup(original)).toThrow("rebound");
  expect(service.setup({ ...request, projectPath: "/work/beta", workspaceId: "T123", displayName: "Alpha" }).operation.id).toBe(op.id);
  expect(database.query<{ binding_revision: number }>("SELECT binding_revision FROM integration_slack_threads").get()?.binding_revision).toBe(1);
});
