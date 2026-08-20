import { normalizeAgentSelectorSegment, parseAgentIdentity } from "./agent-identity.js";

/**
 * Curated rotation pool for provisional agent identities.
 *
 * Names are short, human-addressable, and collision-resistant across a local
 * fleet. Categories include scientists, composers, philosophers, and a few
 * literary figures — chosen for memorability, not biographical endorsement.
 */
export const PROVISIONAL_AGENT_NAMES = [
  // Scientists & inventors
  "archimedes",
  "avogadro",
  "bohr",
  "boyle",
  "copernicus",
  "curie",
  "dalton",
  "darwin",
  "dirac",
  "einstein",
  "euler",
  "faraday",
  "feynman",
  "fermi",
  "fourier",
  "galileo",
  "gauss",
  "hawking",
  "heisenberg",
  "hooke",
  "hopper",
  "hypatia",
  "kepler",
  "lavoisier",
  "lovelace",
  "maxwell",
  "mendel",
  "newton",
  "noether",
  "oppenheimer",
  "pasteur",
  "pauli",
  "planck",
  "pythagoras",
  "rutherford",
  "sagan",
  "turing",
  "volterra",
  // Composers
  "bach",
  "bartok",
  "beethoven",
  "brahms",
  "chopin",
  "debussy",
  "dvorak",
  "grieg",
  "handel",
  "haydn",
  "liszt",
  "mahler",
  "monteverdi",
  "mozart",
  "prokofiev",
  "purcell",
  "ravel",
  "satie",
  "schubert",
  "schumann",
  "stravinsky",
  "tchaikovsky",
  "vivaldi",
  "wagner",
  // Philosophers & thinkers
  "aquinas",
  "aristotle",
  "confucius",
  "descartes",
  "epicurus",
  "hegel",
  "hume",
  "kant",
  "kierkegaard",
  "locke",
  "machiavelli",
  "nietzsche",
  "plato",
  "popper",
  "rousseau",
  "russell",
  "seneca",
  "socrates",
  "spinoza",
  "voltaire",
  "wittgenstein",
  "zeno",
  // Writers (classic, globally recognizable)
  "austen",
  "borges",
  "dickens",
  "dostoevsky",
  "homer",
  "kafka",
  "orwell",
  "shakespeare",
  "tolstoy",
  "virgil",
  "woolf",
  // House vocabulary (design-studies / product fixtures)
  "atlas",
  "cobalt",
  "drover",
  "hudson",
  "pike",
  "quill",
] as const;

export type ProvisionalAgentName = (typeof PROVISIONAL_AGENT_NAMES)[number];

export function normalizeProvisionalAgentNameCandidates(
  candidates: Iterable<string>,
): string[] {
  const seen = new Set<string>();
  const normalizedNames: string[] = [];
  for (const raw of candidates) {
    const withoutComment = raw.split("#")[0]?.trim() ?? "";
    const withoutSigil = withoutComment.replace(/^@+/, "").trim();
    const normalized = normalizeAgentSelectorSegment(withoutSigil);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    normalizedNames.push(normalized);
  }
  return normalizedNames;
}

export function parseProvisionalAgentNamesText(content: string): string[] {
  return normalizeProvisionalAgentNameCandidates(content.split(/\r?\n/u));
}

export function parseProvisionalAgentNamesJson(content: string): string[] {
  const parsed = JSON.parse(content) as unknown;
  if (Array.isArray(parsed)) {
    return normalizeProvisionalAgentNameCandidates(
      parsed.filter((entry): entry is string => typeof entry === "string"),
    );
  }
  if (
    parsed
    && typeof parsed === "object"
    && Array.isArray((parsed as { names?: unknown }).names)
  ) {
    return normalizeProvisionalAgentNameCandidates(
      (parsed as { names: unknown[] }).names.filter(
        (entry): entry is string => typeof entry === "string",
      ),
    );
  }
  throw new Error(
    "provisional agent names JSON must be a string array or { \"names\": [...] }",
  );
}

export function isProvisionalAgentName(
  value: string,
  pool: readonly string[] = PROVISIONAL_AGENT_NAMES,
): boolean {
  const normalized = normalizeAgentSelectorSegment(value);
  return normalized.length > 0 && pool.includes(normalized);
}

/** Extract the base definition id from an agent id, handle, or @label. */
export function definitionIdFromOccupancyKey(value: string): string | null {
  const trimmed = value.trim().replace(/^@+/, "");
  if (!trimmed) {
    return null;
  }

  const parsed = parseAgentIdentity(trimmed.startsWith("@") ? trimmed : `@${trimmed}`);
  if (parsed?.definitionId) {
    return normalizeAgentSelectorSegment(parsed.definitionId);
  }

  const head = trimmed.split(".")[0]?.trim() ?? "";
  const normalized = normalizeAgentSelectorSegment(head);
  return normalized || null;
}

export function collectOccupiedDefinitionIds(references: Iterable<string>): Set<string> {
  const occupied = new Set<string>();
  for (const reference of references) {
    const definitionId = definitionIdFromOccupancyKey(reference);
    if (definitionId) {
      occupied.add(definitionId);
    }
  }
  return occupied;
}

export type AllocateProvisionalAgentNameOptions = {
  /** When set, allocation starts scanning from this pool index (wraps). */
  startIndex?: number;
  /** Override the built-in pool (for example operator-configured names). */
  pool?: readonly string[];
};

export type ProvisionalAgentNameSeedPart = string | number | boolean | null | undefined;

function updateFnv1a32(hash: number, value: string): number {
  let next = hash >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    next ^= value.charCodeAt(index);
    next = Math.imul(next, 0x01000193) >>> 0;
  }
  return next;
}

export function provisionalAgentNameStartIndexForSeed(
  seedParts: Iterable<ProvisionalAgentNameSeedPart>,
  pool: readonly string[] = PROVISIONAL_AGENT_NAMES,
): number {
  if (pool.length === 0) {
    return 0;
  }

  let hash = 0x811c9dc5;
  let fieldIndex = 0;
  for (const part of seedParts) {
    const value = part == null ? "" : String(part);
    hash = updateFnv1a32(hash, `${fieldIndex}:${value.length}:`);
    hash = updateFnv1a32(hash, value);
    hash = updateFnv1a32(hash, "|");
    fieldIndex += 1;
  }
  hash = updateFnv1a32(hash, `fields:${fieldIndex}`);
  return hash % pool.length;
}

/**
 * Pick the next free name from the pool.
 * Falls back to `{poolName}-{n}` only when the entire pool is occupied.
 */
export function allocateProvisionalAgentName(
  occupied: ReadonlySet<string> | Iterable<string>,
  options: AllocateProvisionalAgentNameOptions = {},
): string {
  const pool = options.pool?.length ? options.pool : PROVISIONAL_AGENT_NAMES;
  if (pool.length === 0) {
    throw new Error("provisional agent name pool is empty");
  }

  const taken = occupied instanceof Set
    ? occupied
    : collectOccupiedDefinitionIds(occupied);

  const start = Math.abs(options.startIndex ?? 0) % pool.length;
  for (let offset = 0; offset < pool.length; offset += 1) {
    const candidate = pool[(start + offset) % pool.length]!;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }

  const anchor = pool[start]!;
  let suffix = 2;
  while (taken.has(`${anchor}-${suffix}`)) {
    suffix += 1;
  }
  return `${anchor}-${suffix}`;
}
