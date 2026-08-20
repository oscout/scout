/**
 * Client-side preferred durable backend helper.
 * Server may also probe binaries; the client uses a lightweight localStorage override
 * plus the same preference order when a host reports availability.
 */

export type PreferredTerminalBackend = "herdr" | "tmux" | "zellij" | "pty";

export type PreferredTerminalBackendProbe = {
  herdr?: boolean;
  tmux?: boolean;
  zellij?: boolean;
};

export function resolvePreferredDurableBackend(
  available: PreferredTerminalBackendProbe,
): PreferredTerminalBackend {
  if (available.herdr) return "herdr";
  if (available.tmux) return "tmux";
  if (available.zellij) return "zellij";
  return "pty";
}

/** Infer availability from discovered session backends currently in the picker. */
export function preferredDurableBackendFromSessions(
  backends: Iterable<string>,
): PreferredTerminalBackend {
  const set = new Set(
    [...backends].map((value) => value.trim().toLowerCase()).filter(Boolean),
  );
  // Presence of any herdr session implies herdr is installed.
  return resolvePreferredDurableBackend({
    herdr: set.has("herdr"),
    tmux: set.has("tmux"),
    zellij: set.has("zellij"),
  });
}
