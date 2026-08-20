import { describe, expect, test } from "bun:test";

import {
  buildHarnessSupportInputFromCatalogEntry,
  buildHarnessSupportInputsFromCatalogSnapshot,
  buildHarnessReadinessProbeInputFromCatalogEntry,
  buildHarnessReadinessProbeInputsFromCatalogSnapshot,
  buildRuntimeCapabilityMatrixSnapshot,
} from "./capability-matrix.js";
import { createBuiltInHarnessCatalog, type HarnessCatalogSnapshot } from "./harness-catalog.js";

describe("runtime capability matrix", () => {
  test("composes MCP, harness, provider, model, probe, and annotation inputs", () => {
    const snapshot = buildRuntimeCapabilityMatrixSnapshot({
      generatedAt: 1710000000100,
      scope: { projectRoot: "/repo" },
      warnings: ["preexisting warning"],
      inputs: [
        {
          kind: "mcp_tools",
          serverId: "filesystem",
          serverName: "Filesystem",
          protocolVersion: "2025-11-25",
          tools: [{
            name: "read_file",
            annotations: {
              readOnlyHint: true,
              idempotentHint: true,
            },
          }],
        },
        {
          kind: "harness_support",
          id: "codex",
          name: "Codex adapter",
          support: {
            session: {
              traceObserve: {
                level: "partial",
                reason: "Structured trace is available only for attached sessions.",
              },
            },
            tools: {
              mcpStdio: {
                level: "yes",
              },
            },
          },
        },
        {
          kind: "provider_catalog",
          id: "providers",
          raw: {
            structuredOutput: true,
          },
        },
        {
          kind: "model_catalog",
          id: "models",
          raw: {
            embeddings: true,
          },
        },
        {
          kind: "runtime_probe",
          id: "filesystem-server-reachable",
          raw: {
            reachable: true,
          },
        },
        {
          kind: "human_annotation",
          id: "labels",
          raw: {
            risk: "low",
          },
        },
      ],
    });

    expect(snapshot.generatedAt).toBe(1710000000100);
    expect(snapshot.scope).toEqual({ projectRoot: "/repo" });
    expect(snapshot.capabilities.map((capability) => capability.id)).toEqual([
      "cap:mcp:filesystem:tool:read_file",
    ]);
    expect(snapshot.capabilities[0]?.scope).toEqual({ projectRoot: "/repo" });
    expect(snapshot.sources.map((source) => source.kind)).toEqual([
      "mcp_server",
      "harness_adapter",
      "provider_catalog",
      "model_catalog",
      "runtime_probe",
      "human_annotation",
    ]);
    expect(snapshot.harnessSupport?.codex?.session?.traceObserve?.level).toBe("partial");
    expect(snapshot.harnessSupport?.codex?.tools?.mcpStdio?.level).toBe("yes");
    expect(snapshot.warnings).toEqual(["preexisting warning"]);
  });

  test("uses input timestamps when supplied and defaults everything else to the snapshot timestamp", () => {
    const snapshot = buildRuntimeCapabilityMatrixSnapshot({
      generatedAt: 1710000000200,
      inputs: [
        {
          kind: "mcp_tools",
          serverId: "browser",
          capturedAt: 1710000000201,
          tools: [{ name: "navigate" }],
        },
        {
          kind: "runtime_probe",
          id: "browser-ready",
          raw: { ready: false },
        },
      ],
    });

    expect(snapshot.sources).toMatchObject([
      { kind: "mcp_server", capturedAt: 1710000000201 },
      { kind: "runtime_probe", capturedAt: 1710000000200 },
    ]);
    expect(snapshot.capabilities[0]?.provenance.capturedAt).toBe(1710000000201);
  });

  test("deduplicates capabilities by stable id with later inputs winning", () => {
    const snapshot = buildRuntimeCapabilityMatrixSnapshot({
      generatedAt: 1710000000300,
      inputs: [
        {
          kind: "mcp_tools",
          serverId: "server",
          tools: [{ name: "search", title: "Search" }],
        },
        {
          kind: "mcp_tools",
          serverId: "server",
          tools: [{ name: "search", title: "Search Updated" }],
        },
      ],
    });

    expect(snapshot.capabilities).toHaveLength(1);
    expect(snapshot.capabilities[0]?.displayName).toBe("Search Updated");
    expect(snapshot.sources).toHaveLength(2);
  });

  test("normalizes model catalog entries into mixed runtime snapshots", () => {
    const snapshot = buildRuntimeCapabilityMatrixSnapshot({
      generatedAt: 1710000000350,
      scope: { projectRoot: "/repo" },
      inputs: [{
        kind: "model_catalog",
        id: "models",
        name: "Model Catalog",
        raw: { source: "test" },
        models: [{
          providerId: "example",
          modelId: "embedder",
          displayName: "Example Embedder",
          inputModalities: ["text"],
          outputModalities: ["embedding"],
          features: {
            embeddings: true,
            usageTelemetry: true,
          },
        }],
      }],
    });

    expect(snapshot.sources).toMatchObject([{
      kind: "model_catalog",
      id: "models",
      name: "Model Catalog",
    }]);
    expect(snapshot.capabilities).toHaveLength(1);
    expect(snapshot.capabilities[0]).toMatchObject({
      id: "cap:model:example:embedder",
      provider: "model",
      providerId: "example",
      readiness: {
        state: "unknown",
      },
      methods: [{
        name: "invoke",
        effects: ["execute"],
        metadata: {
          inputModalities: ["text"],
          outputModalities: ["embedding"],
          features: {
            embeddings: true,
            usageTelemetry: true,
          },
        },
      }],
    });
  });

  test("projects harness catalog entries into conservative feature support maps", () => {
    const codex = createBuiltInHarnessCatalog().find((entry) => entry.name === "codex");
    expect(codex).toBeTruthy();

    const input = buildHarnessSupportInputFromCatalogEntry(codex!, {
      capturedAt: 1710000000400,
    });
    const snapshot = buildRuntimeCapabilityMatrixSnapshot({
      generatedAt: 1710000000400,
      inputs: [input],
    });

    expect(snapshot.sources).toMatchObject([{
      kind: "harness_adapter",
      id: "codex",
      name: "Codex",
      capturedAt: 1710000000400,
    }]);
    expect(snapshot.harnessSupport?.codex?.session?.start).toMatchObject({
      level: "yes",
      evidence: [{ kind: "catalog", ref: "harness-catalog:codex" }],
    });
    expect(snapshot.harnessSupport?.codex?.session?.resume?.level).toBe("yes");
    expect(snapshot.harnessSupport?.codex?.session?.traceObserve).toMatchObject({
      level: "unknown",
      reason: "Harness catalog does not declare trace observation support.",
    });
    expect(snapshot.harnessSupport?.codex?.tools?.command).toMatchObject({
      level: "partial",
      downgrade: "embedded",
    });
    expect(snapshot.harnessSupport?.codex?.tools?.fileChange?.level).toBe("no");
    expect(snapshot.harnessSupport?.codex?.auth?.apiKey?.level).toBe("yes");
    expect(snapshot.harnessSupport?.codex?.auth?.authFile?.level).toBe("yes");
    expect(snapshot.harnessSupport?.codex?.auth?.localLogin?.level).toBe("yes");
  });

  test("projects catalog snapshots into one harness support input per entry", () => {
    const snapshot: HarnessCatalogSnapshot = {
      version: 1,
      generatedAt: 1710000000500,
      entries: [{
        ...createBuiltInHarnessCatalog()[0]!,
        source: "builtin",
        readinessReport: {
          state: "missing",
          installed: false,
          configured: false,
          ready: false,
          detail: "Missing binary.",
          missing: ["claude"],
          binaryPath: null,
          loginCommand: "claude login",
        },
      }],
    };

    const inputs = buildHarnessSupportInputsFromCatalogSnapshot(snapshot);

    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      kind: "harness_support",
      id: "claude",
      name: "Claude Code",
      capturedAt: 1710000000500,
      raw: {
        name: "claude",
        source: "builtin",
        readinessReport: {
          state: "missing",
        },
      },
    });
  });

  test("projects harness readiness reports as runtime probe inputs", () => {
    const codex = {
      ...createBuiltInHarnessCatalog().find((entry) => entry.name === "codex")!,
      source: "builtin" as const,
      readinessReport: {
        state: "installed" as const,
        installed: true,
        configured: false,
        ready: false,
        detail: "Codex is installed but not authenticated yet.",
        missing: ["one of: OPENAI_API_KEY, ~/.codex/auth.json"],
        binaryPath: "/usr/local/bin/codex",
        binaryVersion: "codex 1.0.0",
        binarySource: "path",
        loginCommand: "codex login",
      },
    };

    const input = buildHarnessReadinessProbeInputFromCatalogEntry(codex, {
      capturedAt: 1710000000600,
    });
    const snapshot = buildRuntimeCapabilityMatrixSnapshot({
      generatedAt: 1710000000600,
      inputs: [
        buildHarnessSupportInputFromCatalogEntry(codex, { capturedAt: 1710000000600 }),
        input,
      ],
    });

    expect(input).toEqual({
      kind: "runtime_probe",
      id: "harness:codex:readiness",
      name: "Codex readiness",
      capturedAt: 1710000000600,
      raw: {
        target: "harness",
        name: "codex",
        harness: "codex",
        state: "installed",
        installed: true,
        configured: false,
        ready: false,
        detail: "Codex is installed but not authenticated yet.",
        missing: ["one of: OPENAI_API_KEY, ~/.codex/auth.json"],
        binaryPath: "/usr/local/bin/codex",
        binaryVersion: "codex 1.0.0",
        binarySource: "path",
        loginCommand: "codex login",
      },
    });
    expect(snapshot.sources.map((source) => source.kind)).toEqual([
      "harness_adapter",
      "runtime_probe",
    ]);
    expect(snapshot.harnessSupport?.codex?.session?.start?.level).toBe("yes");
  });

  test("projects catalog snapshots into one readiness probe per entry", () => {
    const snapshot: HarnessCatalogSnapshot = {
      version: 1,
      generatedAt: 1710000000700,
      entries: [{
        ...createBuiltInHarnessCatalog()[0]!,
        source: "builtin",
        readinessReport: {
          state: "ready",
          installed: true,
          configured: true,
          ready: true,
          detail: "Ready.",
          missing: [],
          binaryPath: "/usr/local/bin/claude",
          loginCommand: "claude login",
        },
      }],
    };

    const inputs = buildHarnessReadinessProbeInputsFromCatalogSnapshot(snapshot);

    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      kind: "runtime_probe",
      id: "harness:claude:readiness",
      capturedAt: 1710000000700,
      raw: {
        target: "harness",
        ready: true,
      },
    });
  });
});
