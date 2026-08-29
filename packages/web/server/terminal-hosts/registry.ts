import { herdrTerminalHost } from "./herdr.ts";
import { tmuxTerminalHost } from "./tmux.ts";
import { zellijTerminalHost } from "./zellij.ts";
import type {
  TerminalHostAdapter,
  TerminalHostAvailability,
  TerminalHostCapabilities,
  TerminalHostContext,
  TerminalHostControlAction,
} from "./types.ts";

/**
 * The terminal host registry.
 *
 * Modelled on `db/internal/paths.ts`'s `HARNESS_SESSION_RESOLVERS` — a record
 * plus a `?? default` fallback. Transports already had a registry; terminal
 * backends had thirty-five if/else branches spread across three languages.
 * Adding a host is an entry here, not a migration.
 */
export const TERMINAL_HOST_ADAPTERS: Record<string, TerminalHostAdapter> = {
  [tmuxTerminalHost.id]: tmuxTerminalHost,
  [zellijTerminalHost.id]: zellijTerminalHost,
  [herdrTerminalHost.id]: herdrTerminalHost,
};

/**
 * The host an unqualified request lands on. tmux is the default because it is
 * the only host every Scout delivery path already drives; the point of naming
 * it here is that it is a CHOICE, not a fallthrough at the end of four
 * different functions.
 */
export const DEFAULT_TERMINAL_HOST_ID = tmuxTerminalHost.id;

export function terminalHostAdapters(): TerminalHostAdapter[] {
  return Object.values(TERMINAL_HOST_ADAPTERS);
}

export function terminalHostAdapter(id: string | null | undefined): TerminalHostAdapter | null {
  const key = id?.trim();
  return key ? TERMINAL_HOST_ADAPTERS[key] ?? null : null;
}

export function resolveTerminalHostAdapter(id: string | null | undefined): TerminalHostAdapter {
  return terminalHostAdapter(id) ?? TERMINAL_HOST_ADAPTERS[DEFAULT_TERMINAL_HOST_ID]!;
}

export function isKnownTerminalHost(id: string | null | undefined): boolean {
  return terminalHostAdapter(id) !== null;
}

/**
 * Verbs a host's own adapter performs.
 *
 * `force-quit-bridge` tears down Scout's relay bridge, not anything on the
 * host, so every host declares it and no adapter implements it. Separating the
 * two is what lets "declares a control verb" and "has a control method" stay
 * equivalent for the verbs that actually reach a host.
 */
export function hostPerformedControlActions(
  capabilities: TerminalHostCapabilities,
): TerminalHostControlAction[] {
  return capabilities.control.filter((action) => action !== "force-quit-bridge");
}

/**
 * The host id to hand the vendored relay, or null when the relay has no bridge
 * for this host.
 *
 * Two conditions, and keeping them in one named place is the point. Whether a
 * bridge should exist is the declared `relayAttach` capability. Whether this
 * relay build can carry it is a narrower fact: the relay is vendored from
 * Hudson under a sync fence and its own API names the backends it spawns in
 * `SessionInitMessage.backend` (pty/tmux/zellij/herdr in the current local
 * overlay), so a fifth host can declare `relayAttach` and still need a relay
 * change first. Callers used to spell the second half as a bare
 * `backend === "tmux" || backend === "zellij"` at the call site, which is
 * correct today and is the line a fourth host forgets.
 */
export function relayCarriedTerminalBackend(
  id: string | null | undefined,
): "tmux" | "zellij" | "herdr" | null {
  const adapter = terminalHostAdapter(id);
  if (!adapter?.capabilities.relayAttach) return null;
  return adapter.id === "tmux" || adapter.id === "zellij" || adapter.id === "herdr"
    ? adapter.id
    : null;
}

/**
 * Whether a host performs a verb itself, or performs it through Scout's
 * harness-aware layer. A UI asks this before drawing the button; a route asks
 * it before doing the work.
 */
export function terminalHostSupportsControl(
  id: string | null | undefined,
  action: TerminalHostControlAction,
): { supported: boolean; via: "host" | "harness" | null } {
  const adapter = terminalHostAdapter(id);
  if (!adapter) return { supported: false, via: null };
  if (adapter.capabilities.control.includes(action)) return { supported: true, via: "host" };
  if (adapter.capabilities.harnessControl.includes(action)) return { supported: true, via: "harness" };
  return { supported: false, via: null };
}

/**
 * Availability is cached briefly per host AND per environment.
 *
 * A binary does not get uninstalled while an operator works, but a `--version`
 * shell-out CAN time out on a loaded machine — and when it did, the host
 * silently disappeared from "start something new". Holding the last successful
 * answer for a short window means a busy box no longer looks like a machine
 * without tmux. A fresh success ANSWERS without spawning: the cache used to be
 * consulted only after a probe failed, so every describe of every host still
 * shelled out on every request — three spawns per caller for an answer the
 * cache already held.
 *
 * Two rules keep that from becoming a lie, and a review reproduced what
 * happens without them.
 *
 * The cache used to be keyed by host id alone, so one successful probe of this
 * process's environment answered for EVERY environment: a probe run with a
 * PATH that contains no terminal hosts at all came back reporting tmux,
 * zellij, and herdr installed, with versions collected somewhere else. An
 * environment is what decides which binary is found, so it belongs in the key.
 *
 * And a substituted answer says so. `stale` marks a reading that came from
 * cache after the current check failed, with a reason naming the age and the
 * failure, so a caller about to shell out can re-probe for real instead of
 * treating a memory as an observation.
 */
const HOST_AVAILABILITY_TTL_MS = 30_000;
const availabilityCache = new Map<string, { at: number; value: TerminalHostAvailability }>();

/** Test seam: drop cached availability. */
export function resetTerminalHostAvailabilityCache(): void {
  availabilityCache.clear();
}

/**
 * Everything about an environment that changes which binary a probe finds:
 * the search path and the explicit binary overrides. Keying on the whole
 * environment would make the cache useless (one entry per distinct object);
 * keying on the host id alone is what let one environment answer for another.
 */
function availabilityCacheKey(adapter: TerminalHostAdapter, context: TerminalHostContext): string {
  const env = context.env ?? process.env;
  return JSON.stringify([
    adapter.id,
    env.PATH ?? "",
    env.OPENSCOUT_TMUX_BIN ?? "",
    env.OPENSCOUT_ZELLIJ_BIN ?? "",
    env.OPENSCOUT_HERDR_BIN ?? "",
  ]);
}

export async function probeTerminalHostAvailability(
  adapter: TerminalHostAdapter,
  context: TerminalHostContext,
  now: number = Date.now(),
): Promise<TerminalHostAvailability> {
  const key = availabilityCacheKey(adapter, context);
  const fresh = availabilityCache.get(key);
  if (fresh && now - fresh.at < HOST_AVAILABILITY_TTL_MS) {
    return fresh.value;
  }
  const availability = await adapter.probe(context).catch((error): TerminalHostAvailability => ({
    installed: false,
    reason: error instanceof Error ? error.message : String(error),
  }));
  if (availability.installed) {
    availabilityCache.set(key, { at: now, value: { ...availability, stale: false, checkedAt: now } });
    return { ...availability, stale: false, checkedAt: now };
  }

  // Re-read after the probe: a concurrent probe can land a success while this
  // one is failing, and that memory is the one worth substituting.
  const cached = availabilityCache.get(key);
  const age = cached ? now - cached.at : Number.POSITIVE_INFINITY;
  if (cached && age < HOST_AVAILABILITY_TTL_MS) {
    return {
      ...cached.value,
      stale: true,
      checkedAt: cached.at,
      reason: `last seen ${Math.max(0, Math.round(age / 1000))}s ago; the current check failed: `
        + `${availability.reason ?? "unknown"}`,
    };
  }
  return { ...availability, stale: false, checkedAt: now };
}

export type TerminalHostDescriptor = {
  id: string;
  label: string;
  description: string;
  capabilities: TerminalHostCapabilities;
  availability: TerminalHostAvailability;
};

/**
 * Every registered host with its live availability. Sorted so installed hosts
 * come first: an operator picking a host should see what they can actually use,
 * and should never have to know which multiplexer is which to get a sane one.
 */
export async function describeTerminalHosts(
  context: TerminalHostContext = {},
): Promise<TerminalHostDescriptor[]> {
  const descriptors = await Promise.all(terminalHostAdapters().map(async (adapter) => ({
    id: adapter.id,
    label: adapter.label,
    description: adapter.description,
    capabilities: adapter.capabilities,
    availability: await probeTerminalHostAvailability(adapter, context),
  })));
  return descriptors.sort((left, right) =>
    Number(right.availability.installed) - Number(left.availability.installed)
    || left.id.localeCompare(right.id)
  );
}

/**
 * Pure preference over an already-probed host list: the first installed host
 * that the web relay can actually render, preferring the declared default.
 * Extracted so a caller already holding `describeTerminalHosts()` output
 * derives the default without probing every host a second time. Returns null
 * when nothing durable is installed — the caller must then offer a plain shell
 * and say so, not default to a host that is not there.
 */
export function preferredTerminalHost(
  hosts: readonly TerminalHostDescriptor[],
): TerminalHostDescriptor | null {
  const usable = hosts.filter((host) => host.availability.installed && host.capabilities.relayAttach);
  return usable.find((host) => host.id === DEFAULT_TERMINAL_HOST_ID) ?? usable[0] ?? null;
}

/** The host Scout picks when the operator has not chosen one. */
export async function resolvePreferredTerminalHost(
  context: TerminalHostContext = {},
): Promise<TerminalHostDescriptor | null> {
  return preferredTerminalHost(await describeTerminalHosts(context));
}
