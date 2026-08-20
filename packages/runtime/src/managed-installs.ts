import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { resolveOpenScoutSupportPaths } from "./support-paths.js";

export type ManagedInstallKind =
  | "skill"
  | "mcp"
  | "statusline"
  | "hook"
  | "config"
  | "service"
  | "binary";

export type ManagedInstallStatus =
  | "active"
  | "disabled"
  | "missing"
  | "error";

export type ManagedInstallRecord = {
  id: string;
  kind: ManagedInstallKind;
  owner: "openscout" | "hudsonkit" | string;
  name: string;
  title: string;
  status: ManagedInstallStatus;
  harness?: string;
  provider?: string;
  targetPath?: string;
  sourcePath?: string;
  backupPath?: string;
  version?: string;
  installedAt: number;
  updatedAt: number;
  lastVerifiedAt?: number;
  uninstall?: {
    strategy: "delete-target" | "restore-backup" | "manual";
    command?: string;
    notes?: string;
  };
  metadata?: Record<string, unknown>;
};

export type ManagedInstallsFile = {
  version: 1;
  updatedAt: number;
  installs: ManagedInstallRecord[];
};

function emptyManagedInstallsFile(now = Date.now()): ManagedInstallsFile {
  return {
    version: 1,
    updatedAt: now,
    installs: [],
  };
}

function stableInstallId(input: {
  kind: ManagedInstallKind;
  owner: string;
  name: string;
  harness?: string;
  provider?: string;
  targetPath?: string;
}): string {
  const key = [
    input.owner,
    input.kind,
    input.name,
    input.harness ?? "",
    input.provider ?? "",
    input.targetPath ?? "",
  ].join("\0");
  return `install.${createHash("sha256").update(key).digest("hex").slice(0, 18)}`;
}

function normalizeManagedInstallsFile(value: unknown): ManagedInstallsFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return emptyManagedInstallsFile();
  }
  const candidate = value as Partial<ManagedInstallsFile>;
  const installs = Array.isArray(candidate.installs)
    ? candidate.installs.filter((entry): entry is ManagedInstallRecord =>
        Boolean(entry)
        && typeof entry === "object"
        && !Array.isArray(entry)
        && typeof (entry as ManagedInstallRecord).id === "string"
        && typeof (entry as ManagedInstallRecord).kind === "string"
        && typeof (entry as ManagedInstallRecord).name === "string",
      )
    : [];
  return {
    version: 1,
    updatedAt: typeof candidate.updatedAt === "number" ? candidate.updatedAt : Date.now(),
    installs,
  };
}

async function readManagedInstallsFile(path = resolveOpenScoutSupportPaths().managedInstallsPath): Promise<ManagedInstallsFile> {
  try {
    return normalizeManagedInstallsFile(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return emptyManagedInstallsFile();
  }
}

async function writeManagedInstallsFile(file: ManagedInstallsFile, path = resolveOpenScoutSupportPaths().managedInstallsPath): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(file, null, 2) + "\n", "utf8");
}

export async function readManagedInstalls(): Promise<ManagedInstallRecord[]> {
  return (await readManagedInstallsFile()).installs;
}

export async function upsertManagedInstall(
  input: Omit<ManagedInstallRecord, "id" | "installedAt" | "updatedAt"> & {
    id?: string;
    installedAt?: number;
    updatedAt?: number;
  },
  now = Date.now(),
): Promise<ManagedInstallRecord> {
  const file = await readManagedInstallsFile();
  const id = input.id ?? stableInstallId(input);
  const existing = file.installs.find((entry) => entry.id === id);
  const next: ManagedInstallRecord = {
    ...input,
    id,
    installedAt: input.installedAt ?? existing?.installedAt ?? now,
    updatedAt: input.updatedAt ?? now,
  };
  const installs = [
    ...file.installs.filter((entry) => entry.id !== id),
    next,
  ].sort((lhs, rhs) =>
    lhs.kind.localeCompare(rhs.kind)
    || (lhs.harness ?? "").localeCompare(rhs.harness ?? "")
    || lhs.name.localeCompare(rhs.name),
  );
  await writeManagedInstallsFile({
    version: 1,
    updatedAt: now,
    installs,
  });
  return next;
}

export async function removeManagedInstall(id: string, now = Date.now()): Promise<boolean> {
  const file = await readManagedInstallsFile();
  const installs = file.installs.filter((entry) => entry.id !== id);
  if (installs.length === file.installs.length) {
    return false;
  }
  await writeManagedInstallsFile({
    version: 1,
    updatedAt: now,
    installs,
  });
  return true;
}
