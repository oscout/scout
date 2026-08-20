import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { RuntimeMcpServerConfig } from "./mcp-discovery.js";
import { resolveOpenScoutSupportPaths } from "./support-paths.js";

export const RUNTIME_MCP_SERVER_CATALOG_FILE = "mcp-servers.json";

export type RuntimeMcpServerCatalogFile = {
  version?: number;
  servers?: unknown;
  [key: string]: unknown;
};

export type LoadRuntimeMcpServerCatalogOptions = {
  path?: string;
};

export type RuntimeMcpServerCatalogLoadResult = {
  servers: RuntimeMcpServerConfig[];
  warnings: string[];
};

export function resolveRuntimeMcpServerCatalogPath(path?: string): string {
  return path ?? join(resolveOpenScoutSupportPaths().catalogDirectory, RUNTIME_MCP_SERVER_CATALOG_FILE);
}

export async function loadRuntimeMcpServerCatalog(
  options: LoadRuntimeMcpServerCatalogOptions = {},
): Promise<RuntimeMcpServerCatalogLoadResult> {
  const path = resolveRuntimeMcpServerCatalogPath(options.path);
  try {
    const raw = await readFile(path, "utf8");
    return normalizeRuntimeMcpServerCatalogFile(JSON.parse(raw), { sourcePath: path });
  } catch (error) {
    if (isNotFoundError(error)) {
      return { servers: [], warnings: [] };
    }
    return {
      servers: [],
      warnings: [`Could not read MCP server catalog at ${path}: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

export function normalizeRuntimeMcpServerCatalogFile(
  value: unknown,
  options: { sourcePath?: string } = {},
): RuntimeMcpServerCatalogLoadResult {
  if (!value || typeof value !== "object") {
    return {
      servers: [],
      warnings: ["MCP server catalog must be a JSON object."],
    };
  }

  const file = value as RuntimeMcpServerCatalogFile;
  const rawServers = Array.isArray(file.servers) ? file.servers : [];
  const warnings: string[] = [];
  const servers: RuntimeMcpServerConfig[] = [];

  rawServers.forEach((rawServer, index) => {
    const server = normalizeMcpServerConfig(rawServer);
    if (server) {
      servers.push(server);
      return;
    }
    warnings.push(`Ignored invalid MCP server entry ${index} in ${options.sourcePath ?? "catalog"}.`);
  });

  return { servers, warnings };
}

function normalizeMcpServerConfig(value: unknown): RuntimeMcpServerConfig | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const command = typeof raw.command === "string" ? raw.command.trim() : "";
  if (!id || !command) {
    return null;
  }

  return {
    id,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : undefined,
    command,
    args: normalizeStringArray(raw.args),
    cwd: typeof raw.cwd === "string" && raw.cwd.trim() ? raw.cwd.trim() : undefined,
    env: normalizeStringRecord(raw.env),
    disabled: raw.disabled === true,
  };
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .map((entry) => typeof entry === "string" ? entry : null)
    .filter((entry): entry is string => entry !== null);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeStringRecord(value: unknown): Record<string, string | undefined> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const out: Record<string, string | undefined> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") {
      out[key] = entry;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(error)
    && typeof error === "object"
    && (error as { code?: unknown }).code === "ENOENT";
}
