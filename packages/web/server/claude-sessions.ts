import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function claudeProjectDirForCwd(cwd: string): string {
  return join(homedir(), ".claude", "projects", cwd.replace(/\//gu, "-"));
}

export function mostRecentClaudeSessionForCwd(cwd: string): { sessionId: string; transcriptPath: string } | null {
  const dir = claudeProjectDirForCwd(cwd);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  let best: { sessionId: string; transcriptPath: string; mtimeMs: number } | null = null;
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    const transcriptPath = join(dir, entry);
    try {
      const mtimeMs = statSync(transcriptPath).mtimeMs;
      if (!best || mtimeMs > best.mtimeMs) {
        best = {
          sessionId: entry.slice(0, -".jsonl".length),
          transcriptPath,
          mtimeMs,
        };
      }
    } catch {
      // Ignore stale entries that disappeared while scanning.
    }
  }
  return best ? { sessionId: best.sessionId, transcriptPath: best.transcriptPath } : null;
}
