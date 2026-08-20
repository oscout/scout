import { afterEach, describe, expect, test } from "bun:test";

import type { AgentDefinition, AgentEndpoint } from "@openscout/protocol";

import { BrokerDeliveryRouter } from "./broker-delivery-routing.js";
import { BrokerRouteAliasService, BrokerRouteAliasError } from "./broker-route-alias-service.js";
import { BrokerRouteAliasStore } from "./broker-route-alias-store.js";
import { configureControlPlaneDatabase, migrateControlPlaneDatabaseSchema } from "./control-plane-migrations.js";
import { openControlPlaneSqliteDatabase, type ControlPlaneSqliteTransactionalDatabase } from "./sqlite-adapter.js";
import type { RuntimeSnapshot } from "./scout-dispatcher.js";

const PROJECT_A = "/work/alpha";
const PROJECT_B = "/work/beta";
const NODE = "mini-local";

function agent(id: string, handle: string, projectRoot: string): AgentDefinition {
  return {
    id,
    definitionId: handle,
    displayName: handle.toUpperCase(),
    handle,
    selector: handle,
    defaultSelector: handle,
    agentClass: "worker",
    capabilities: [],
    wakePolicy: "auto",
    homeNodeId: NODE,
    authorityNodeId: NODE,
    advertiseScope: "local",
    metadata: { projectRoot },
  };
}

function endpoint(id: string, agentId: string, sessionId: string, projectRoot: string): AgentEndpoint {
  return {
    id,
    agentId,
    nodeId: NODE,
    harness: "codex",
    transport: "codex_app_server",
    state: "idle",
    sessionId,
    cwd: projectRoot,
    projectRoot,
    metadata: { sessionId },
  };
}

function snapshotFixture(): RuntimeSnapshot {
  const alpha = agent("agent-alpha", "alpha", PROJECT_A);
  const beta = agent("agent-beta", "beta", PROJECT_B);
  const alphaEndpoint = endpoint("ep-alpha", alpha.id, "session-alpha", PROJECT_A);
  const betaEndpoint = endpoint("ep-beta", beta.id, "session-beta", PROJECT_B);
  return {
    nodes: {
      [NODE]: { id: NODE, meshId: "realm", name: "mini", hostName: "mini.local", advertiseScope: "local", registeredAt: 1 },
    },
    actors: {
      operator: { id: "operator", kind: "operator", displayName: "Operator" },
      [alpha.id]: { id: alpha.id, kind: "agent", displayName: alpha.displayName, handle: alpha.handle },
      [beta.id]: { id: beta.id, kind: "agent", displayName: beta.displayName, handle: beta.handle },
    },
    agents: { [alpha.id]: alpha, [beta.id]: beta },
    endpoints: { [alphaEndpoint.id]: alphaEndpoint, [betaEndpoint.id]: betaEndpoint },
    conversations: {},
    messages: {},
    invocations: {},
    flights: {},
    bindings: {},
    deliveries: {},
    collaborationRecords: {},
    collaborationEvents: {},
  } as unknown as RuntimeSnapshot;
}

function harness() {
  const database = openControlPlaneSqliteDatabase(":memory:", { create: true }) as ControlPlaneSqliteTransactionalDatabase;
  configureControlPlaneDatabase(database);
  migrateControlPlaneDatabaseSchema(database);
  const snapshot = snapshotFixture();
  let id = 0;
  const service = new BrokerRouteAliasService({
    store: new BrokerRouteAliasStore(database),
    ownerRealmId: "realm",
    nodeId: NODE,
    operatorActorId: "operator",
    runtimeSnapshot: () => snapshot,
    createId: (prefix) => `${prefix}-${++id}`,
    now: () => 1_000,
  });
  return { database, snapshot, service };
}

const databases: ControlPlaneSqliteTransactionalDatabase[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close?.();
});

function setup() {
  const value = harness();
  databases.push(value.database);
  return value;
}

describe("BrokerRouteAliasService", () => {
  test("creates an agent pointer without changing inventory and records immutable history", () => {
    const { snapshot, service } = setup();
    const beforeAgents = Object.keys(snapshot.agents);
    const binding = service.set({
      alias: "review",
      target: { kind: "agent_id", agentId: "agent-alpha" },
      scope: { projectRoot: PROJECT_A },
      caller: { actorId: "operator", currentDirectory: PROJECT_A },
    });

    expect(binding.alias).toBe("review");
    expect(binding.target).toEqual({ kind: "agent", agentId: "agent-alpha", nodeId: NODE });
    expect(binding.revision).toBe(1);
    expect(Object.keys(snapshot.agents)).toEqual(beforeAgents);
    expect(service.history(binding.id).map((entry) => entry.operation)).toEqual(["set"]);
  });

  test("rejects reserved names, alias chains, and native-name collisions", () => {
    const { service } = setup();
    expect(() => service.set({ alias: "session", target: { kind: "agent_id", agentId: "agent-alpha" }, scope: { projectRoot: PROJECT_A } }))
      .toThrow(BrokerRouteAliasError);
    expect(() => service.set({ alias: "Review", target: { kind: "agent_id", agentId: "agent-alpha" }, scope: { projectRoot: PROJECT_A } }))
      .toThrow(/invalid route alias/i);
    expect(() => service.set({ alias: "alpha", target: { kind: "agent_id", agentId: "agent-alpha" }, scope: { projectRoot: PROJECT_A } }))
      .toThrow(/collides with native agent/i);
    expect(() => service.set({ alias: "review", target: { kind: "route_alias", alias: "other" }, scope: { projectRoot: PROJECT_A } }))
      .toThrow(/cannot target another alias/i);
    expect(() => service.set({
      alias: "profile-review",
      target: { kind: "runtime_profile", profile: "opus", projectPath: PROJECT_A },
      scope: { projectRoot: PROJECT_A },
    })).toThrow(/runtime_profile is not bindable/i);
  });

  test("allows exact existing handles but never falls through from them to route aliases", async () => {
    const { service, snapshot } = setup();
    const binding = service.set({
      alias: "composer-review",
      target: { kind: "existing_handle", handle: "alpha" },
      scope: { projectRoot: PROJECT_A },
    });
    expect(binding.target).toEqual({ kind: "agent", agentId: "agent-alpha", nodeId: NODE });

    const router = new BrokerDeliveryRouter({
      runtimeSnapshot: () => snapshot,
      nodeId: NODE,
      isInactiveLocalAgent: () => false,
      routeAliasService: service,
    });
    const result = await router.resolveWithImplicitProjectAgent({
      target: { kind: "existing_handle", handle: "composer-review", value: "@composer-review" },
      targetLabel: "@composer-review",
    }, {
      requesterId: "operator",
      currentDirectory: PROJECT_A,
      reason: "test exact existing handle",
    });

    expect(result).toEqual({
      kind: "unknown",
      label: "@composer-review",
      detail: "no live agent handle, selector, or session handle exactly matches @composer-review",
    });

    const profileResult = await router.resolveWithImplicitProjectAgent({
      target: {
        kind: "runtime_profile",
        profile: "composer-review",
        projectPath: PROJECT_A,
      },
      targetLabel: "composer-review",
    }, {
      requesterId: "operator",
      currentDirectory: PROJECT_A,
      reason: "test invalid runtime profile",
    });
    expect(profileResult).toEqual({
      kind: "unknown",
      label: "profile:composer-review",
      detail: 'unknown runtime profile "composer-review"',
    });
  });

  test("repoints atomically with CAS and preserves the dispatch proof revision", () => {
    const { service } = setup();
    const original = service.set({
      alias: "review",
      target: { kind: "agent_id", agentId: "agent-alpha" },
      scope: { projectRoot: PROJECT_A },
    });
    const acceptedBefore = service.resolveForDispatch({ kind: "route_alias", alias: "review", scope: { projectRoot: PROJECT_A } });
    const updated = service.repoint(original.id, {
      target: { kind: "session_id", sessionId: "session-alpha" },
      expectedRevision: 1,
    });

    expect(updated.revision).toBe(2);
    expect(updated.target.kind).toBe("session");
    expect(acceptedBefore.proof.revision).toBe(1);
    expect(acceptedBefore.proof.target).toEqual({ kind: "agent", agentId: "agent-alpha", nodeId: NODE });
    expect(() => service.repoint(original.id, {
      target: { kind: "agent_id", agentId: "agent-alpha" },
      expectedRevision: 1,
    })).toThrow(/current revision is 2/i);
    expect(service.history(original.id).map((entry) => entry.operation)).toEqual(["repoint", "set"]);
  });

  test("keeps same-name aliases isolated by project and native agents ahead of bare aliases", async () => {
    const { service, snapshot } = setup();
    service.set({ alias: "review", target: { kind: "agent_id", agentId: "agent-alpha" }, scope: { projectRoot: PROJECT_A } });
    service.set({ alias: "review", target: { kind: "agent_id", agentId: "agent-beta" }, scope: { projectRoot: PROJECT_B } });
    const router = new BrokerDeliveryRouter({
      runtimeSnapshot: () => snapshot,
      nodeId: NODE,
      isInactiveLocalAgent: () => false,
      routeAliasService: service,
    });

    const a = await router.resolveWithImplicitProjectAgent({ target: { kind: "agent_label", label: "review" } }, {
      requesterId: "operator", currentDirectory: PROJECT_A, reason: "test",
    });
    const b = await router.resolveWithImplicitProjectAgent({ target: { kind: "agent_label", label: "review" } }, {
      requesterId: "operator", currentDirectory: PROJECT_B, reason: "test",
    });
    const native = await router.resolveWithImplicitProjectAgent({ target: { kind: "agent_label", label: "alpha" } }, {
      requesterId: "operator", currentDirectory: PROJECT_A, reason: "test",
    });
    expect(a.kind === "resolved" ? a.agent.id : null).toBe("agent-alpha");
    expect(b.kind === "resolved" ? b.agent.id : null).toBe("agent-beta");
    expect(native.kind === "resolved" ? native.agent.id : null).toBe("agent-alpha");
  });

  test("uses authoritative remote resolution for an explicitly host-qualified alias", async () => {
    const { service, snapshot } = setup();
    const remoteBinding = service.set({
      alias: "review",
      target: { kind: "agent_id", agentId: "agent-beta" },
      scope: { projectRoot: PROJECT_B },
    });
    let remoteCalls = 0;
    const router = new BrokerDeliveryRouter({
      runtimeSnapshot: () => snapshot,
      nodeId: NODE,
      isInactiveLocalAgent: () => false,
      routeAliasService: service,
      resolveRemoteRouteAlias: async (target) => {
        remoteCalls += 1;
        return {
          resolution: { kind: "resolved", agent: snapshot.agents["agent-beta"]! },
          binding: remoteBinding,
          proof: {
            bindingId: remoteBinding.id,
            revision: remoteBinding.revision,
            requestedAlias: target.alias,
            scope: { projectKey: remoteBinding.scopeProjectKey, projectRoot: PROJECT_B, nodeId: "node-remote" },
            target: { kind: "agent", agentId: "agent-beta", nodeId: "node-remote" },
            resolvedAt: 1_000,
          },
        };
      },
    });

    const resolution = await router.resolveWithImplicitProjectAgent({
      target: { kind: "route_alias", alias: "review", scope: { projectRoot: PROJECT_B, nodeId: "node-remote" } },
    }, { requesterId: "operator", currentDirectory: PROJECT_A, reason: "test" });
    expect(remoteCalls).toBe(1);
    expect(resolution.kind === "resolved" ? resolution.agent.id : null).toBe("agent-beta");
    expect(resolution.aliasResolution).toMatchObject({ requestedAlias: "review", revision: 1 });
  });

  test("exact-session aliases never float and expire when the pinned endpoint becomes terminal", () => {
    const { service, snapshot } = setup();
    const binding = service.set({
      alias: "patch",
      target: { kind: "session_id", sessionId: "session-alpha" },
      scope: { projectRoot: PROJECT_A },
    });
    expect(binding.target).toMatchObject({ kind: "session", sessionId: "session-alpha", endpointId: "ep-alpha" });
    snapshot.endpoints["ep-alpha"] = { ...snapshot.endpoints["ep-alpha"]!, state: "stopped" };
    const resolved = service.resolve({ alias: "patch", scope: { projectRoot: PROJECT_A } });
    expect(resolved.resolved).toBe(false);
    expect(resolved.diagnostic?.code).toBe("alias_session_terminal");
    expect(resolved.binding?.state).toBe("expired");
    expect(resolved.binding?.revision).toBe(2);
    expect(service.history(binding.id)[0]?.operation).toBe("expire");
  });

  test("rejects aliases to an already-terminal session and prevents self-claim replacement", () => {
    const { service, snapshot } = setup();
    snapshot.endpoints["ep-alpha"] = { ...snapshot.endpoints["ep-alpha"]!, state: "stopped" };
    expect(() => service.set({
      alias: "patch",
      target: { kind: "session_id", sessionId: "session-alpha" },
      scope: { projectRoot: PROJECT_A },
    })).toThrow(/terminal or no longer reachable/i);

    snapshot.endpoints["ep-alpha"] = endpoint("ep-alpha", "agent-alpha", "session-alpha", PROJECT_A);
    service.set({ alias: "review", target: { kind: "agent_id", agentId: "agent-alpha" }, scope: { projectRoot: PROJECT_A } });
    expect(() => service.set({
      alias: "review",
      replace: true,
      self: "agent",
      scope: { projectRoot: PROJECT_A },
      caller: { actorId: "agent-alpha", currentDirectory: PROJECT_A },
    })).toThrow(/owner authority/i);
  });

  test("unset is a soft revocation and reusing the name creates a new binding id", () => {
    const { service } = setup();
    const first = service.set({ alias: "review", target: { kind: "agent_id", agentId: "agent-alpha" }, scope: { projectRoot: PROJECT_A } });
    const unset = service.unset(first.id, { expectedRevision: 1 });
    const second = service.set({ alias: "review", target: { kind: "agent_id", agentId: "agent-alpha" }, scope: { projectRoot: PROJECT_A } });
    expect(unset.state).toBe("unset");
    expect(unset.revision).toBe(2);
    expect(second.id).not.toBe(first.id);
  });
});
