import type { AgentEndpoint, InvocationRequest } from "@openscout/protocol";

/** Preserve the assistant's constrained role when exact model selection creates
 * a new endpoint. Generic isolated agent defaults must not widen Scoutbot tools. */
export function scoutbotIsolationMetadata(
  base: AgentEndpoint | null,
  execution: InvocationRequest["execution"],
  launchArgs: string[],
): Record<string, unknown> {
  if (base?.agentId !== "scoutbot") return {};
  const metadata = base.metadata ?? {};
  if (base.harness !== "codex" || (execution?.harness && execution.harness !== "codex")
    || !metadata.roleConfig || !metadata.systemPrompt || !metadata.toolGrants
    || !Array.isArray(metadata.launchArgs)) {
    throw new Error("scoutbot_runtime_unavailable: constrained Scoutbot Codex role is required");
  }
  // Keep the base tool flags, replacing only model/effort flags with the exact
  // invocation selection. No endpoint IDs, session IDs or observations transfer.
  const inherited: string[] = [];
  const args = metadata.launchArgs.filter((arg): arg is string => typeof arg === "string");
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--model" || arg === "-m" || arg === "--reasoning-effort") { index += 1; continue; }
    if ((arg === "-c" || arg === "--config") && /^(model|model_reasoning_effort)=/.test(args[index + 1] ?? "")) {
      index += 1; continue;
    }
    inherited.push(arg);
  }
  const role: Record<string, unknown> = {};
  for (const key of ["roleConfig", "systemPrompt", "toolGrants", "permissionProfile", "permissionEnforcement", "approvalPolicy", "sandbox", "shellTool"]) {
    if (metadata[key] !== undefined) role[key] = metadata[key];
  }
  return { ...role, launchArgs: [...inherited, ...launchArgs] };
}
