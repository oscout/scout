import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Interactive Claude Code stops on a "Quick safety check / Yes, I trust this
 * folder" dialog the first time it opens a folder. A tmux-hosted session never
 * gets past it, so callers that can pick a transport use this to route
 * untrusted folders to the headless `--print` transport, which has no dialog.
 *
 * Mirrors Claude Code's own rule: a folder is trusted when it, or any ancestor,
 * has `hasTrustDialogAccepted: true` under `projects` in `.claude.json`.
 */
export function claudeConfigFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  return configDir ? join(configDir, ".claude.json") : join(homedir(), ".claude.json");
}

export function isClaudeFolderTrusted(
  folder: string,
  options: { configPath?: string; readConfig?: (path: string) => string } = {},
): boolean {
  const configPath = options.configPath ?? claudeConfigFilePath();
  let projects: Record<string, { hasTrustDialogAccepted?: unknown } | undefined>;
  try {
    const raw = (options.readConfig ?? ((path) => readFileSync(path, "utf8")))(configPath);
    const parsed = JSON.parse(raw) as { projects?: unknown };
    if (!parsed.projects || typeof parsed.projects !== "object") return false;
    projects = parsed.projects as typeof projects;
  } catch {
    return false;
  }

  const candidates = new Set<string>([resolve(folder)]);
  try {
    candidates.add(realpathSync(folder));
  } catch {
    // A folder that does not exist yet is judged by its spelled path alone.
  }
  for (const start of candidates) {
    let current = start;
    while (true) {
      if (projects[current]?.hasTrustDialogAccepted === true) return true;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return false;
}
