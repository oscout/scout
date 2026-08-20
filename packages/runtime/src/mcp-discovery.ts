import type { RuntimeSignal } from "./portable-types.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type {
  McpServerCapabilities,
  McpToolDefinition,
  McpToolsListResult,
  ScoutCapabilityScope,
} from "@openscout/protocol";

import { redactSecrets } from "@openscout/agent-sessions/secret-redaction";
import type { RuntimeCapabilityMatrixInput } from "./capability-matrix.js";

export type RuntimeMcpServerConfig = {
  id: string;
  name?: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  disabled?: boolean;
};

export type McpDiscoveryJsonRpcTransport = {
  request<TResult = unknown>(method: string, params?: unknown): Promise<TResult>;
  notify(method: string, params?: unknown): Promise<void>;
  close(): Promise<void>;
};

export type DiscoverMcpServersOptions = {
  servers: RuntimeMcpServerConfig[];
  scope?: ScoutCapabilityScope;
  now?: () => number;
  requestedProtocolVersion?: string;
  clientInfo?: {
    name: string;
    title?: string;
    version: string;
  };
  maxToolListPages?: number;
  createTransport?: (server: RuntimeMcpServerConfig) => McpDiscoveryJsonRpcTransport;
};

export type DiscoverMcpServersResult = {
  inputs: RuntimeCapabilityMatrixInput[];
  warnings: string[];
};

type McpInitializeResult = {
  protocolVersion?: string;
  capabilities?: McpServerCapabilities;
  serverInfo?: {
    name?: string;
    title?: string;
    version?: string;
  };
};

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
};

type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export async function discoverConfiguredMcpServers(
  options: DiscoverMcpServersOptions,
): Promise<DiscoverMcpServersResult> {
  const now = options.now ?? Date.now;
  const inputs: RuntimeCapabilityMatrixInput[] = [];
  const warnings: string[] = [];

  for (const server of options.servers) {
    if (server.disabled) {
      inputs.push(buildMcpProbeInput(server, now(), "disabled", "MCP server is disabled."));
      continue;
    }

    let transport: McpDiscoveryJsonRpcTransport | null = null;
    try {
      transport = options.createTransport?.(server) ?? createStdioMcpDiscoveryTransport(server);
      const discovered = await discoverOneMcpServer({
        server,
        transport,
        scope: options.scope,
        capturedAt: now(),
        requestedProtocolVersion: options.requestedProtocolVersion,
        clientInfo: options.clientInfo,
        maxToolListPages: options.maxToolListPages,
      });
      inputs.push(discovered);
    } catch (error) {
      const reason = errorMessage(error);
      warnings.push(`MCP server ${server.id} discovery failed: ${reason}`);
      inputs.push(buildMcpProbeInput(server, now(), "failed", reason));
    } finally {
      await transport?.close().catch(() => undefined);
    }
  }

  return { inputs, warnings };
}

export function createStdioMcpDiscoveryTransport(
  server: RuntimeMcpServerConfig,
  options: { requestTimeoutMs?: number } = {},
): McpDiscoveryJsonRpcTransport {
  const child = spawn(server.command, server.args ?? [], {
    cwd: server.cwd,
    env: {
      ...process.env,
      ...server.env,
    },
    stdio: "pipe",
  });
  return new StdioJsonRpcTransport(child, options.requestTimeoutMs ?? 10_000);
}

async function discoverOneMcpServer(options: {
  server: RuntimeMcpServerConfig;
  transport: McpDiscoveryJsonRpcTransport;
  scope?: ScoutCapabilityScope;
  capturedAt: number;
  requestedProtocolVersion?: string;
  clientInfo?: DiscoverMcpServersOptions["clientInfo"];
  maxToolListPages?: number;
}): Promise<RuntimeCapabilityMatrixInput> {
  const initialize = await options.transport.request<McpInitializeResult>("initialize", {
    protocolVersion: options.requestedProtocolVersion ?? "2025-11-25",
    capabilities: {},
    clientInfo: options.clientInfo ?? {
      name: "openscout-runtime",
      title: "OpenScout Runtime",
      version: "0.0.0",
    },
  });
  await options.transport.notify("notifications/initialized");

  const tools = await listMcpTools(options.transport, options.maxToolListPages ?? 20);
  return {
    kind: "mcp_tools",
    serverId: options.server.id,
    serverName: options.server.name ?? initialize.serverInfo?.title ?? initialize.serverInfo?.name,
    protocolVersion: initialize.protocolVersion ?? options.requestedProtocolVersion,
    capturedAt: options.capturedAt,
    scope: options.scope,
    serverCapabilities: initialize.capabilities,
    tools,
    enabled: true,
    readiness: {
      state: "ready",
      detail: "MCP server responded to initialize and tools/list.",
      checkedAt: options.capturedAt,
      evidence: [{
        kind: "runtime_probe",
        ref: `mcp:${options.server.id}:initialize+tools/list`,
        sourceId: options.server.id,
        observedAt: options.capturedAt,
        protocol: "mcp",
        protocolVersion: initialize.protocolVersion ?? options.requestedProtocolVersion,
        trust: "observed",
      }],
    },
  };
}

async function listMcpTools(
  transport: McpDiscoveryJsonRpcTransport,
  maxPages: number,
): Promise<McpToolsListResult> {
  const tools: McpToolDefinition[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page += 1) {
    const result = await transport.request<McpToolsListResult>(
      "tools/list",
      cursor ? { cursor } : undefined,
    );
    tools.push(...(result.tools ?? []));
    cursor = result.nextCursor;
    if (!cursor) {
      return { ...result, tools };
    }
  }

  return { tools, nextCursor: cursor };
}

function buildMcpProbeInput(
  server: RuntimeMcpServerConfig,
  capturedAt: number,
  state: "disabled" | "failed",
  reason: string,
): RuntimeCapabilityMatrixInput {
  return {
    kind: "runtime_probe",
    id: `mcp:${server.id}`,
    name: server.name,
    capturedAt,
    raw: {
      target: "mcp_server",
      serverId: server.id,
      state,
      reason,
    },
  };
}

class StdioJsonRpcTransport implements McpDiscoveryJsonRpcTransport {
  private nextId = 1;
  private buffer = "";
  private stderr = "";
  private pending = new Map<number, PendingRequest>();
  private closed = false;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly requestTimeoutMs: number,
  ) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
      if (this.stderr.length > 4_000) {
        this.stderr = this.stderr.slice(-4_000);
      }
    });
    child.once("error", (error) => this.rejectAll(error));
    child.once("exit", (code, signal) => {
      this.closed = true;
      if (this.pending.size > 0) {
        this.rejectAll(new Error(`MCP server exited before replying (${formatExit(code, signal)}).${this.formatStderr()}`));
      }
    });
  }

  async request<TResult = unknown>(method: string, params?: unknown): Promise<TResult> {
    if (this.closed) {
      throw new Error("MCP transport is closed.");
    }

    const id = this.nextId;
    this.nextId += 1;
    const message: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params }),
    };

    return new Promise<TResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}.${this.formatStderr()}`));
      }, this.requestTimeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value as TResult),
        reject,
        timeout,
      });
      this.write(message).catch((error) => {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this.closed) {
      return;
    }
    const message: JsonRpcNotification = {
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    };
    await this.write(message);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.rejectAll(new Error("MCP transport closed."));
    if (!this.child.killed) {
      this.child.kill();
    }
  }

  private handleStdout(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) {
        continue;
      }
      this.handleMessage(line);
    }
  }

  private handleMessage(line: string): void {
    let response: JsonRpcResponse;
    try {
      response = JSON.parse(line) as JsonRpcResponse;
    } catch (error) {
      this.rejectAll(new Error(`Invalid MCP JSON-RPC response: ${errorMessage(error)}`));
      return;
    }

    if (typeof response.id !== "number") {
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }
    this.pending.delete(response.id);
    clearTimeout(pending.timeout);
    if (response.error) {
      pending.reject(new Error(response.error.message ?? `MCP request failed with code ${String(response.error.code)}`));
      return;
    }
    pending.resolve(response.result);
  }

  private async write(message: JsonRpcRequest | JsonRpcNotification): Promise<void> {
    const line = `${JSON.stringify(message)}\n`;
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(line, "utf8", (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
  }

  private formatStderr(): string {
    const text = this.stderr.trim();
    return text ? ` stderr: ${redactSecrets(text)}` : "";
  }
}

function formatExit(code: number | null, signal: RuntimeSignal | null): string {
  if (code !== null) {
    return `code ${code}`;
  }
  if (signal) {
    return `signal ${signal}`;
  }
  return "unknown exit";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
