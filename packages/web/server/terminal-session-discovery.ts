import { formatTerminalSurfaceId } from "@openscout/protocol";
import type {
  TerminalSessionRecord,
  TerminalSurface,
  TerminalSurfaceId,
  TerminalSurfaceState,
} from "@openscout/protocol";

import {
  isKnownTerminalHost,
  terminalHostAdapter,
  terminalHostAdapters,
} from "./terminal-hosts/index.ts";
import type { TerminalHostAdapter, TerminalHostSession } from "./terminal-hosts/index.ts";

type DiscoveredTerminalSession = TerminalSessionRecord & {
  metadata: Record<string, unknown>;
};

type DiscoveryOptions = {
  /** Restrict discovery to one registered host. */
  backend?: string;
  excludeSurfaces?: Iterable<string>;
  limit?: number;
  env?: NodeJS.ProcessEnv;
};

/**
 * Enumerate live host sessions through the host registry. Adding a host means
 * registering an adapter; this function never learns its name.
 */
export async function queryDiscoveredTerminalSessions(
  options: DiscoveryOptions = {},
): Promise<TerminalSessionRecord[]> {
  const env = options.env ?? process.env;
  const excluded = new Set(options.excludeSurfaces ?? []);
  const limit = normalizedDiscoveryLimit(options.limit);
  const adapters = options.backend
    ? [terminalHostAdapter(options.backend)].filter((adapter): adapter is TerminalHostAdapter => adapter !== null)
    : terminalHostAdapters().filter((adapter) => adapter.capabilities.list);

  const sessions: TerminalSessionRecord[] = [];
  for (const adapter of adapters) {
    for (const session of await listHostSessions(adapter, env)) {
      const surface = adapter.surface(session, { env });
      const surfaceId = surface.surfaceId ?? terminalSurfaceKey(adapter.id, session.name);
      if (excluded.has(surfaceId)) continue;
      sessions.push(discoveredRecordFromSurface({ adapter, session, surface, surfaceId }));
    }
  }
  return sessions.slice(0, limit);
}

/**
 * Combine durable Scout registrations with the live host inventory.
 *
 * A registered surface wins identity and resume metadata, while a matching
 * host record contributes authoritative activity. Without this reconciliation
 * the API suppresses the discovered duplicate and accidentally leaves the UI
 * to treat the registration timestamp as terminal activity.
 */
export function reconcileTerminalSessionInventory(
  registered: readonly TerminalSessionRecord[],
  discovered: readonly TerminalSessionRecord[],
  limit: number,
): TerminalSessionRecord[] {
  const discoveredBySurface = new Map<string, TerminalSessionRecord>();
  for (const session of discovered) {
    for (const surface of session.surfaces) {
      discoveredBySurface.set(terminalSurfaceKey(surface.backend, surface.sessionName), session);
    }
  }

  const registeredSurfaces = new Set<string>();
  const enriched = registered.map((session) => {
    const registeredActivityAt = metadataNumber(session.metadata, "activityAt");
    let activityAt = registeredActivityAt;
    for (const surface of session.surfaces) {
      const key = terminalSurfaceKey(surface.backend, surface.sessionName);
      registeredSurfaces.add(key);
      const liveActivityAt = metadataNumber(discoveredBySurface.get(key)?.metadata, "activityAt");
      if (liveActivityAt !== null && (activityAt === null || liveActivityAt > activityAt)) {
        activityAt = liveActivityAt;
      }
    }
    if (activityAt === null || activityAt === registeredActivityAt) {
      return session;
    }
    return {
      ...session,
      metadata: {
        ...(session.metadata ?? {}),
        activityAt,
      },
    };
  });

  const unregistered = discovered.filter((session) =>
    !session.surfaces.some((surface) =>
      registeredSurfaces.has(terminalSurfaceKey(surface.backend, surface.sessionName))
    )
  );
  return [...enriched, ...unregistered].slice(0, limit);
}

function metadataNumber(metadata: Record<string, unknown> | undefined, key: string): number | null {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * A host that is not installed is not an error: it has no sessions. A host that
 * is installed but broken should not take the whole inventory down with it
 * either, so one failing adapter contributes nothing and the rest still list.
 */
async function listHostSessions(
  adapter: TerminalHostAdapter,
  env: NodeJS.ProcessEnv,
): Promise<TerminalHostSession[]> {
  try {
    return await adapter.list({ env });
  } catch {
    return [];
  }
}

export function terminalSurfaceKey(backend: string, sessionName: string): TerminalSurfaceId {
  return formatTerminalSurfaceId({ backend, hostSession: sessionName });
}

export function isDiscoverableTerminalBackend(backend: string | null | undefined): boolean {
  return isKnownTerminalHost(backend);
}

function discoveredRecordFromSurface(input: {
  adapter: TerminalHostAdapter;
  session: TerminalHostSession;
  surface: TerminalSurface;
  surfaceId: TerminalSurfaceId;
}): DiscoveredTerminalSession {
  const now = Date.now();
  return {
    id: `discovered.${input.surfaceId}`,
    // A discovered surface is a live host session, not a known harness session:
    // nothing here says which agent (if any) runs inside it, and there is no
    // resume command for it. Both fields used to be stuffed with the backend
    // and the attach argv, which destroyed the very distinction the protocol
    // header asserts. Leave them empty and declare the origin instead.
    harness: "",
    sourceSessionId: input.session.name,
    cwd: input.session.cwd ?? "",
    resumeCommand: "",
    origin: "discovered",
    surfaces: [input.surface],
    createdAt: now,
    updatedAt: now,
    metadata: {
      source: "backend-discovery",
      registryState: "discovered",
      host: input.adapter.id,
      ...(input.session.attachedClients === null || input.session.attachedClients === undefined
        ? {}
        : { attachedClients: input.session.attachedClients }),
      ...(input.session.currentCommand ? { currentCommand: input.session.currentCommand } : {}),
      ...(input.session.cwd ? { currentPath: input.session.cwd } : {}),
      ...(input.session.state === "live" ? {} : { backendState: input.session.state }),
      ...(input.session.metadata ?? {}),
    },
  };
}

export function parseTmuxSessionList(output: string): Array<{
  name: string;
  windows: number;
  attached: number;
  currentCommand: string | null;
  currentPath: string | null;
}> {
  return output
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, windows, attached, currentCommand, currentPath] = line.includes("|")
        ? splitDelimitedLine(line, "|", 5)
        : splitDelimitedLine(line, "\t", 5);
      if (!name) return null;
      return {
        name,
        windows: parsePositiveInteger(windows, 1),
        attached: parsePositiveInteger(attached, 0),
        currentCommand: cleanOptionalString(currentCommand),
        currentPath: cleanOptionalString(currentPath),
      };
    })
    .filter((session): session is NonNullable<typeof session> => Boolean(session));
}

export function parseZellijSessionList(output: string): Array<{
  name: string;
  state: TerminalSurfaceState;
  raw: string;
}> {
  return stripAnsi(output)
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name] = line.split(/\s+/u);
      if (!name) return null;
      return {
        name,
        state: (/\bEXITED\b/iu.test(line) ? "exited" : "live") as TerminalSurfaceState,
        raw: line,
      };
    })
    .filter((session): session is NonNullable<typeof session> => Boolean(session));
}

function cleanOptionalString(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function splitDelimitedLine(line: string, delimiter: "|" | "\t", fieldCount: number): string[] {
  const parts = line.split(delimiter);
  if (parts.length <= fieldCount) return parts;
  return [...parts.slice(0, fieldCount - 1), parts.slice(fieldCount - 1).join(delimiter)];
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizedDiscoveryLimit(value: number | undefined, fallback = 100, max = 1000): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.min(max, Math.floor(value)));
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "");
}
