import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openControlPlaneSqliteDatabase, type ControlPlaneSqliteTransactionalDatabase } from "./sqlite-adapter.js";
import { migrateControlPlaneDatabaseSchema } from "./control-plane-migrations.js";
import { BrokerIntegrationSetupService } from "./broker-integration-setup.js";
import { SlackWorkerSupervisor } from "./slack-worker-supervisor.js";

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check()) { if (Date.now() > deadline) throw new Error("Worker fixture did not reach expected state."); await new Promise(resolve => setTimeout(resolve, 10)); }
}
test("starts one process, preserves desired state across supervisor restart, and stops on pause", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scout-slack-supervisor-"));
  const bootstrap = join(directory, "bootstrap.json");
  const helper = join(directory, "secret-fixture");
  writeFileSync(helper, `#!/bin/sh\ncat > '${bootstrap}'\nexec sleep 30\n`, { mode: 0o700 });
  const database = openControlPlaneSqliteDatabase(":memory:", { create: true }) as ControlPlaneSqliteTransactionalDatabase;
  migrateControlPlaneDatabaseSchema(database);
  const deps = {
    database, ownerRealmId: "realm", nodeId: "node",
    snapshot: () => ({ agents: { agent: { id: "agent", definitionId: "project", displayName: "Project", homeNodeId: "node", authorityNodeId: "node", metadata: { projectRoot: "/work/project" } } }, endpoints: {} }) as never,
    verifyCredentials: async () => ({ teamId: "T123", appId: "A123", botId: "B123", botUserId: "U123" }),
  };
  const service = new BrokerIntegrationSetupService(deps);
  const supervisorOptions = { secretExecutable: helper, workerCommand: () => ({ executable: "/unused", args: [] }) };
  const first = new SlackWorkerSupervisor(service, () => "http://127.0.0.1:43110", supervisorOptions);
  let second: SlackWorkerSupervisor | undefined;
  try {
    const op = service.setup({ provider: "slack", mode: "project_agent", projectPath: "/work/project", workspaceId: "T123" }).operation;
    service.resume(op.id, { action: "confirm_authority", expectedRevision: 1 });
    service.resume(op.id, { action: "register_app", expectedRevision: 2, appId: "A123" });
    await service.attachCredentials(op.id, { expectedRevision: 3, reference: { backend: "secret_cli", appTokenKey: "APP", botTokenKey: "BOT" }, allowedUserIds: ["U1"], allowedChannelIds: ["C1"] });
    service.setLifecycle(op.id, { action: "start", expectedRevision: 4 });
    first.start();
    await waitFor(() => existsSync(bootstrap) && readFileSync(bootstrap, "utf8").length > 0);
    const initial = JSON.parse(readFileSync(bootstrap, "utf8"));
    first.reconcile();
    expect(service.workers.observe(op.id)?.generation).toBe(1);
    expect(service.get(op.id).readiness).toBe("not_connected");
    service.heartbeatWorker(initial.grant, true);
    expect(service.get(op.id).readiness).toBe("connected_unverified");
    await first.stop();
    expect(service.get(op.id).operation.desiredState).toBe("running");
    const recovered = new BrokerIntegrationSetupService(deps);
    second = new SlackWorkerSupervisor(recovered, () => "http://127.0.0.1:43110", supervisorOptions);
    second.start();
    await waitFor(() => {
      try { return JSON.parse(readFileSync(bootstrap, "utf8")).grant.generation === 2; } catch { return false; }
    });
    expect(() => recovered.authorizeWorker(initial.grant)).toThrow();
    recovered.setLifecycle(op.id, { action: "pause", expectedRevision: 5 });
    second.reconcile();
    await second.stop();
    expect(recovered.get(op.id).worker?.state).toBe("stopped");
    expect(recovered.wantedWorkers()).toHaveLength(0);
  } finally { await first.stop(); await second?.stop(); database.close?.(); rmSync(directory, { recursive: true, force: true }); }
});
