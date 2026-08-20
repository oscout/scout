import { describe, expect, test } from "bun:test";

import {
  buildMcpCapabilityMatrixSnapshot,
  evaluateScoutCapabilityAvailability,
  inferMcpToolEffects,
  makeModelCapabilityId,
  makeMcpToolCapabilityId,
  normalizeModelCatalogToScoutCapabilities,
  normalizeMcpToolsToScoutCapabilities,
  type ScoutCapabilityMatrixSnapshot,
} from "./capability-matrix";

describe("capability matrix", () => {
  test("normalizes MCP tools into Scout capability definitions", () => {
    const [capability] = normalizeMcpToolsToScoutCapabilities({
      serverId: "filesystem",
      serverName: "Filesystem",
      protocolVersion: "2025-11-25",
      capturedAt: 1710000000000,
      scope: { projectRoot: "/repo" },
      serverCapabilities: {
        tools: { listChanged: true },
        resources: { subscribe: true },
      },
      tools: [{
        name: "read_file",
        title: "Read File",
        description: "Read a file from the workspace.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
          },
          required: ["path"],
        },
        outputSchema: {
          type: "object",
          properties: {
            text: { type: "string" },
          },
        },
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      }],
    });

    expect(capability).toMatchObject({
      id: "cap:mcp:filesystem:tool:read_file",
      name: "mcp.filesystem.read_file",
      displayName: "Read File",
      provider: "mcp",
      providerId: "filesystem",
      scope: { projectRoot: "/repo" },
      readiness: {
        state: "unknown",
        checkedAt: 1710000000000,
      },
      enforcement: {
        level: "mcp_server",
        trust: "advisory",
      },
      provenance: {
        sourceKind: "mcp_server",
        sourceId: "filesystem",
        sourceName: "Filesystem",
        protocol: "mcp",
        protocolVersion: "2025-11-25",
      },
    });
    expect(capability.methods).toHaveLength(1);
    expect(capability.methods[0]).toMatchObject({
      name: "call",
      displayName: "Read File",
      effects: ["read"],
      idempotent: true,
      hints: {
        readOnly: true,
        idempotent: true,
        openWorld: false,
        annotationsTrusted: false,
      },
      metadata: {
        mcpToolName: "read_file",
      },
    });
    expect(capability.readiness.evidence?.[0]).toMatchObject({
      kind: "protocol_discovery",
      ref: "mcp:filesystem:tools/list",
      trust: "declared",
    });
  });

  test("treats MCP safety annotations as advisory hints", () => {
    const [capability] = normalizeMcpToolsToScoutCapabilities({
      serverId: "deploy",
      capturedAt: 1710000000001,
      tools: {
        tools: [{
          name: "publish",
          description: "Publish the current build.",
          annotations: {
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: true,
          },
        }],
      },
    });

    expect(capability.methods[0].effects).toEqual(["write", "network"]);
    expect(capability.methods[0].requiresApproval).toBe(true);
    expect(capability.methods[0].idempotent).toBe(false);
    expect(capability.methods[0].hints).toMatchObject({
      destructive: true,
      idempotent: false,
      openWorld: true,
      annotationsTrusted: false,
    });
    expect(capability.enforcement).toMatchObject({
      level: "mcp_server",
      trust: "advisory",
    });
  });

  test("keeps unknown as the conservative default", () => {
    const [capability] = normalizeMcpToolsToScoutCapabilities({
      serverId: "opaque",
      capturedAt: 1710000000002,
      tools: [{
        name: "do_thing",
      }],
    });

    expect(capability.methods[0].effects).toEqual(["unknown"]);
    expect(capability.methods[0].requiresApproval).toBeUndefined();
    expect(capability.methods[0].hints).toBeUndefined();
    expect(capability.readiness.state).toBe("unknown");
  });

  test("builds a matrix snapshot around raw MCP discovery", () => {
    const snapshot = buildMcpCapabilityMatrixSnapshot({
      serverId: "browser",
      serverName: "Browser Tools",
      protocolVersion: "2025-11-25",
      capturedAt: 1710000000003,
      serverCapabilities: {
        tools: { listChanged: false },
      },
      tools: {
        tools: [{ name: "navigate", annotations: { openWorldHint: true } }],
      },
    });

    expect(snapshot.generatedAt).toBe(1710000000003);
    expect(snapshot.sources).toHaveLength(1);
    expect(snapshot.sources[0]).toMatchObject({
      kind: "mcp_server",
      id: "browser",
      protocol: "mcp",
      protocolVersion: "2025-11-25",
    });
    expect(snapshot.capabilities.map((capability) => capability.id)).toEqual([
      "cap:mcp:browser:tool:navigate",
    ]);
    expect(snapshot.warnings).toEqual([]);
  });

  test("leaves room for non-MCP matrix sources", () => {
    const snapshot: ScoutCapabilityMatrixSnapshot = {
      generatedAt: 1710000000004,
      sources: [
        {
          kind: "harness_adapter",
          id: "codex",
          capturedAt: 1710000000004,
          raw: { traceObserve: "partial" },
        },
        {
          kind: "provider_catalog",
          id: "local-model-catalog",
          capturedAt: 1710000000004,
          raw: { structuredOutput: true },
        },
        {
          kind: "runtime_probe",
          id: "filesystem-ready",
          capturedAt: 1710000000004,
          raw: { installed: true },
        },
      ],
      capabilities: [],
      warnings: [],
    };

    expect(snapshot.sources.map((source) => source.kind)).toEqual([
      "harness_adapter",
      "provider_catalog",
      "runtime_probe",
    ]);
  });

  test("uses stable MCP capability ids", () => {
    expect(makeMcpToolCapabilityId("server one", "read file")).toBe("cap:mcp:server%20one:tool:read%20file");
  });

  test("normalizes model catalog entries into Scout capabilities", () => {
    const [capability] = normalizeModelCatalogToScoutCapabilities({
      sourceId: "local-models",
      sourceName: "Local Model Catalog",
      capturedAt: 1710000000005,
      scope: { projectRoot: "/repo" },
      models: [{
        providerId: "example",
        modelId: "model-large",
        displayName: "Model Large",
        inputModalities: ["text", "image"],
        outputModalities: ["text"],
        features: {
          streaming: true,
          toolCalling: true,
          structuredOutput: true,
          usageTelemetry: true,
        },
        contextWindowTokens: 128000,
        maxOutputTokens: 8192,
      }],
    });

    expect(capability).toMatchObject({
      id: "cap:model:example:model-large",
      name: "model.example.model-large",
      displayName: "Model Large",
      provider: "model",
      providerId: "example",
      scope: { projectRoot: "/repo" },
      readiness: {
        state: "unknown",
        detail: "Declared by model catalog; provider readiness has not been probed.",
      },
      enforcement: {
        level: "remote_authority",
        trust: "declared",
      },
      provenance: {
        sourceKind: "model_catalog",
        sourceId: "local-models",
        sourceName: "Local Model Catalog",
        capturedAt: 1710000000005,
      },
    });
    expect(capability.methods[0]).toMatchObject({
      name: "invoke",
      effects: ["execute"],
      metadata: {
        inputModalities: ["text", "image"],
        outputModalities: ["text"],
        features: {
          streaming: true,
          toolCalling: true,
          structuredOutput: true,
          usageTelemetry: true,
        },
        contextWindowTokens: 128000,
        maxOutputTokens: 8192,
      },
    });
  });

  test("uses stable model capability ids", () => {
    expect(makeModelCapabilityId("provider one", "model/large")).toBe("cap:model:provider%20one:model%2Flarge");
  });

  test("infers effects conservatively", () => {
    expect(inferMcpToolEffects(undefined)).toEqual(["unknown"]);
    expect(inferMcpToolEffects({ readOnlyHint: true })).toEqual(["read"]);
    expect(inferMcpToolEffects({ destructiveHint: true, openWorldHint: true })).toEqual(["write", "network"]);
  });

  test("evaluates capability availability decisions", () => {
    const snapshot = buildMcpCapabilityMatrixSnapshot({
      serverId: "filesystem",
      capturedAt: 1710000000006,
      tools: [{
        name: "read_file",
        annotations: { readOnlyHint: true },
      }],
      readiness: {
        state: "ready",
        detail: "Server is reachable.",
      },
    });

    expect(evaluateScoutCapabilityAvailability(snapshot, {
      capabilityId: "cap:mcp:filesystem:tool:read_file",
    })).toEqual({
      decision: "allow",
      capabilityId: "cap:mcp:filesystem:tool:read_file",
      methodName: "call",
      reason: "Capability is ready.",
    });
    expect(evaluateScoutCapabilityAvailability(snapshot, {
      capabilityId: "cap:mcp:filesystem:tool:missing",
    })).toEqual({
      decision: "deny",
      capabilityId: "cap:mcp:filesystem:tool:missing",
      reason: "capability_missing",
      detail: "Capability is not present in the current matrix snapshot.",
    });
  });

  test("requires approval before allowing destructive capability methods", () => {
    const snapshot = buildMcpCapabilityMatrixSnapshot({
      serverId: "deploy",
      capturedAt: 1710000000007,
      tools: [{
        name: "publish",
        annotations: { destructiveHint: true },
      }],
      readiness: {
        state: "ready",
      },
    });

    expect(evaluateScoutCapabilityAvailability(snapshot, {
      capabilityId: "cap:mcp:deploy:tool:publish",
    })).toEqual({
      decision: "require_approval",
      capabilityId: "cap:mcp:deploy:tool:publish",
      methodName: "call",
      reason: "method_requires_approval",
      detail: "Capability method requires operator approval before execution.",
    });
  });

  test("evaluates degraded and unknown readiness distinctly", () => {
    const degraded = buildMcpCapabilityMatrixSnapshot({
      serverId: "browser",
      capturedAt: 1710000000008,
      tools: [{ name: "navigate" }],
      readiness: {
        state: "degraded",
        detail: "Browser context is stale.",
      },
    });
    const unknown = buildMcpCapabilityMatrixSnapshot({
      serverId: "opaque",
      capturedAt: 1710000000009,
      tools: [{ name: "do_thing" }],
    });

    expect(evaluateScoutCapabilityAvailability(degraded, {
      capabilityId: "cap:mcp:browser:tool:navigate",
    })).toEqual({
      decision: "downgrade",
      capabilityId: "cap:mcp:browser:tool:navigate",
      methodName: "call",
      reason: "readiness_degraded",
      detail: "Browser context is stale.",
    });
    expect(evaluateScoutCapabilityAvailability(unknown, {
      capabilityId: "cap:mcp:opaque:tool:do_thing",
    })).toMatchObject({
      decision: "unknown",
      reason: "readiness_unknown",
    });
    expect(evaluateScoutCapabilityAvailability(unknown, {
      capabilityId: "cap:mcp:opaque:tool:do_thing",
      requireReady: false,
    })).toMatchObject({
      decision: "allow",
      reason: "Capability readiness is unknown but this check does not require ready state.",
    });
  });
});
