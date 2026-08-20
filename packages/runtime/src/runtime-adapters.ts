import type { RuntimeEnv, RuntimePlatform } from "./portable-types.js";
export type RuntimeHostKind = "bun" | "node";

export type RuntimeDatabaseAdapterKind =
  | "bun-sqlite"
  | "node-sqlite";

export type RuntimeHttpServerAdapterKind =
  | "bun-serve"
  | "node-http-ws";

export type RuntimeFileAdapterKind =
  | "bun-file"
  | "node-fs";

export type RuntimeProcessAdapterKind =
  | "bun-spawn"
  | "node-child-process";

export type RuntimeServiceAdapterKind =
  | "macos-scoutd"
  | "linux-systemd-user"
  | "headless-foreground"
  | "windows-service";

export type RuntimeAdapterPlan = {
  host: RuntimeHostKind;
  database: RuntimeDatabaseAdapterKind;
  httpServer: RuntimeHttpServerAdapterKind;
  files: RuntimeFileAdapterKind;
  process: RuntimeProcessAdapterKind;
  service: RuntimeServiceAdapterKind;
};

export type RuntimeAdapterPlanOptions = {
  host?: RuntimeHostKind;
  platform?: RuntimePlatform;
  env?: RuntimeEnv;
};

export function detectRuntimeHost(globalScope: typeof globalThis = globalThis): RuntimeHostKind {
  return typeof (globalScope as { Bun?: unknown }).Bun === "undefined" ? "node" : "bun";
}

export function normalizeRuntimeHost(value: string | undefined | null): RuntimeHostKind | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "bun") return "bun";
  if (normalized === "node") return "node";
  return null;
}

export function normalizeRuntimeServiceAdapter(value: string | undefined | null): RuntimeServiceAdapterKind | null {
  const normalized = value?.trim().toLowerCase().replaceAll("_", "-");
  if (normalized === "macos-scoutd" || normalized === "macos-launchd") return "macos-scoutd";
  if (normalized === "linux-systemd-user" || normalized === "systemd-user") return "linux-systemd-user";
  if (normalized === "headless-foreground" || normalized === "foreground" || normalized === "headless") {
    return "headless-foreground";
  }
  if (normalized === "windows-service") return "windows-service";
  return null;
}

export function defaultServiceAdapterForPlatform(
  platform: RuntimePlatform = process.platform,
  env: RuntimeEnv = process.env,
): RuntimeServiceAdapterKind {
  const explicit = normalizeRuntimeServiceAdapter(env.OPENSCOUT_SERVICE_ADAPTER);
  if (explicit) return explicit;

  if (normalizeRuntimeHost(env.OPENSCOUT_RUNTIME_HOST) === "node") {
    return "headless-foreground";
  }

  if (platform === "darwin") return "macos-scoutd";
  if (platform === "linux") return "headless-foreground";
  if (platform === "win32") return "windows-service";
  return "headless-foreground";
}

export function planRuntimeAdapters(options: RuntimeAdapterPlanOptions = {}): RuntimeAdapterPlan {
  const env = options.env ?? process.env;
  const host = options.host
    ?? normalizeRuntimeHost(env.OPENSCOUT_RUNTIME_HOST)
    ?? detectRuntimeHost();

  return {
    host,
    database: host === "bun" ? "bun-sqlite" : "node-sqlite",
    httpServer: host === "bun" ? "bun-serve" : "node-http-ws",
    files: host === "bun" ? "bun-file" : "node-fs",
    process: host === "bun" ? "bun-spawn" : "node-child-process",
    service: defaultServiceAdapterForPlatform(options.platform, env),
  };
}
