import { normalizeCodexAppServerLaunchArgs } from "./transports/codex-app-server.js";

export function buildLocalCodexLaunchArgs(options: {
  model?: string;
  reasoningEffort?: string;
}): string[] {
  const model = options.model?.trim();
  const reasoningEffort = options.reasoningEffort?.trim();
  return normalizeCodexAppServerLaunchArgs([
    ...(model ? ["--model", model] : []),
    ...(reasoningEffort ? ["--reasoning-effort", reasoningEffort] : []),
  ]);
}
