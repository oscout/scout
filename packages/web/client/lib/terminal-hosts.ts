import { useEffect, useState } from "react";

import { api } from "./api.ts";
import type { TerminalHostDescriptor, TerminalHostsPayload } from "./terminal-host-capabilities.ts";

export * from "./terminal-host-capabilities.ts";

export type TerminalHostSessionCreateResult = {
  ok: boolean;
  created: boolean;
  hostId: string;
  sessionName: string;
  detail?: string;
};

export async function fetchTerminalHosts(): Promise<TerminalHostsPayload> {
  return api<TerminalHostsPayload>("/api/terminal-hosts");
}

/** Ask a host to bring a named session into existence. */
export async function createTerminalHostSession(
  hostId: string,
  input: { sessionName: string; cwd?: string | null },
): Promise<TerminalHostSessionCreateResult> {
  return api<TerminalHostSessionCreateResult>(
    `/api/terminal-hosts/${encodeURIComponent(hostId)}/sessions`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

// The inventory is a probe of installed binaries; it changes when someone
// installs a multiplexer, not while an operator works. One fetch per mount,
// shared through a module-level cache so a screen full of tiles does not probe
// the host once per tile.
let cachedHosts: TerminalHostsPayload | null = null;
let inFlight: Promise<TerminalHostsPayload> | null = null;

export function loadTerminalHosts(): Promise<TerminalHostsPayload> {
  if (cachedHosts) return Promise.resolve(cachedHosts);
  inFlight ??= fetchTerminalHosts()
    .then((payload) => {
      cachedHosts = payload;
      return payload;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Test seam: drop the cached inventory. */
export function resetTerminalHostsCache(): void {
  cachedHosts = null;
  inFlight = null;
}

export function useTerminalHosts(): {
  hosts: TerminalHostDescriptor[];
  preferredHostId: string | null;
  loaded: boolean;
} {
  const [payload, setPayload] = useState<TerminalHostsPayload | null>(cachedHosts);

  useEffect(() => {
    if (payload) return;
    let cancelled = false;
    void loadTerminalHosts()
      .then((next) => {
        if (!cancelled) setPayload(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [payload]);

  return {
    hosts: payload?.hosts ?? [],
    preferredHostId: payload?.preferredHostId ?? null,
    loaded: payload !== null,
  };
}
