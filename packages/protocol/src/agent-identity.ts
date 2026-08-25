import type { ScoutId } from "./common.js";

export type AgentIdentityDimension = "workspace" | "profile" | "harness" | "model" | "node";

export interface AgentIdentity {
  raw: string;
  label: string;
  definitionId: ScoutId;
  nodeQualifier?: string;
  workspaceQualifier?: string;
  profile?: string;
  harness?: string;
  model?: string;
}

export interface AgentIdentityCandidate {
  agentId: ScoutId;
  definitionId?: ScoutId;
  nodeQualifier?: string;
  workspaceQualifier?: string;
  profile?: string;
  harness?: string;
  model?: string;
  referenceId?: string;
  aliases?: string[];
}

export interface AgentIdentityInput {
  definitionId: ScoutId;
  nodeQualifier?: string;
  workspaceQualifier?: string;
  profile?: string;
  harness?: string;
  model?: string;
}

export interface AgentIdentityAlias {
  alias: string;
  target: AgentIdentityInput;
}

const DIMENSION_ALIASES: Record<string, AgentIdentityDimension> = {
  workspace: "workspace",
  worktree: "workspace",
  branch: "workspace",
  profile: "profile",
  persona: "profile",
  harness: "harness",
  runtime: "harness",
  model: "model",
  node: "node",
  host: "node",
};

function trimIdentityPrefix(value: string): string {
  return value
    .trim()
    .replace(/^@+/, "")
    .replace(/[.,!?;)\]]+$/, "");
}

export function normalizeAgentIdentitySegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export const normalizeAgentSelectorSegment = normalizeAgentIdentitySegment;

export const SCOUT_DISPATCHER_AGENT_ID = "scout";
export const OPENSCOUT_COORDINATOR_AGENT_ID = "openscout";

export const BUILT_IN_AGENT_DEFINITION_IDS: ReadonlySet<string> = new Set([
  SCOUT_DISPATCHER_AGENT_ID,
  "builder",
  "reviewer",
  "research",
]);

export function isBuiltInAgentDefinitionId(value: string | null | undefined): boolean {
  if (!value) return false;
  return BUILT_IN_AGENT_DEFINITION_IDS.has(normalizeAgentIdentitySegment(value));
}

const RESERVED_AGENT_DEFINITION_IDS: ReadonlySet<string> = new Set([
  SCOUT_DISPATCHER_AGENT_ID,
]);

export function isReservedAgentDefinitionId(value: string | null | undefined): boolean {
  if (!value) return false;
  return RESERVED_AGENT_DEFINITION_IDS.has(normalizeAgentIdentitySegment(value));
}

function normalizeDimensionKey(value: string): AgentIdentityDimension | null {
  return DIMENSION_ALIASES[normalizeAgentIdentitySegment(value)] ?? null;
}

function canonicalizeIdentity(input: AgentIdentityInput): AgentIdentityInput | null {
  const definitionId = normalizeAgentIdentitySegment(input.definitionId);
  const workspaceQualifier = input.workspaceQualifier
    ? normalizeAgentIdentitySegment(input.workspaceQualifier)
    : undefined;
  const profile = input.profile ? normalizeAgentIdentitySegment(input.profile) : undefined;
  const rawHarness = input.harness ? normalizeAgentIdentitySegment(input.harness) : undefined;
  const harness = rawHarness === "oc" ? "opencode" : rawHarness;
  const model = input.model ? normalizeAgentIdentitySegment(input.model) : undefined;
  const nodeQualifier = input.nodeQualifier
    ? normalizeAgentIdentitySegment(input.nodeQualifier)
    : undefined;

  if (!definitionId) {
    return null;
  }

  return {
    definitionId,
    ...(workspaceQualifier ? { workspaceQualifier } : {}),
    ...(profile ? { profile } : {}),
    ...(harness ? { harness } : {}),
    ...(model ? { model } : {}),
    ...(nodeQualifier ? { nodeQualifier } : {}),
  };
}

function parseSegmentedIdentity(raw: string): AgentIdentity | null {
  const parts = raw.split(".").filter(Boolean);
  const definitionPart = parts.shift();
  if (!definitionPart) {
    return null;
  }

  const next: AgentIdentityInput = {
    definitionId: definitionPart,
  };

  // Collect positional (non-keyed) segments
  const positional: string[] = [];
  for (const part of parts) {
    if (part.includes(":")) {
      const [rawKey, rawValue = ""] = part.split(":", 2);
      const key = normalizeDimensionKey(rawKey);
      const value = normalizeAgentIdentitySegment(rawValue);
      if (!key || !value) {
        return null;
      }

      if (key === "workspace") {
        next.workspaceQualifier = value;
      } else if (key === "profile") {
        next.profile = value;
      } else if (key === "harness") {
        next.harness = value;
      } else if (key === "model") {
        next.model = value;
      } else if (key === "node") {
        next.nodeQualifier = value;
      }
      continue;
    }

    positional.push(part);
  }

  // 1 positional → workspaceQualifier  (@agent.branch)
  // 2 positionals → workspaceQualifier.nodeQualifier  (@agent.branch.node — node is always last)
  // 3+ positionals → invalid
  if (positional.length === 1) {
    const value = normalizeAgentIdentitySegment(positional[0]);
    if (!value) return null;
    next.workspaceQualifier = value;
  } else if (positional.length === 2) {
    const workspaceValue = normalizeAgentIdentitySegment(positional[0]);
    const nodeValue = normalizeAgentIdentitySegment(positional[1]);
    if (!workspaceValue || !nodeValue) return null;
    if (!next.workspaceQualifier) next.workspaceQualifier = workspaceValue;
    if (!next.nodeQualifier) next.nodeQualifier = nodeValue;
  } else if (positional.length > 2) {
    return null;
  }

  return constructAgentIdentity(next, { raw });
}

function parseShorthandIdentity(raw: string): AgentIdentity | null {
  const hashIndex = raw.indexOf("#");
  const questionIndex = raw.indexOf("?");
  if (hashIndex === -1 && questionIndex === -1) {
    return null;
  }
  if (raw.indexOf("#", hashIndex + 1) !== -1 || raw.indexOf("?", questionIndex + 1) !== -1) {
    return null;
  }
  if (hashIndex !== -1 && questionIndex !== -1 && questionIndex < hashIndex) {
    return null;
  }

  const baseEnd = Math.min(
    ...[hashIndex, questionIndex].filter((index) => index >= 0),
  );
  const base = raw.slice(0, baseEnd);
  if (!base) {
    return null;
  }

  const parsedBase = parseSegmentedIdentity(base);
  if (!parsedBase) {
    return null;
  }

  const harnessRaw = hashIndex >= 0
    ? raw.slice(hashIndex + 1, questionIndex >= 0 ? questionIndex : raw.length)
    : "";
  const modelRaw = questionIndex >= 0 ? raw.slice(questionIndex + 1) : "";
  if ((hashIndex >= 0 && !harnessRaw) || (questionIndex >= 0 && !modelRaw)) {
    return null;
  }
  if (harnessRaw.includes("#") || harnessRaw.includes("?") || modelRaw.includes("#") || modelRaw.includes("?")) {
    return null;
  }
  if ((parsedBase.harness && harnessRaw) || (parsedBase.model && modelRaw)) {
    return null;
  }

  return constructAgentIdentity({
    definitionId: parsedBase.definitionId,
    nodeQualifier: parsedBase.nodeQualifier,
    workspaceQualifier: parsedBase.workspaceQualifier,
    profile: parsedBase.profile,
    harness: harnessRaw || parsedBase.harness,
    model: modelRaw || parsedBase.model,
  }, { raw });
}

export function parseAgentIdentity(value: string): AgentIdentity | null {
  const raw = trimIdentityPrefix(value);
  if (!raw) {
    return null;
  }

  if (raw.includes("@")) {
    return null;
  }

  if (raw.includes("#") || raw.includes("?")) {
    return parseShorthandIdentity(raw);
  }

  return parseSegmentedIdentity(raw);
}

export function formatAgentIdentity(
  input: AgentIdentityInput,
  options: { includeSigil?: boolean } = {},
): string {
  const canonical = canonicalizeIdentity(input);
  if (!canonical) {
    return options.includeSigil === false ? "" : "@";
  }

  const prefix = options.includeSigil === false ? "" : "@";
  const segments = [`${prefix}${canonical.definitionId}`];

  if (canonical.workspaceQualifier) {
    segments.push(canonical.workspaceQualifier);
  }
  if (canonical.profile) {
    segments.push(`profile:${canonical.profile}`);
  }
  if (canonical.harness) {
    segments.push(`harness:${canonical.harness}`);
  }
  if (canonical.model) {
    segments.push(`model:${canonical.model}`);
  }
  if (canonical.nodeQualifier) {
    segments.push(`node:${canonical.nodeQualifier}`);
  }

  return segments.join(".");
}

export function constructAgentIdentity(
  input: AgentIdentityInput,
  options: { raw?: string } = {},
): AgentIdentity | null {
  const canonical = canonicalizeIdentity(input);
  if (!canonical) {
    return null;
  }

  return {
    raw: options.raw ?? formatAgentIdentity(canonical, { includeSigil: false }),
    label: formatAgentIdentity(canonical),
    definitionId: canonical.definitionId,
    ...(canonical.nodeQualifier ? { nodeQualifier: canonical.nodeQualifier } : {}),
    ...(canonical.workspaceQualifier ? { workspaceQualifier: canonical.workspaceQualifier } : {}),
    ...(canonical.profile ? { profile: canonical.profile } : {}),
    ...(canonical.harness ? { harness: canonical.harness } : {}),
    ...(canonical.model ? { model: canonical.model } : {}),
  };
}

export function extractAgentIdentities(text: string): AgentIdentity[] {
  return extractAgentMentions(text).parsed;
}

export function extractAgentMentions(text: string): { parsed: AgentIdentity[]; unparsed: string[] } {
  const matches = Array.from(
    text.matchAll(/(^|[\s([{'"`])@([a-z0-9][a-z0-9._/:-]*(?:#[a-z0-9][a-z0-9._/:-]*)?(?:\?[a-z0-9][a-z0-9._/:-]*)?)(?=$|[\s)\]}",.!?:;'"`])/gi),
  );
  const identities = new Map<string, AgentIdentity>();
  const unparsed: string[] = [];

  for (const match of matches) {
    const raw = match[2] ?? "";
    const candidate = parseAgentIdentity(raw);
    if (!candidate) {
      if (raw) unparsed.push(`@${raw}`);
      continue;
    }

    identities.set(candidate.label, candidate);
  }

  return {
    parsed: Array.from(identities.values()),
    unparsed: Array.from(new Set(unparsed)),
  };
}

function candidateAliases(candidate: AgentIdentityCandidate): string[] {
  const canonical = canonicalizeIdentity({
    definitionId: candidate.definitionId || candidate.agentId,
    nodeQualifier: candidate.nodeQualifier,
    workspaceQualifier: candidate.workspaceQualifier,
    profile: candidate.profile,
    harness: candidate.harness,
    model: candidate.model,
  });
  if (!canonical) {
    return [];
  }

  const aliases = [
    canonical.definitionId,
    formatAgentIdentity(canonical),
    canonical.workspaceQualifier
      ? formatAgentIdentity({ definitionId: canonical.definitionId, workspaceQualifier: canonical.workspaceQualifier })
      : "",
    canonical.profile
      ? formatAgentIdentity({ definitionId: canonical.definitionId, profile: canonical.profile })
      : "",
    canonical.harness
      ? formatAgentIdentity({ definitionId: canonical.definitionId, harness: canonical.harness })
      : "",
    canonical.model
      ? formatAgentIdentity({ definitionId: canonical.definitionId, model: canonical.model })
      : "",
    canonical.nodeQualifier
      ? formatAgentIdentity({ definitionId: canonical.definitionId, nodeQualifier: canonical.nodeQualifier })
      : "",
    ...((candidate.aliases ?? []).map((alias) => alias.trim()).filter(Boolean)),
  ];

  return Array.from(new Set(aliases.map((alias) => trimIdentityPrefix(alias)).filter(Boolean)));
}

// Directory-wide operations (formatMinimalAgentIdentity, diagnoseAgentIdentity)
// evaluate these per candidate pair, and broker snapshots can carry thousands
// of candidates — recomputing parse/construct work per visit turns those
// call sites quadratic in heavy string handling. Candidates are treated as
// immutable once they enter these pipelines, so per-object memoization is safe.
const explicitAliasesCache = new WeakMap<AgentIdentityCandidate, string[]>();
const aliasKeysCache = new WeakMap<AgentIdentityCandidate, string[]>();
const canonicalIdentityCache = new WeakMap<AgentIdentityCandidate, AgentIdentity | null>();

function explicitCandidateAliases(candidate: AgentIdentityCandidate): string[] {
  const cached = explicitAliasesCache.get(candidate);
  if (cached) return cached;
  const canonical = candidateCanonicalIdentity(candidate);
  const implicitAliases = canonical?.definitionId === OPENSCOUT_COORDINATOR_AGENT_ID
    ? [SCOUT_DISPATCHER_AGENT_ID]
    : [];
  const aliases = Array.from(new Set(
    [...(candidate.aliases ?? []), ...implicitAliases]
      .map((alias) => normalizeAgentIdentitySegment(trimIdentityPrefix(alias)))
      .filter(Boolean),
  ));
  explicitAliasesCache.set(candidate, aliases);
  return aliases;
}

function candidateAliasKeys(candidate: AgentIdentityCandidate): string[] {
  const cached = aliasKeysCache.get(candidate);
  if (cached) return cached;
  const keys = explicitCandidateAliases(candidate).map(canonicalizeAliasValue);
  aliasKeysCache.set(candidate, keys);
  return keys;
}

function canonicalizeAliasValue(value: string): string {
  const parsed = parseAgentIdentity(value.startsWith("@") ? value : `@${value}`);
  if (parsed) {
    return trimIdentityPrefix(parsed.label);
  }

  return normalizeAgentIdentitySegment(value);
}

function identityAliasKeys(identity: AgentIdentity): string[] {
  return Array.from(new Set([
    trimIdentityPrefix(identity.label),
    trimIdentityPrefix(identity.raw),
    trimIdentityPrefix(formatAgentIdentity(identity, { includeSigil: false })),
  ].filter(Boolean)));
}

function candidateCanonicalIdentity(candidate: AgentIdentityCandidate): AgentIdentity | null {
  if (canonicalIdentityCache.has(candidate)) {
    return canonicalIdentityCache.get(candidate) ?? null;
  }
  const canonical = constructAgentIdentity({
    definitionId: candidate.definitionId || candidate.agentId,
    nodeQualifier: candidate.nodeQualifier,
    workspaceQualifier: candidate.workspaceQualifier,
    profile: candidate.profile,
    harness: candidate.harness,
    model: candidate.model,
  });
  canonicalIdentityCache.set(candidate, canonical);
  return canonical;
}

function candidateDimensionValue(
  candidate: AgentIdentityCandidate,
  dimension: AgentIdentityDimension,
): string | undefined {
  const canonical = candidateCanonicalIdentity(candidate);
  if (!canonical) {
    return undefined;
  }

  if (dimension === "workspace") return canonical.workspaceQualifier;
  if (dimension === "profile") return canonical.profile;
  if (dimension === "harness") return canonical.harness;
  if (dimension === "model") return canonical.model;
  return canonical.nodeQualifier;
}

function normalizeAgentReferenceValue(value: string | null | undefined): string {
  return value?.trim().toLowerCase().replace(/[^a-z0-9]/g, "") ?? "";
}

function candidateReferenceValue(candidate: AgentIdentityCandidate): string {
  return normalizeAgentReferenceValue(
    candidate.referenceId
      || candidate.workspaceQualifier
      || candidate.agentId,
  );
}

function candidateReferenceSuffix(candidate: AgentIdentityCandidate, length: number): string {
  const value = candidateReferenceValue(candidate);
  if (!value) {
    return "";
  }
  return value.length <= length ? value : value.slice(-length);
}

export function formatAgentReferenceIdentity<T extends AgentIdentityCandidate>(
  candidate: T,
  candidates: T[],
  options: { includeSigil?: boolean; minLength?: number; maxLength?: number } = {},
): string {
  const canonical = candidateCanonicalIdentity(candidate);
  if (!canonical) {
    return options.includeSigil === false ? "" : "@";
  }

  const minLength = Math.max(1, options.minLength ?? 5);
  const maxLength = Math.max(minLength, options.maxLength ?? 8);
  const peers = candidates.filter((peer) => {
    if (peer === candidate) {
      return false;
    }
    const peerCanonical = candidateCanonicalIdentity(peer);
    return peerCanonical?.definitionId === canonical.definitionId;
  });

  let suffix = "";
  for (let length = minLength; length <= maxLength; length += 1) {
    const candidateSuffix = candidateReferenceSuffix(candidate, length);
    if (!candidateSuffix) {
      break;
    }
    suffix = candidateSuffix;
    const collides = peers.some((peer) => candidateReferenceSuffix(peer, length) === candidateSuffix);
    if (!collides) {
      break;
    }
  }

  if (!suffix) {
    return formatAgentIdentity({ definitionId: canonical.definitionId }, options);
  }

  return formatAgentIdentity({
    definitionId: canonical.definitionId,
    workspaceQualifier: suffix,
  }, options);
}

export function withAgentReferenceAliases<T extends AgentIdentityCandidate>(
  candidates: T[],
): T[] {
  return candidates.map((candidate) => {
    const alias = formatAgentReferenceIdentity(candidate, candidates);
    const aliases = Array.from(new Set([...(candidate.aliases ?? []), alias].filter(Boolean)));
    return {
      ...candidate,
      aliases,
    };
  });
}

function modelAliasKeys(value: string | undefined): string[] {
  const normalized = value ? normalizeAgentIdentitySegment(value) : "";
  if (!normalized) {
    return [];
  }

  const parts = normalized.split("-").filter(Boolean);
  const aliases = new Set<string>([normalized]);
  if (parts.length > 1 && ["claude", "gpt", "openai", "anthropic"].includes(parts[0]!)) {
    aliases.add(parts.slice(1).join("-"));
  }

  for (const family of ["sonnet", "opus", "haiku", "mini", "nano", "pro"]) {
    const index = parts.indexOf(family);
    if (index >= 0) {
      aliases.add(family);
      aliases.add(parts.slice(index).join("-"));
    }
  }

  return Array.from(aliases).filter(Boolean);
}

function modelMatches(
  identityModel: string | undefined,
  candidate: AgentIdentityCandidate,
): boolean {
  if (!identityModel) {
    return true;
  }
  return modelAliasKeys(candidate.model).includes(identityModel);
}

function definitionMatchesIdentity(
  identityDefinitionId: string,
  candidateDefinitionId: string,
): boolean {
  if (identityDefinitionId === candidateDefinitionId) {
    return true;
  }

  return identityDefinitionId === SCOUT_DISPATCHER_AGENT_ID
    && candidateDefinitionId === OPENSCOUT_COORDINATOR_AGENT_ID;
}

export function agentIdentityMatches(
  identity: AgentIdentity,
  candidate: AgentIdentityCandidate,
): boolean {
  const aliasKeys = identityAliasKeys(identity);
  const candidateAliasKeys = explicitCandidateAliases(candidate).map(canonicalizeAliasValue);
  if (aliasKeys.some((key) => candidateAliasKeys.includes(key))) {
    return true;
  }

  const canonical = canonicalizeIdentity({
    definitionId: candidate.definitionId || candidate.agentId,
    nodeQualifier: candidate.nodeQualifier,
    workspaceQualifier: candidate.workspaceQualifier,
    profile: candidate.profile,
    harness: candidate.harness,
    model: candidate.model,
  });
  if (!canonical || !definitionMatchesIdentity(identity.definitionId, canonical.definitionId)) {
    return false;
  }

  if (identity.nodeQualifier && identity.nodeQualifier !== canonical.nodeQualifier) {
    return candidateAliases(candidate).includes(trimIdentityPrefix(identity.label));
  }
  if (identity.workspaceQualifier && identity.workspaceQualifier !== canonical.workspaceQualifier) {
    return candidateAliases(candidate).includes(trimIdentityPrefix(identity.label));
  }
  if (identity.profile && identity.profile !== canonical.profile) {
    return candidateAliases(candidate).includes(trimIdentityPrefix(identity.label));
  }
  if (identity.harness && identity.harness !== canonical.harness) {
    return candidateAliases(candidate).includes(trimIdentityPrefix(identity.label));
  }
  if (identity.model && !modelMatches(identity.model, candidate)) {
    return candidateAliases(candidate).includes(trimIdentityPrefix(identity.label));
  }

  return true;
}

export function resolveAgentIdentity<T extends AgentIdentityCandidate>(
  identity: AgentIdentity,
  candidates: T[],
): T | null {
  const diagnosis = diagnoseAgentIdentity(identity, candidates);
  return diagnosis.kind === "resolved" ? diagnosis.match : null;
}

export type AgentIdentityDiagnosis<T extends AgentIdentityCandidate> =
  | { kind: "resolved"; match: T }
  | { kind: "ambiguous"; candidates: T[] }
  | { kind: "unknown" };

export function diagnoseAgentIdentity<T extends AgentIdentityCandidate>(
  identity: AgentIdentity,
  candidates: T[],
): AgentIdentityDiagnosis<T> {
  const aliasKeys = identityAliasKeys(identity);
  const exactAliasMatches = candidates.filter((candidate) => {
    const keys = candidateAliasKeys(candidate);
    return keys.length > 0 && aliasKeys.some((key) => keys.includes(key));
  });
  if (exactAliasMatches.length === 1) {
    return { kind: "resolved", match: exactAliasMatches[0] };
  }
  if (exactAliasMatches.length > 1) {
    return { kind: "ambiguous", candidates: exactAliasMatches };
  }

  const matches = candidates.filter((candidate) => agentIdentityMatches(identity, candidate));
  if (matches.length === 1) {
    return { kind: "resolved", match: matches[0] };
  }
  if (matches.length === 0) {
    return { kind: "unknown" };
  }

  if (
    !identity.nodeQualifier
    && !identity.workspaceQualifier
    && !identity.profile
    && !identity.harness
    && !identity.model
  ) {
    const exactIdMatch = matches.find(
      (candidate) => normalizeAgentIdentitySegment(candidate.agentId) === identity.definitionId,
    );
    if (exactIdMatch) {
      return { kind: "resolved", match: exactIdMatch };
    }
    return { kind: "ambiguous", candidates: matches };
  }

  return { kind: "ambiguous", candidates: matches };
}

export function constructAgentAlias(input: {
  alias: string;
  target: AgentIdentityInput;
}): AgentIdentityAlias | null {
  const alias = normalizeAgentIdentitySegment(trimIdentityPrefix(input.alias));
  const target = canonicalizeIdentity(input.target);
  if (!alias || !target) {
    return null;
  }

  return { alias, target };
}

export function formatAgentAlias(alias: AgentIdentityAlias, options: { includeSigil?: boolean } = {}): string {
  const prefix = options.includeSigil === false ? "" : "@";
  return `${prefix}${normalizeAgentIdentitySegment(alias.alias)}`;
}

export function resolveAgentAlias(
  value: string,
  aliases: AgentIdentityAlias[],
): AgentIdentity | null {
  const aliasKey = normalizeAgentIdentitySegment(trimIdentityPrefix(value));
  if (!aliasKey) {
    return null;
  }

  const matches = aliases.filter((alias) => normalizeAgentIdentitySegment(alias.alias) === aliasKey);
  if (matches.length !== 1) {
    return null;
  }

  return constructAgentIdentity(matches[0].target);
}

function identitiesDifferOnDimension(
  left: AgentIdentityCandidate,
  right: AgentIdentityCandidate,
  dimension: AgentIdentityDimension,
): boolean {
  return candidateDimensionValue(left, dimension) !== candidateDimensionValue(right, dimension);
}

function buildIdentitySubset(
  candidate: AgentIdentityCandidate,
  dimensions: AgentIdentityDimension[],
): AgentIdentity | null {
  const canonical = candidateCanonicalIdentity(candidate);
  if (!canonical) {
    return null;
  }

  return constructAgentIdentity({
    definitionId: canonical.definitionId,
    ...(dimensions.includes("workspace") && canonical.workspaceQualifier
      ? { workspaceQualifier: canonical.workspaceQualifier }
      : {}),
    ...(dimensions.includes("profile") && canonical.profile ? { profile: canonical.profile } : {}),
    ...(dimensions.includes("harness") && canonical.harness ? { harness: canonical.harness } : {}),
    ...(dimensions.includes("model") && canonical.model ? { model: canonical.model } : {}),
    ...(dimensions.includes("node") && canonical.nodeQualifier ? { nodeQualifier: canonical.nodeQualifier } : {}),
  });
}

const peersByDefinitionCache = new WeakMap<AgentIdentityCandidate[], Map<string, AgentIdentityCandidate[]>>();

function peersByDefinitionId<T extends AgentIdentityCandidate>(candidates: T[]): Map<string, T[]> {
  const cached = peersByDefinitionCache.get(candidates);
  if (cached) return cached as Map<string, T[]>;
  const groups = new Map<string, T[]>();
  for (const candidate of candidates) {
    const canonical = candidateCanonicalIdentity(candidate);
    if (!canonical) continue;
    const group = groups.get(canonical.definitionId);
    if (group) {
      group.push(candidate);
    } else {
      groups.set(canonical.definitionId, [candidate]);
    }
  }
  peersByDefinitionCache.set(candidates, groups);
  return groups;
}

export function formatMinimalAgentIdentity<T extends AgentIdentityCandidate>(
  candidate: T,
  candidates: T[],
  options: { includeSigil?: boolean } = {},
): string {
  const canonical = candidateCanonicalIdentity(candidate);
  if (!canonical) {
    return options.includeSigil === false ? "" : "@";
  }

  const peers = peersByDefinitionId(candidates).get(canonical.definitionId) ?? [];

  const aliasMatches = explicitCandidateAliases(candidate)
    .map((alias) => ({ alias, identity: parseAgentIdentity(`@${alias}`) }))
    .filter((entry): entry is { alias: string; identity: AgentIdentity } => Boolean(entry.identity))
    .filter((entry) => resolveAgentIdentity(entry.identity, candidates) === candidate)
    .sort((left, right) => left.alias.length - right.alias.length || left.alias.localeCompare(right.alias));
  if (aliasMatches.length > 0) {
    return formatAgentIdentity({ definitionId: aliasMatches[0].alias }, options);
  }

  if (peers.length <= 1) {
    return formatAgentIdentity({ definitionId: canonical.definitionId }, options);
  }

  const orderedDimensions: AgentIdentityDimension[] = ["workspace", "profile", "harness", "model", "node"];
  const selectedDimensions: AgentIdentityDimension[] = [];
  let remainingPeers = peers.filter((peer) => peer !== candidate);

  for (const dimension of orderedDimensions) {
    const value = candidateDimensionValue(candidate, dimension);
    if (!value) {
      continue;
    }
    const splitsRemainingPeers = remainingPeers.some((peer) => identitiesDifferOnDimension(candidate, peer, dimension));
    if (!splitsRemainingPeers) {
      continue;
    }

    selectedDimensions.push(dimension);
    remainingPeers = remainingPeers.filter((peer) => (
      !identitiesDifferOnDimension(candidate, peer, dimension)
    ));
    const current = buildIdentitySubset(candidate, selectedDimensions);
    if (current && resolveAgentIdentity(current, candidates)) {
      return formatAgentIdentity(current, options);
    }
  }

  return formatAgentIdentity(canonical, options);
}

/** @deprecated Use {@link AgentIdentity} instead. */
export type AgentAddress = AgentIdentity;
/** @deprecated Use {@link AgentIdentityCandidate} instead. */
export type AgentAddressCandidate = AgentIdentityCandidate;
/** @deprecated Use {@link AgentIdentity} instead. */
export type AgentSelector = AgentIdentity;
/** @deprecated Use {@link AgentIdentityCandidate} instead. */
export type AgentSelectorCandidate = AgentIdentityCandidate;

/** @deprecated Use {@link parseAgentIdentity} instead. */
export const parseAgentAddress = parseAgentIdentity;
/** @deprecated Use {@link formatAgentIdentity} instead. */
export const formatAgentAddress = formatAgentIdentity;
/** @deprecated Use {@link constructAgentIdentity} instead. */
export const constructAgentAddress = constructAgentIdentity;
/** @deprecated Use {@link extractAgentIdentities} instead. */
export const extractAgentAddresses = extractAgentIdentities;
/** @deprecated Use {@link agentIdentityMatches} instead. */
export const agentAddressMatches = agentIdentityMatches;
/** @deprecated Use {@link resolveAgentIdentity} instead. */
export const resolveAgentAddress = resolveAgentIdentity;

/** @deprecated Use {@link parseAgentIdentity} instead. */
export const parseAgentSelector = parseAgentIdentity;
/** @deprecated Use {@link formatAgentIdentity} instead. */
export const formatAgentSelector = formatAgentIdentity;
/** @deprecated Use {@link extractAgentIdentities} instead. */
export const extractAgentSelectors = extractAgentIdentities;
/** @deprecated Use {@link agentIdentityMatches} instead. */
export const agentSelectorMatches = agentIdentityMatches;
/** @deprecated Use {@link resolveAgentIdentity} instead. */
export const resolveAgentSelector = resolveAgentIdentity;
