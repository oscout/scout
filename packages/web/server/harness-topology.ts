

export async function readLocalHarnessTopologySnapshot(options: { claudeSessionId?: string | null } = {}) {
  try {
    const { HarnessTopologyObserver } = await import("@openscout/runtime/harness-topology");
    const observer = new HarnessTopologyObserver({
      cwd: process.env.OPENSCOUT_SETUP_CWD || process.cwd(),
      claudeSessionId: options.claudeSessionId ?? null,
      includeUnmatchedClaudeSubagents: !options.claudeSessionId,
      includeUnmatchedClaudeWorkflows: !options.claudeSessionId,
    });
    return await observer.getSnapshot(true);
  } catch {
    return null;
  }
}
