import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadRuntimeMcpServerCatalog,
  normalizeRuntimeMcpServerCatalogFile,
  resolveRuntimeMcpServerCatalogPath,
} from "./mcp-server-catalog.js";

describe("runtime MCP server catalog", () => {
  test("resolves the default catalog path under the support catalog directory", () => {
    expect(resolveRuntimeMcpServerCatalogPath().endsWith("catalog/mcp-servers.json")).toBe(true);
  });

  test("normalizes server entries", () => {
    const result = normalizeRuntimeMcpServerCatalogFile({
      servers: [
        {
          id: " files ",
          name: "Filesystem",
          command: "node",
          args: ["server.mjs", 123],
          cwd: "/tmp/project",
          env: { SAFE: "1", SECRET: 123 },
        },
        { id: "", command: "node" },
      ],
    }, { sourcePath: "/tmp/mcp-servers.json" });

    expect(result.servers).toEqual([{
      id: "files",
      name: "Filesystem",
      command: "node",
      args: ["server.mjs"],
      cwd: "/tmp/project",
      env: { SAFE: "1" },
      disabled: false,
    }]);
    expect(result.warnings).toEqual([
      "Ignored invalid MCP server entry 1 in /tmp/mcp-servers.json.",
    ]);
  });

  test("treats absent catalogs as optional", async () => {
    const result = await loadRuntimeMcpServerCatalog({
      path: join(tmpdir(), `missing-mcp-servers-${Date.now()}.json`),
    });

    expect(result).toEqual({ servers: [], warnings: [] });
  });

  test("returns warnings for malformed catalog files", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openscout-mcp-server-catalog-"));
    const path = join(directory, "mcp-servers.json");
    try {
      writeFileSync(path, "{ not json", "utf8");

      const result = await loadRuntimeMcpServerCatalog({ path });

      expect(result.servers).toEqual([]);
      expect(result.warnings[0]).toContain("Could not read MCP server catalog");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
