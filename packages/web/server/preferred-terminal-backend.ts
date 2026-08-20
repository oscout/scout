/**
 * Smart default for durable terminal surfaces.
 *
 * Preference order: herdr → tmux → zellij → pty (ephemeral fallback).
 * Explicit New shell menus still expose every available backend.
 */

import { execSystemFile } from "@openscout/runtime/system-probes";

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

export async function probePreferredDurableBackend(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PreferredTerminalBackend> {
  const [herdr, tmux, zellij] = await Promise.all([
    binExists("herdr", env.OPENSCOUT_HERDR_BIN),
    binExists("tmux", env.OPENSCOUT_TMUX_BIN),
    binExists("zellij", env.OPENSCOUT_ZELLIJ_BIN),
  ]);
  return resolvePreferredDurableBackend({ herdr, tmux, zellij });
}

async function binExists(name: string, envOverride?: string): Promise<boolean> {
  if (envOverride?.trim()) return true;
  try {
    const result = await execSystemFile("which", [name], {
      timeoutMs: 1_000,
      maxStdoutBytes: 4_096,
      maxStderrBytes: 1_024,
    });
    return Boolean(result.stdout.trim());
  } catch {
    return false;
  }
}
