import {
  allocateProvisionalAgentName,
  assertScoutAgentNameForWrite,
  collectOccupiedDefinitionIds,
  definitionIdFromOccupancyKey,
  normalizeAgentSelectorSegment,
  provisionalAgentNameStartIndexForSeed,
  SCOUT_RESERVED_AGENT_NAMES,
  type ProvisionalAgentNameSeedPart,
} from "@openscout/protocol";

import type { ScoutBrokerSnapshot } from "./scout-broker.js";
import { loadProvisionalAgentNamePool } from "./provisional-agent-names-config.js";

export function collectOccupiedDefinitionIdsFromBrokerSnapshot(
  snapshot: Pick<ScoutBrokerSnapshot, "agents"> & Partial<Pick<ScoutBrokerSnapshot, "actors">>,
): Set<string> {
  const references: string[] = [];
  for (const agent of Object.values(snapshot.agents)) {
    references.push(agent.id);
    if (agent.definitionId) {
      references.push(agent.definitionId);
    }
    if (agent.handle) {
      references.push(agent.handle);
    }
  }
  for (const actor of Object.values(snapshot.actors ?? {})) {
    references.push(actor.id);
    if (actor.handle) {
      references.push(actor.handle);
    }
    if (typeof actor.metadata?.handle === "string") {
      references.push(actor.metadata.handle);
    }
  }
  return collectOccupiedDefinitionIds(references);
}

export function resolveProvisionalAgentName(input: {
  explicitName?: string | null;
  occupied: ReadonlySet<string> | Iterable<string>;
  startIndex?: number;
  seedParts?: Iterable<ProvisionalAgentNameSeedPart>;
}): string {
  const explicit = input.explicitName?.trim();
  if (explicit) {
    return assertScoutAgentNameForWrite(explicit);
  }
  const pool = loadProvisionalAgentNamePool();
  const occupied = new Set(input.occupied);
  for (const reserved of SCOUT_RESERVED_AGENT_NAMES) occupied.add(reserved);
  const startIndex = input.startIndex
    ?? (input.seedParts ? provisionalAgentNameStartIndexForSeed(input.seedParts, pool) : undefined);
  return allocateProvisionalAgentName(occupied, {
    startIndex,
    pool,
  });
}

export function resolvePrefixedProvisionalAgentName(input: {
  explicitName?: string | null;
  occupied: ReadonlySet<string> | Iterable<string>;
  prefix: string;
  startIndex?: number;
  seedParts?: Iterable<ProvisionalAgentNameSeedPart>;
}): string {
  const explicit = input.explicitName?.trim();
  if (explicit) {
    return resolveProvisionalAgentName({
      explicitName: explicit,
      occupied: input.occupied,
      startIndex: input.startIndex,
      seedParts: input.seedParts,
    });
  }

  const prefix = normalizeAgentSelectorSegment(input.prefix);
  if (!prefix) {
    throw new Error(`Invalid provisional agent name prefix "${input.prefix}".`);
  }

  const pool = loadProvisionalAgentNamePool();
  const occupied = input.occupied instanceof Set
    ? new Set(input.occupied)
    : collectOccupiedDefinitionIds(input.occupied);
  for (const reserved of SCOUT_RESERVED_AGENT_NAMES) occupied.add(reserved);
  const prefixed = `${prefix}-`;
  for (const name of Array.from(occupied)) {
    if (name.startsWith(prefixed)) {
      const baseName = name.slice(prefixed.length);
      if (baseName) {
        occupied.add(baseName);
      }
    }
  }
  const startIndex = input.startIndex
    ?? (input.seedParts ? provisionalAgentNameStartIndexForSeed(input.seedParts, pool) : undefined);
  return `${prefix}-${allocateProvisionalAgentName(occupied, {
    startIndex,
    pool,
  })}`;
}

export function resolveProjectProvisionalAgentName(input: {
  explicitName?: string | null;
  occupied: ReadonlySet<string> | Iterable<string>;
  startIndex?: number;
  seedParts?: Iterable<ProvisionalAgentNameSeedPart>;
}): string {
  return resolvePrefixedProvisionalAgentName({
    ...input,
    prefix: "project",
  });
}

export {
  allocateProvisionalAgentName,
  collectOccupiedDefinitionIds,
  definitionIdFromOccupancyKey,
  isProvisionalAgentName,
  normalizeProvisionalAgentNameCandidates,
  parseProvisionalAgentNamesJson,
  parseProvisionalAgentNamesText,
  provisionalAgentNameStartIndexForSeed,
  PROVISIONAL_AGENT_NAMES,
  type ProvisionalAgentNameSeedPart,
} from "@openscout/protocol";

export {
  applyProvisionalAgentNamesFromBody,
  defaultProvisionalAgentNamesPath,
  describeProvisionalAgentNamePool,
  formatProvisionalAgentNamePoolSource,
  loadProvisionalAgentNamePool,
  mergeProvisionalAgentNamePool,
  normalizeProvisionalAgentNamesSetting,
  provisionalAgentNamesApiFields,
  resolveProvisionalAgentNamePool,
  resolveProvisionalAgentNamesMode,
  seedProvisionalAgentNamesInUserConfig,
  writeProvisionalAgentNamesFile,
  type ProvisionalAgentNamePoolSource,
  type ResolvedProvisionalAgentNamePool,
} from "./provisional-agent-names-config.js";
