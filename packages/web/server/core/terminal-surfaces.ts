export type TerminalSurfaceBackend = "tmux" | "zellij" | "herdr";

export type TerminalSurfaceDescriptor = {
  backend: TerminalSurfaceBackend;
  sessionName: string;
  paneId: string | null;
  socketDir: string | null;
};

type TerminalSurfaceInput = {
  transport: string | null | undefined;
  endpointSessionId: string | null | undefined;
  metadata: Record<string, unknown> | null | undefined;
};

export function resolveTerminalSurface(input: TerminalSurfaceInput): TerminalSurfaceDescriptor | null {
  const metadata = input.metadata ?? {};
  const surface = metadataRecord(metadata.terminalSurface);
  const relay = metadataRecord(surface?.relay) ?? metadataRecord(metadata.relay);
  const backend = terminalBackend(
    surface?.backend,
    relay?.backend,
    metadata.terminalBackend,
    metadata.backend,
    input.transport,
  );

  if (!backend) {
    return null;
  }

  const sessionName = backend === "tmux"
    ? firstString(
      surface?.sessionName,
      surface?.terminalSession,
      relay?.sessionName,
      relay?.tmuxSession,
      metadata.terminalSession,
      metadata.tmuxSession,
      input.transport === "tmux" ? input.endpointSessionId : null,
    )
    : backend === "herdr"
      ? firstString(
        surface?.sessionName,
        surface?.terminalSession,
        relay?.sessionName,
        relay?.herdrSession,
        metadata.terminalSession,
        metadata.herdrSession,
        input.transport === "herdr" ? input.endpointSessionId : null,
      )
    : firstString(
      surface?.sessionName,
      surface?.terminalSession,
      relay?.sessionName,
      relay?.zellijSession,
      metadata.terminalSession,
      metadata.zellijSession,
      input.transport === "zellij" ? input.endpointSessionId : null,
    );

  if (!sessionName) {
    return null;
  }

  return {
    backend,
    sessionName,
    paneId: firstString(
      surface?.paneId,
      surface?.zellijPaneId,
      relay?.zellijPaneId,
      metadata.zellijPaneId,
      metadata.tmuxPane,
      metadata.paneTarget,
    ),
    socketDir: backend === "zellij"
      ? firstString(surface?.socketDir, surface?.zellijSocketDir, metadata.zellijSocketDir)
      : null,
  };
}

function terminalBackend(...values: unknown[]): TerminalSurfaceBackend | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const normalized = value.trim().toLowerCase();
    if (normalized === "tmux" || normalized === "zellij" || normalized === "herdr") {
      return normalized;
    }
  }
  return null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function metadataRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
