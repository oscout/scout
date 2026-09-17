import {
  normalizeAgentSelectorSegment,
  scoutReservedVocabularyKind,
  type AgentDefinition,
} from "@openscout/protocol";

export function assertNoReservedStoredAgentNames(
  agents: Record<string, AgentDefinition>,
  options: { localNodeId?: string } = {},
): void {
  for (const agent of Object.values(agents)) {
    // The journal retains retired identities for historical references. They
    // are excluded from the current fleet and cannot block an upgrade merely
    // because a former name is now reserved. Reactivation is audited normally.
    if (agent.metadata?.retiredFromFleet === true) continue;
    const authorityNodeId = agent.authorityNodeId || agent.homeNodeId;
    if (
      options.localNodeId
      && authorityNodeId
      && authorityNodeId !== options.localNodeId
    ) {
      continue;
    }
    const metadataDefinitionId = typeof agent.metadata?.definitionId === "string"
      ? agent.metadata.definitionId
      : undefined;
    const definitionId = normalizeAgentSelectorSegment(
      agent.definitionId || metadataDefinitionId || agent.id,
    );
    const kind = scoutReservedVocabularyKind(definitionId);
    if (!kind || kind === "built_in" || kind === "product") {
      continue;
    }
    throw new Error(
      `reserved_name_existing: stored agent ${agent.id} uses reserved ${kind} name "${definitionId}"; `
        + `repair the project or registry identity before starting Scout`,
    );
  }
}
