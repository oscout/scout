export type KnowledgeStatus = {
  generatedAt: number;
  paths: {
    knowledgeRoot: string;
    qmdRoot: string;
    sqlitePath: string;
  };
  collections: number;
  readyCollections: number;
  chunks: number;
  activeJobs: Array<{
    id: string;
    source: string;
    state: string;
    progress: {
      discovered?: number;
      extracted?: number;
      indexed?: number;
      failed?: number;
    };
    updatedAt: number;
    error?: string;
  }>;
  sqliteBytes: number;
};

export type PortablePath = {
  root: string;
  relPath: string;
};

export type KnowledgeSourceRef =
  | {
    kind: "harness_transcript";
    harness: string;
    path: PortablePath;
    sessionId?: string;
    recordRange?: [number, number];
  }
  | { kind: "file"; path: PortablePath; lineRange?: [number, number] }
  | { kind: "skill"; path: PortablePath; skillName?: string }
  | { kind: "context_pack"; path: PortablePath; packId?: string }
  | { kind: "scout_record"; recordKind: string; id: string }
  | { kind: "mcp_tool"; serverId: string; toolName: string; schemaPath?: string };

export type KnowledgeHit = {
  id: string;
  collectionId: string;
  documentId: string;
  chunkId: string;
  title: string;
  snippet: string;
  score: number;
  scoreSource: "fts" | "vector" | "hybrid";
  origin: string;
  ownership: string;
  freshness: string;
  sourceRefs: KnowledgeSourceRef[];
  facets: Record<string, string | string[]>;
};

export type SearchResponse = {
  q: string;
  hits: KnowledgeHit[];
  status: KnowledgeStatus;
};

export type IndexedSession = {
  collectionId: string;
  title: string;
  harness: string;
  project: string;
  transcriptPath: string;
  qmdPath: string;
  records: number;
  documents: number;
  chunks: number;
  bytes: number;
  mtimeMs: number;
  skipped?: boolean;
  error?: string;
};

export type IndexResponse = {
  result: {
    days: number;
    discovered: number;
    indexed: number;
    failed: number;
    sessions: IndexedSession[];
  };
  status: KnowledgeStatus;
};

export type WorktreeIndexResponse = {
  result: {
    repoRoot: string;
    branch: string;
    files: number;
    chunks: number;
    skipped: number;
    clean: boolean;
    collectionId: string;
    qmdPath: string;
    indexedFiles: Array<{
      path: string;
      state: "staged" | "unstaged" | "untracked";
      chunks: number;
      bytes: number;
      skipped?: boolean;
      reason?: string;
    }>;
  };
  status: KnowledgeStatus;
};

/** Defaults the UI and API clients should use unless the operator opts in later. */
export const KNOWLEDGE_SEARCH_DEFAULTS = {
  /** Lookback when building the session index. */
  days: 3,
  /** Max sessions to discover/index in a refresh. */
  sessionLimit: 200,
  /** Max hits to return per query. */
  hitLimit: 60,
  /** Debounce between query keystrokes before re-running. */
  debounceMs: 180,
};

export type KnowledgeFacetValue = {
  key: string;
  value: string;
  count: number;
};

export type KnowledgeSourcePreviewRecord = {
  index: number;
  raw: string;
  type?: string;
  role?: string;
  kind?: string;
  summary: string;
  renderedText: string;
  parsed: boolean;
  matched?: boolean;
  matchCount?: number;
  matchTerms?: string[];
};

export type KnowledgeSourcePreview = {
  path: string;
  sourcePath: PortablePath;
  harness: string;
  sessionId?: string;
  requestedRange?: [number, number];
  previewRange: [number, number];
  records: KnowledgeSourcePreviewRecord[];
  recordsRead: number;
  truncatedBefore: boolean;
  truncatedAfter: boolean;
  query?: string;
  queryTerms?: string[];
};

export type HighlightPart = {
  text: string;
  match: boolean;
};

export function pathLabel(path: PortablePath): string {
  if (path.root === "HOME") return `~/${path.relPath}`;
  if (path.root === "ABSOLUTE") return path.relPath;
  return `$${path.root}/${path.relPath}`;
}

export function normalizeSessionRef(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/[\\/]+$/, "");
  const leaf = normalized.split(/[\\/]/).filter(Boolean).at(-1) ?? normalized;
  return leaf.endsWith(".jsonl") ? leaf.slice(0, -".jsonl".length) : leaf;
}

export function firstTranscriptRef(hit: KnowledgeHit): Extract<KnowledgeSourceRef, { kind: "harness_transcript" }> | null {
  return hit.sourceRefs.find((ref): ref is Extract<KnowledgeSourceRef, { kind: "harness_transcript" }> =>
    ref.kind === "harness_transcript"
  ) ?? null;
}

export function firstFileRef(hit: KnowledgeHit): Extract<KnowledgeSourceRef, { kind: "file" }> | null {
  return hit.sourceRefs.find((ref): ref is Extract<KnowledgeSourceRef, { kind: "file" }> =>
    ref.kind === "file"
  ) ?? null;
}

export function transcriptSessionId(
  ref: Extract<KnowledgeSourceRef, { kind: "harness_transcript" }> | null | undefined,
): string | null {
  if (!ref) return null;
  return normalizeSessionRef(ref.sessionId) ?? normalizeSessionRef(pathLabel(ref.path));
}

export function transcriptTailQuery(
  ref: Extract<KnowledgeSourceRef, { kind: "harness_transcript" }> | null | undefined,
): string | null {
  const sessionId = transcriptSessionId(ref);
  if (!sessionId) return null;
  const range = ref?.recordRange;
  if (!range) return sessionId;
  return `${sessionId}|records ${range[0]}..${range[1]}`;
}

export function facetText(hit: KnowledgeHit, key: string): string {
  const value = hit.facets[key];
  if (Array.isArray(value)) return value.filter(Boolean).join(", ");
  return typeof value === "string" ? value : "";
}

export function queryTerms(query: string): string[] {
  const seen = new Set<string>();
  return query
    .split(/[^A-Za-z0-9_./-]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length > 1)
    .filter((term) => {
      const key = term.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 12);
}

/** Chunk headings that read like index machinery, not conversation titles. */
const MACHINE_CHUNK_TITLE =
  /^(events?\s+window(\s+\d+)?|files?\s+touched|tool\s+calls?|indexed\s+snippet|manifest|summary|decisions?|context\s+pack)\b/iu;

const HARNESS_PREFIX = /^(claude|codex|kimi|cursor|gpt|gemini)\b/iu;
const SESSION_META_PREFIX =
  /^(?:claude|codex|kimi|cursor|gpt|gemini)?\s*[a-z0-9._/-]*\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(?:\s+at\s+\d{1,2}:\d{2}\s*(?:am|pm)?)?\s*[-–—:]\s*/iu;

export function isMachineChunkTitle(title: string): boolean {
  return MACHINE_CHUNK_TITLE.test(title.replace(/\s+/g, " ").trim());
}

/** Strip harness/date/tag noise into a short scannable headline. */
export function cleanHeadlineText(raw: string): string {
  let title = raw.replace(/\s+/g, " ").trim();
  if (!title) return "";

  title = title.replace(/<[^>\n]+>/g, " ").replace(/\s+/g, " ").trim();

  if (SESSION_META_PREFIX.test(title)) {
    title = title.replace(SESSION_META_PREFIX, "").trim();
  } else {
    // "Codex openscout - rest" / long left side before em dash that looks like meta
    const split = title.match(/^(.{6,72}?)\s[-–—]\s+(.+)$/u);
    if (split) {
      const left = split[1] ?? "";
      const right = split[2] ?? "";
      if (
        HARNESS_PREFIX.test(left)
        || /\b(?:am|pm|\d{1,2}:\d{2}|plugin|session|openscout)\b/iu.test(left)
      ) {
        title = right.trim();
      }
    }
  }

  title = title.replace(HARNESS_PREFIX, "").replace(/^\s*[-–—:]\s*/, "").trim();
  title = title.replace(/\s{2,}/g, " ").trim();

  if (title.length > 72) {
    title = `${title.slice(0, 69).replace(/\s+\S*$/u, "").trimEnd()}…`;
  }
  return title;
}

/** Session goal / first-prompt title (shared across moments in a session). */
export function resultSessionGoal(hit: KnowledgeHit): string {
  const project = facetText(hit, "project");
  const raw = hit.title.replace(/\s+/g, " ").trim();
  if (raw && !isMachineChunkTitle(raw)) {
    const cleaned = cleanHeadlineText(raw);
    if (cleaned && cleaned.toLowerCase() !== project.toLowerCase()) return cleaned;
    if (cleaned) return cleaned;
  }
  if (project) return project;
  const sessionId = transcriptSessionId(firstTranscriptRef(hit));
  if (sessionId) return sessionId.length > 18 ? `${sessionId.slice(0, 16)}…` : sessionId;
  return "Session match";
}

/** @deprecated Prefer resultSessionGoal / resultMomentHeadline */
export function resultHeadline(hit: KnowledgeHit): string {
  return resultSessionGoal(hit);
}

/** Primary role for a moment (single label, not a multi-role dump). */
export function resultPrimaryRole(hit: KnowledgeHit): string {
  const kinds = facetList(hit, "recordKind", 8).map((kind) => kind.toLowerCase());
  if (kinds.length === 0) {
    kinds.push(...facetList(hit, "recordTag", 8).map((tag) => tag.toLowerCase()));
  }
  if (kinds.some((kind) => kind.includes("assistant"))) return "assistant";
  if (kinds.some((kind) => kind.includes("user"))) return "user";
  if (kinds.some((kind) => kind.includes("tool") || kind.includes("command") || kind.includes("response"))) {
    return "tool";
  }
  const where = resultWhere(hit);
  if (where === "tool activity") return "tool";
  if (where === "overview") return "overview";
  return "";
}

/**
 * Headline for one matched moment — prose from the snippet, not the session title.
 * Prefers a clause that contains a query term.
 */
export function resultMomentHeadline(hit: KnowledgeHit, query: string): string {
  const cleaned = cleanSnippetText(hit.snippet, query);
  const role = resultPrimaryRole(hit);
  const turn = resultTurnLabel(hit);

  let line = "";
  if (cleaned) {
    const terms = queryTerms(query).map((term) => term.toLowerCase());
    const clauses = cleaned
      .split(/(?<=[.!?])\s+|\s+[–—]\s+|\s+·\s+/u)
      .map((part) => part.replace(/^…+|…+$/gu, "").trim())
      .filter((part) => part.length > 12);

    const withTerm = terms.length > 0
      ? clauses.find((clause) => terms.some((term) => findWordMatchIndex(clause, term) >= 0))
      : undefined;

    line = (withTerm ?? clauses[0] ?? cleaned).replace(/^…+|…+$/gu, "").trim();
  }

  if (!line) {
    if (role && turn) return `${role} · ${turn}`;
    return turn || role || resultSessionGoal(hit);
  }

  if (line.length > 78) {
    line = `${line.slice(0, 75).replace(/\s+\S*$/u, "").trimEnd()}…`;
  }
  return line;
}

/** Pull a human when-label out of session titles like "Codex openscout Jul 16 at 5:37 PM - …". */
export function resultWhen(hit: KnowledgeHit): string {
  if (hit.freshness && hit.freshness !== "unknown") return hit.freshness;
  const raw = hit.title.replace(/\s+/g, " ").trim();
  const match = raw.match(
    /\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}(?:\s+at\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)?)\b/iu,
  );
  return match?.[1] ?? "";
}

function humanDocumentKind(value: string): string {
  const kind = value.trim().toLowerCase();
  if (!kind) return "";
  if (kind === "events" || kind.startsWith("events")) return "conversation";
  if (kind === "overview" || kind === "summary") return "overview";
  if (kind === "tool-calls" || kind === "tools") return "tool activity";
  if (kind === "files" || kind === "files-touched") return "files touched";
  if (kind === "manifest") return "session index";
  return kind.replace(/[-_]+/g, " ");
}

function capitalizeLabel(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/** Agent / harness label for SERP context (Codex, Claude, …). */
export function resultAgentLabel(hit: KnowledgeHit): string {
  const harness = facetText(hit, "harness") || firstTranscriptRef(hit)?.harness || "";
  if (!harness) return "";
  const key = harness.toLowerCase();
  if (key === "claude") return "Claude";
  if (key === "codex") return "Codex";
  if (key === "kimi") return "Kimi";
  if (key === "cursor") return "Cursor";
  return capitalizeLabel(harness);
}

/** Short session handle from facets or transcript path. */
export function resultSessionLabel(hit: KnowledgeHit): string {
  const fromFacet = facetText(hit, "sessionId").trim();
  const fromRef = transcriptSessionId(firstTranscriptRef(hit));
  const id = (fromFacet || fromRef || "").trim();
  if (!id) return "";
  // Keep scannable: UUID / long hashes → first 8; short ids stay whole.
  if (id.length > 14) return id.slice(0, 8);
  return id;
}

/**
 * Turn / record-window label.
 * Event windows map to transcript record ranges; single-record hits become "turn N".
 */
export function resultTurnLabel(hit: KnowledgeHit): string {
  const range = firstTranscriptRef(hit)?.recordRange;
  if (range) {
    const [start, end] = range;
    if (start === end) return `turn ${start}`;
    if (end - start <= 1) return `turns ${start}–${end}`;
    return `turns ${start}–${end}`;
  }
  const windowMatch = hit.title.match(/events?\s+window\s+(\d+)/iu);
  if (windowMatch) return `window ${Number(windowMatch[1])}`;
  return "";
}

/** Roles present in the matched chunk (user / assistant / tool). */
export function resultRoleLabel(hit: KnowledgeHit): string {
  const kinds = facetList(hit, "recordKind", 8).map((kind) => kind.toLowerCase());
  if (kinds.length === 0) {
    // Fall back to tags when kinds are sparse.
    kinds.push(...facetList(hit, "recordTag", 8).map((tag) => tag.toLowerCase()));
  }
  const parts: string[] = [];
  if (kinds.some((kind) => kind.includes("user"))) parts.push("user");
  if (kinds.some((kind) => kind.includes("assistant"))) parts.push("assistant");
  if (kinds.some((kind) => kind.includes("tool") || kind.includes("command") || kind.includes("response"))) {
    parts.push("tool");
  }
  if (parts.length === 0) return "";
  return parts.join(" · ");
}

/** Where in the session this chunk came from (conversation, tools, overview…). */
export function resultWhere(hit: KnowledgeHit): string {
  const documentKind = facetText(hit, "documentKind");
  if (documentKind) {
    const first = documentKind.split(",")[0]?.trim() ?? documentKind;
    return humanDocumentKind(first);
  }
  if (isMachineChunkTitle(hit.title)) return humanDocumentKind(hit.title);
  const path = firstFileRef(hit);
  if (path) return "file";
  return firstTranscriptRef(hit) ? "conversation" : "";
}

export function resultRecordRange(hit: KnowledgeHit): string {
  const range = firstTranscriptRef(hit)?.recordRange;
  if (!range) return "";
  return `records ${range[0]}–${range[1]}`;
}

function facetList(hit: KnowledgeHit, key: string, limit = 3): string[] {
  const value = hit.facets[key];
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return values.map((entry) => entry.trim()).filter(Boolean).slice(0, limit);
}

export type ResultRoutingContext = {
  agent: string;
  project: string;
  session: string;
  when: string;
  turn: string;
  role: string;
  where: string;
};

/** Structured agent / session / turn fields for each SERP row. */
export function resultRoutingContext(hit: KnowledgeHit): ResultRoutingContext {
  return {
    agent: resultAgentLabel(hit),
    project: facetText(hit, "project"),
    session: resultSessionLabel(hit),
    when: resultWhen(hit),
    turn: resultTurnLabel(hit),
    role: resultRoleLabel(hit),
    where: resultWhere(hit),
  };
}

/**
 * Moment-row details under a session header.
 * Omits redundant "Matched …" / generic "conversation" — those are implied by search + grouping.
 */
export function resultMomentBits(hit: KnowledgeHit): string[] {
  const bits: string[] = [];
  const turn = resultTurnLabel(hit);
  if (turn) bits.push(turn);
  const role = resultPrimaryRole(hit);
  if (role) bits.push(role);
  const where = resultWhere(hit);
  if (where && where !== "conversation") bits.push(where);

  const tools = facetList(hit, "toolName", 2);
  if (tools.length === 1) bits.push(tools[0]!);
  if (tools.length > 1) bits.push(tools.join(", "));

  const seen = new Set<string>();
  return bits.filter((bit) => {
    const key = bit.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** @deprecated Prefer resultMomentBits under session groups */
export function resultDetailBits(hit: KnowledgeHit, query: string): string[] {
  const bits = resultMomentBits(hit);
  const reason = matchReason(hit, query);
  if (reason && !bits.some((bit) => bit.toLowerCase().includes("match"))) bits.push(reason);
  return bits;
}

export function shortSnippet(hit: KnowledgeHit, query: string, maxLen = 140): string {
  const full = displaySnippet(hit, query);
  if (full.length <= maxLen) return full;
  return `${full.slice(0, maxLen - 1).replace(/\s+\S*$/u, "").trimEnd()}…`;
}

function findWordMatchIndex(text: string, term: string): number {
  // Treat path/host glue (./~-) as part of the token so kimi.com / ~/.kimi-code do not match.
  const re = new RegExp(`(?<![A-Za-z0-9_./~-])${escapeRegExp(term)}(?![A-Za-z0-9_./~-])`, "iu");
  const match = re.exec(text);
  return match?.index ?? -1;
}

export function cleanSnippetText(snippet: string, query = ""): string {
  let compact = snippet.replace(/\s+/g, " ").trim();
  if (!compact) return "";

  // Strip QMD event-window glue: `… - [0234] \`assistant_turn\` - …`
  compact = compact.replace(/\s*-\s*\[\d{3,}\]\s*`[^`]+`(?:\s*\([^)]*\))?\s*-\s*/gu, " ");
  compact = compact.replace(/\[\d{3,}\]\s*`[^`]+`\s*/gu, "");
  compact = compact.replace(/\*\*/gu, "");
  compact = compact.replace(
    /\b(?:assistant_turn|user_turn|agent_reasoning|command_or_tool|response_item|system_record)\b/giu,
    " ",
  );
  // Drop filesystem / home paths (keep prose).
  compact = compact.replace(/(?:~\/|\.\.?\/|\/(?:Users|home|var|tmp|opt)\/)\S+/gu, " ");
  // Collapse URLs to nothing in body text (hosts in paths are noise for SERP).
  compact = compact.replace(/https?:\/\/\S+/gu, " ");
  compact = compact.replace(/\b[\w.-]+\.(?:com|net|org|io|dev|app)(?:\/\S*)?/giu, " ");
  // Drop JSON-ish fragments.
  compact = compact.replace(/\{[^{}]{0,160}\}/gu, " ");
  compact = compact.replace(/`[^`]{0,64}`/gu, (match) => {
    const inner = match.slice(1, -1);
    if (queryTerms(query).some((term) => findWordMatchIndex(inner, term) >= 0)) return inner;
    if (/^[A-Za-z][\w.-]{0,24}$/u.test(inner)) return inner;
    return " ";
  });
  compact = compact.replace(/\s{2,}/g, " ").trim();
  compact = compact.replace(/^[\s,;:.\-–—|/]+/u, "").trim();

  // Prefer prose before a trailing JSON dump.
  if (compact.includes("{") || compact.includes("[")) {
    const jsonStart = compact.search(/[\[{]/u);
    if (jsonStart > 18) {
      const before = compact.slice(0, jsonStart).trim().replace(/[-–—,:;]+$/u, "").trim();
      if (before) compact = before;
    }
  }

  // Window around a *word-boundary* query hit (not path substrings).
  const terms = queryTerms(query);
  const maxLen = 200;
  if (terms.length > 0 && compact.length > maxLen) {
    let best = -1;
    for (const term of terms) {
      const index = findWordMatchIndex(compact, term);
      if (index >= 0 && (best < 0 || index < best)) best = index;
    }
    if (best < 0) {
      // Fall back to plain includes only for multi-char path-ish terms.
      for (const term of terms) {
        if (term.length < 4) continue;
        const index = compact.toLowerCase().indexOf(term.toLowerCase());
        if (index >= 0 && (best < 0 || index < best)) best = index;
      }
    }
    if (best >= 0) {
      const pad = 48;
      const start = Math.max(0, best - pad);
      const end = Math.min(compact.length, start + maxLen);
      const slice = compact.slice(start, end).trim();
      compact = `${start > 0 ? "…" : ""}${slice}${end < compact.length ? "…" : ""}`;
    } else {
      compact = `${compact.slice(0, maxLen - 1).replace(/\s+\S*$/u, "").trimEnd()}…`;
    }
  } else if (compact.length > maxLen) {
    compact = `${compact.slice(0, maxLen - 1).replace(/\s+\S*$/u, "").trimEnd()}…`;
  }

  return compact.replace(/\s{2,}/g, " ").trim();
}

export function displaySnippet(hit: KnowledgeHit, query: string, maxLen?: number): string {
  const cleaned = cleanSnippetText(hit.snippet, query);
  if (!maxLen || cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, maxLen - 1).replace(/\s+\S*$/u, "").trimEnd()}…`;
}

export function matchReason(hit: KnowledgeHit, query: string): string {
  const terms = matchedQueryTerms(hit, query);
  if (terms.length === 1) return `Matched “${terms[0]}”`;
  if (terms.length > 1) return `Matched ${terms.length} terms`;
  return "Matched in this session";
}

export function matchedQueryTerms(hit: KnowledgeHit, query: string): string[] {
  return queryTerms(query).filter((term) => {
    const lower = term.toLowerCase();
    return hit.title.toLowerCase().includes(lower)
      || hit.snippet.toLowerCase().includes(lower)
      || cleanSnippetText(hit.snippet, query).toLowerCase().includes(lower);
  });
}

export function previewRecordKindLabel(record: KnowledgeSourcePreviewRecord): string {
  const kind = (record.kind || record.role || record.type || "record").toLowerCase();
  if (kind === "assistant_turn" || kind === "assistant") return "assistant";
  if (kind === "user_turn" || kind === "user") return "user";
  if (kind === "system_record" || kind === "system") return "system";
  if (kind === "command_or_tool" || kind === "tool_use") return "tool";
  if (kind === "response_item") return "tool output";
  if (kind === "agent_reasoning" || kind === "reasoning") return "reasoning";
  return kind.replace(/_/gu, " ");
}

export function previewRecordPriority(record: KnowledgeSourcePreviewRecord): number {
  const kind = (record.kind || record.role || record.type || "").toLowerCase();
  if (
    kind === "assistant"
    || kind === "assistant_turn"
    || kind === "user"
    || kind === "user_turn"
    || kind === "last-prompt"
    || kind === "ai-title"
  ) {
    return 0;
  }
  if (kind === "system" || kind === "system_record" || kind.includes("reasoning")) return 1;
  return 2;
}

export function scoreMatchKind(hit: KnowledgeHit): string {
  if (hit.scoreSource === "hybrid") return "Words and meaning";
  if (hit.scoreSource === "vector") return "Similar in meaning";
  return "Exact words";
}

/**
 * Explain the match without inventing where it occurred. Hit metadata can say
 * a chunk contains assistant turns even when the query only matched its title;
 * a role-specific claim is therefore made only from a matched preview record.
 */
export function matchExplanation(
  hit: KnowledgeHit,
  query: string,
  record?: KnowledgeSourcePreviewRecord | null,
): string {
  const hitTerms = matchedQueryTerms(hit, query);
  const generic = hitTerms.length === 1
    ? `Matched “${hitTerms[0]}”`
    : hitTerms.length > 1
      ? `Matched ${hitTerms.length} terms`
      : "Matched in this session";
  if (!record?.matched) return generic;

  // Role-specific wording must be supported by text the inspector actually
  // shows. Raw JSONL can match paths, ids, or tool scaffolding that never
  // appears in the visible turn.
  const recordText = [record.renderedText, record.summary]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const recordTerms = hitTerms.filter((term) => recordText.includes(term.toLowerCase()));
  if (recordTerms.length === 0) return generic;

  const role = previewRecordKindLabel(record);
  const where = role === "assistant"
    ? "an assistant reply"
    : role === "user"
      ? "your message"
      : role === "tool"
        ? "a tool call"
        : role === "tool output"
          ? "tool output"
          : role === "system"
            ? "a system record"
            : role === "reasoning"
              ? "agent reasoning"
              : `a ${role} record`;
  if (recordTerms.length === 1) return `Matched “${recordTerms[0]}” in ${where}`;
  return `Matched ${recordTerms.length} terms in ${where}`;
}

/** Portable source reference suitable for the clipboard, including range. */
export function sourceReference(hit: KnowledgeHit): string {
  const transcript = firstTranscriptRef(hit);
  if (transcript) {
    const path = pathLabel(transcript.path);
    const range = transcript.recordRange;
    return range ? `${path}#R${range[0]}-R${range[1]}` : path;
  }
  const file = firstFileRef(hit);
  if (file) {
    const path = pathLabel(file.path);
    const range = file.lineRange;
    return range ? `${path}#L${range[0]}-L${range[1]}` : path;
  }
  return hit.id;
}

export type ConversationExcerptBlock =
  | { kind: "turn"; record: KnowledgeSourcePreviewRecord; role: string }
  | { kind: "folded"; records: KnowledgeSourcePreviewRecord[]; summary: string };

function foldedBlockSummary(records: KnowledgeSourcePreviewRecord[]): string {
  const toolCount = records.filter((record) => previewRecordPriority(record) === 2).length;
  const processCount = records.length - toolCount;
  const matchSuffix = records.some((record) => record.matched) ? " · match inside" : "";
  if (toolCount > 0 && processCount === 0) {
    return `${toolCount} tool step${toolCount === 1 ? "" : "s"}${matchSuffix}`;
  }
  if (toolCount === 0) {
    return `${processCount} process step${processCount === 1 ? "" : "s"}${matchSuffix}`;
  }
  return `${toolCount} tool + ${processCount} process step${records.length === 1 ? "" : "s"}${matchSuffix}`;
}

function overflowBlockSummary(records: KnowledgeSourcePreviewRecord[]): string {
  return `${records.length} more conversation turn${records.length === 1 ? "" : "s"}`;
}

/** Keep human turns visible while folding process/tool noise and bounded overflow. */
export function buildConversationExcerpt(
  records: KnowledgeSourcePreviewRecord[],
  options: { contextRadius?: number; maxTurns?: number; centerRecordIndex?: number } = {},
): ConversationExcerptBlock[] {
  if (records.length === 0) return [];
  const contextRadius = options.contextRadius ?? 3;
  const maxTurns = options.maxTurns ?? 6;
  const requestedCenter = options.centerRecordIndex === undefined
    ? -1
    : records.findIndex((record) => record.index === options.centerRecordIndex);
  const firstMatched = records.findIndex((record) => record.matched);
  const center = requestedCenter >= 0 ? requestedCenter : firstMatched >= 0 ? firstMatched : 0;
  const window = records.slice(
    Math.max(0, center - contextRadius),
    Math.min(records.length, center + contextRadius + 1),
  );
  const blocks: ConversationExcerptBlock[] = [];
  let folded: KnowledgeSourcePreviewRecord[] = [];
  let overflow: KnowledgeSourcePreviewRecord[] = [];
  let visibleTurns = 0;

  const flushFold = () => {
    if (folded.length === 0) return;
    blocks.push({ kind: "folded", records: folded, summary: foldedBlockSummary(folded) });
    folded = [];
  };

  const flushOverflow = () => {
    if (overflow.length === 0) return;
    blocks.push({ kind: "folded", records: overflow, summary: overflowBlockSummary(overflow) });
    overflow = [];
  };

  for (const record of window) {
    // Process/tool records remain folded even when they contain the match.
    // Their raw payloads can be enormous; the match explanation above the
    // excerpt still identifies where the hit occurred without turning the
    // conversation preview into a terminal transcript.
    if (previewRecordPriority(record) > 0) {
      flushOverflow();
      folded.push(record);
      continue;
    }
    flushFold();
    if (visibleTurns >= maxTurns) {
      overflow.push(record);
      continue;
    }
    blocks.push({ kind: "turn", record, role: previewRecordKindLabel(record) });
    visibleTurns += 1;
  }
  flushFold();
  flushOverflow();
  return blocks;
}

export type SessionSearchResult = {
  collectionId: string;
  best: KnowledgeHit;
  moments: KnowledgeHit[];
};

function momentSortKey(hit: KnowledgeHit): number {
  const range = firstTranscriptRef(hit)?.recordRange;
  if (range) return range[0];
  return Number.MAX_SAFE_INTEGER;
}

/** Collapse chunk hits into session groups; moments sorted by turn/record range. */
export function groupHitsBySession(hits: KnowledgeHit[]): SessionSearchResult[] {
  const order: string[] = [];
  const groups = new Map<string, KnowledgeHit[]>();
  for (const hit of hits) {
    const key = hit.collectionId || hit.id;
    const list = groups.get(key);
    if (!list) {
      order.push(key);
      groups.set(key, [hit]);
    } else {
      list.push(hit);
    }
  }
  return order.map((collectionId) => {
    const moments = [...(groups.get(collectionId) ?? [])].sort((left, right) => {
      const byTurn = momentSortKey(left) - momentSortKey(right);
      if (byTurn !== 0) return byTurn;
      return left.score - right.score;
    });
    // Keep ranking's top hit as "best" for auto-select, not necessarily earliest turn.
    const best = groups.get(collectionId)?.[0] ?? moments[0]!;
    return {
      collectionId,
      best,
      moments,
    };
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Highlight query terms with token boundaries so path/host substrings
 * (kimi.com, ~/.kimi-code) do not light up.
 */
export function highlightParts(text: string, query: string): HighlightPart[] {
  const terms = queryTerms(query);
  if (terms.length === 0 || text.length === 0) return [{ text, match: false }];
  const patterns = terms.map((term) =>
    `(?<![A-Za-z0-9_./~-])${escapeRegExp(term)}(?![A-Za-z0-9_./~-])`
  );
  const regex = new RegExp(`(${patterns.join("|")})`, "giu");
  const parts: HighlightPart[] = [];
  let cursor = 0;
  for (const match of text.matchAll(regex)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      parts.push({ text: text.slice(cursor, index), match: false });
    }
    parts.push({ text: match[0], match: true });
    cursor = index + match[0].length;
  }
  if (cursor < text.length) {
    parts.push({ text: text.slice(cursor), match: false });
  }
  return parts.length > 0 ? parts : [{ text, match: false }];
}
// ── Source-kind vocabulary + filter URL state ─────────────────────────────
// The server advertises these via /api/knowledge/search-primitives; the client
// surfaces them as a chip row that round-trips through the URL.
export const KNOWLEDGE_SOURCE_KIND_LABELS: Record<string, string> = {
  sessions: "Sessions",
  skills: "Skills",
  mcp: "MCP",
  codebase: "Codebase",
  context_pack: "Context packs",
  mixed: "Mixed",
};

/** Time-window buckets the chip row can pin the search to. */
export const SEARCH_TIME_WINDOW_OPTIONS = [
  { value: "1", label: "Last 24h" },
  { value: "3", label: "Last 3 days" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
] as const;
export type SearchTimeWindowValue = (typeof SEARCH_TIME_WINDOW_OPTIONS)[number]["value"];

export type SearchTimeWindow = SearchTimeWindowValue | "all";

/** Order in which source-kind chips appear in the filter row. */
export const SEARCH_SOURCE_KIND_ORDER: readonly string[] = [
  "sessions",
  "skills",
  "mcp",
  "codebase",
  "context_pack",
];

/** User-visible filter state shared by the search surface and the URL. */
export type SearchFilters = {
  query: string;
  sourceKinds: string[];
  harness: string[];
  project: string[];
  timeWindow: SearchTimeWindow;
};

export const EMPTY_SEARCH_FILTERS: SearchFilters = {
  query: "",
  sourceKinds: [],
  harness: [],
  project: [],
  timeWindow: "all",
};

export function createEmptySearchFilters(): SearchFilters {
  return {
    query: "",
    sourceKinds: [],
    harness: [],
    project: [],
    timeWindow: "all",
  };
}

function isTimeWindowValue(value: string | null | undefined): value is SearchTimeWindowValue {
  if (!value) return false;
  return SEARCH_TIME_WINDOW_OPTIONS.some((option) => option.value === value);
}

function splitList(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Parse the durable filter state out of a URL's query string. */
export function parseSearchFiltersFromUrl(
  rawQuery: string | URLSearchParams | undefined | null,
): SearchFilters {
  const params = rawQuery == null
    ? new URLSearchParams()
    : typeof rawQuery === "string"
      ? new URLSearchParams(rawQuery)
      : rawQuery;
  const timeRaw = params.get("time");
  const timeWindow: SearchTimeWindow = isTimeWindowValue(timeRaw) ? timeRaw : "all";
  return {
    query: params.get("q")?.trim() ?? "",
    sourceKinds: splitList(params.get("source")),
    harness: splitList(params.get("harness")),
    project: splitList(params.get("project")),
    timeWindow,
  };
}

/**
 * Project a SearchFilters value onto a URLSearchParams. The `hit` deep-link id
 * is preserved when supplied so the search surface can co-exist with hit
 * routing (SCO-082 Phase B).
 */
export function serializeSearchFiltersToParams(
  filters: SearchFilters,
  options: { hitId?: string | null } = {},
): URLSearchParams {
  const params = new URLSearchParams();
  const query = filters.query.trim();
  if (query) params.set("q", query);
  if (filters.sourceKinds.length > 0) params.set("source", filters.sourceKinds.join(","));
  if (filters.harness.length > 0) params.set("harness", filters.harness.join(","));
  if (filters.project.length > 0) params.set("project", filters.project.join(","));
  if (filters.timeWindow !== "all") params.set("time", filters.timeWindow);
  if (options.hitId) params.set("hit", options.hitId);
  return params;
}

export function searchFiltersAreEqual(left: SearchFilters, right: SearchFilters): boolean {
  return left.query.trim() === right.query.trim()
    && left.timeWindow === right.timeWindow
    && sameStringList(left.sourceKinds, right.sourceKinds)
    && sameStringList(left.harness, right.harness)
    && sameStringList(left.project, right.project);
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const normLeft = [...left].map((entry) => entry.trim().toLowerCase()).sort();
  const normRight = [...right].map((entry) => entry.trim().toLowerCase()).sort();
  return normLeft.every((entry, index) => entry === normRight[index]);
}

export function searchFiltersAreActive(filters: SearchFilters): boolean {
  return filters.query.trim().length > 0
    || filters.sourceKinds.length > 0
    || filters.harness.length > 0
    || filters.project.length > 0
    || filters.timeWindow !== "all";
}

export function searchTimeWindowMs(window: SearchTimeWindow): number | null {
  if (window === "all") return null;
  const days = Number.parseInt(window, 10);
  if (!Number.isFinite(days) || days <= 0) return null;
  return Date.now() - days * 24 * 60 * 60 * 1000;
}

export function searchTimeWindowLabel(window: SearchTimeWindow): string {
  if (window === "all") return "Any time";
  const match = SEARCH_TIME_WINDOW_OPTIONS.find((option) => option.value === window);
  return match?.label ?? window;
}
