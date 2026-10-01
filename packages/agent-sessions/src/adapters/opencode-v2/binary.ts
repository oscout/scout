// Where OpenCode product V2 (`opencode2`) lives. Known install dirs come before
// PATH: under `bun run`, PATH starts with every ancestor node_modules/.bin, and
// a stale `opencode2` shim there can't speak the 2.0 service protocol.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const SYSTEM_BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

export type OpenCodeV2BinaryEnv = Record<string, string | undefined>;

/**
 * The `opencode2` binary to run, or null when none is installed. An
 * `OPENCODE_V2_BIN` override that doesn't exist throws rather than quietly
 * falling through to another install.
 */
export function findOpenCodeV2Binary(
  env: OpenCodeV2BinaryEnv,
  systemBinDirs: readonly string[] = SYSTEM_BIN_DIRS,
): string | null {
  const override = env.OPENCODE_V2_BIN?.trim();
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`OPENCODE_V2_BIN points at ${override}, which does not exist.`);
    }
    return override;
  }
  const home = env.HOME?.trim() || homedir();
  const dirs = [
    ...systemBinDirs,
    join(home, ".opencode", "bin"),
    join(home, ".local", "bin"),
    join(home, ".bun", "bin"),
    ...(env.PATH ?? "").split(delimiter).filter(Boolean),
  ];
  return dirs.map((dir) => join(dir, "opencode2")).find((candidate) => existsSync(candidate)) ?? null;
}
