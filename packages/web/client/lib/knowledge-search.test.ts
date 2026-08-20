import { describe, expect, test } from "bun:test";

import {
  buildConversationExcerpt,
  cleanHeadlineText,
  displaySnippet,
  groupHitsBySession,
  highlightParts,
  isMachineChunkTitle,
  KNOWLEDGE_SEARCH_DEFAULTS,
  matchExplanation,
  matchReason,
  parseSearchFiltersFromUrl,
  queryTerms,
  resultMomentHeadline,
  resultSessionGoal,
  resultRoutingContext,
  resultTurnLabel,
  scoreMatchKind,
  searchFiltersAreActive,
  searchFiltersAreEqual,
  searchTimeWindowLabel,
  searchTimeWindowMs,
  serializeSearchFiltersToParams,
  sourceReference,
  EMPTY_SEARCH_FILTERS,
  KNOWLEDGE_SOURCE_KIND_LABELS,
  type KnowledgeHit,
} from "./knowledge-search.ts";

function hit(input: {
  chunkId?: string;
  collectionId?: string;
  snippet?: string;
  title?: string;
  project?: string;
  harness?: string;
  sessionId?: string;
  recordRange?: [number, number];
  recordKind?: string[];
  documentKind?: string;
}): KnowledgeHit {
  const chunkId = input.chunkId ?? "chunk-1";
  const sessionId = input.sessionId ?? "sess-abcdef012345";
  return {
    id: `hit:${chunkId}`,
    collectionId: input.collectionId ?? "collection-1",
    documentId: `document-${chunkId}`,
    chunkId,
    title: input.title ?? "Session",
    snippet: input.snippet ?? "",
    score: 0,
    scoreSource: "fts",
    origin: "mechanical",
    ownership: "derived",
    freshness: "unknown",
    sourceRefs: input.recordRange
      ? [{
        kind: "harness_transcript",
        harness: input.harness ?? "codex",
        path: { root: "HOME", relPath: `.codex/${sessionId}.jsonl` },
        sessionId,
        recordRange: input.recordRange,
      }]
      : [],
    facets: {
      ...(input.project ? { project: input.project } : {}),
      ...(input.harness ? { harness: input.harness } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.documentKind ? { documentKind: input.documentKind } : {}),
      ...(input.recordKind ? { recordKind: input.recordKind } : {}),
    },
  };
}

describe("knowledge search helpers", () => {
  test("exposes smart defaults for indexing and search", () => {
    expect(KNOWLEDGE_SEARCH_DEFAULTS.days).toBe(3);
    expect(KNOWLEDGE_SEARCH_DEFAULTS.sessionLimit).toBeGreaterThan(0);
    expect(KNOWLEDGE_SEARCH_DEFAULTS.hitLimit).toBeGreaterThan(0);
    expect(KNOWLEDGE_SEARCH_DEFAULTS.debounceMs).toBeGreaterThan(0);
  });

  test("splits query terms and highlights only token-ish matches", () => {
    expect(queryTerms("embed /projects view")).toEqual(["embed", "/projects", "view"]);
    const prose = highlightParts("embed selected chunks for /projects", "embed /projects");
    expect(prose.some((part) => part.match && part.text.toLowerCase() === "embed")).toBe(true);
    expect(prose.some((part) => part.match && part.text === "/projects")).toBe(true);

    const pathNoise = highlightParts("see ~/.kimi-code/bin and kimi.com docs about Kimi", "kimi");
    expect(pathNoise.filter((part) => part.match).map((part) => part.text)).toEqual(["Kimi"]);
  });

  test("cleans event-window markers and path noise from snippets", () => {
    const dirty = "We should embed chunks - [0234] `assistant_turn` - {\"raw\":true}";
    expect(displaySnippet(hit({ snippet: dirty }), "embed")).toContain("We should embed chunks");
    expect(displaySnippet(hit({ snippet: dirty }), "embed")).not.toContain("assistant_turn");

    const pathy = "Updating adapter path to ~/.kimi-code/bin/kimi for Kimi discovery";
    const cleaned = displaySnippet(hit({ snippet: pathy }), "kimi");
    expect(cleaned.toLowerCase()).toContain("kimi discovery");
    expect(cleaned).not.toContain("~/.kimi");
    expect(matchReason(hit({ snippet: "embeddings provider", title: "Embeddings work" }), "embeddings")).toBe(
      "Matched “embeddings”",
    );
  });

  test("groups chunk hits into sessions and sorts moments by turn", () => {
    const groups = groupHitsBySession([
      hit({ chunkId: "late", collectionId: "s1", recordRange: [200, 249], title: "Events window 3" }),
      hit({ chunkId: "early", collectionId: "s1", recordRange: [40, 89], title: "Events window 1" }),
      hit({ chunkId: "c", collectionId: "s2", title: "Routing redesign", project: "openscout" }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.moments.map((moment) => moment.chunkId)).toEqual(["early", "late"]);
    expect(groups[0]?.best.chunkId).toBe("late"); // ranking order preserved for best
    expect(groups[1]?.best.chunkId).toBe("c");
  });

  test("session goal vs moment headline", () => {
    expect(isMachineChunkTitle("Events window 3")).toBe(true);
    expect(resultSessionGoal(hit({ title: "Events window 3", project: "openscout" }))).toBe("openscout");
    expect(
      resultSessionGoal(hit({
        title: "Codex openscout Jul 16 at 5:42 PM - <recommended_plugins> Here is a list of plugins",
        project: "openscout",
      })),
    ).toContain("list of plugins");

    const moment = hit({
      title: "Codex openscout Jul 16 at 5:42 PM - Here is a list of plugins",
      snippet: "Adding native Kimi source for session details in the tail firehose.",
      recordKind: ["assistant_turn"],
      recordRange: [40, 89],
    });
    expect(resultMomentHeadline(moment, "kimi")).toContain("Kimi source");
    expect(resultMomentHeadline(moment, "kimi")).not.toContain("list of plugins");
  });

  test("strips harness/date noise from session titles", () => {
    expect(
      cleanHeadlineText(
        "Codex openscout Jul 16 at 5:37 PM - <recommended_plugins> Here is a list of plugins that are available but not inst…",
      ),
    ).toBe("Here is a list of plugins that are available but not inst…");
  });

  test("windows long snippets around the query match", () => {
    const long = `prefix noise ${"x ".repeat(80)} does kimi support acp style adapter ${"y ".repeat(80)} trailing`;
    const snippet = displaySnippet(hit({ snippet: long }), "kimi");
    expect(snippet.toLowerCase()).toContain("kimi");
    expect(snippet.length).toBeLessThan(long.length);
  });

  test("exposes agent, session, and turn routing context", () => {
    const entry = hit({
      harness: "codex",
      project: "openscout",
      sessionId: "mro0fyeu-h89xnv-extra",
      recordRange: [40, 89],
      documentKind: "events",
      recordKind: ["user_turn", "assistant_turn", "command_or_tool"],
      title: "Codex openscout Jul 16 at 5:37 PM - plugin list",
    });
    expect(resultTurnLabel(entry)).toBe("turns 40–89");
    expect(resultRoutingContext(entry)).toEqual({
      agent: "Codex",
      project: "openscout",
      session: "mro0fyeu",
      when: "Jul 16 at 5:37 PM",
      turn: "turns 40–89",
      role: "user · assistant · tool",
      where: "conversation",
    });
  });

  test("builds a portable source reference with the record range", () => {
    const entry = hit({
      snippet: "selected chunks",
      title: "Embedding plan",
      recordKind: ["assistant_turn"],
      recordRange: [12, 18],
      harness: "claude",
    });

    expect(sourceReference(entry)).toEndWith("#R12-R18");
  });

  test("only names a match role when a matched preview record proves it", () => {
    const entry = hit({
      snippet: "unrelated body copy",
      title: "Embedding plan",
      recordKind: ["assistant_turn"],
      recordRange: [12, 12],
      harness: "claude",
    });

    expect(matchExplanation(entry, "embedding")).toBe('Matched “embedding”');
    expect(matchExplanation(entry, "embedding", {
      index: 12,
      raw: "assistant discussed embedding",
      kind: "assistant_turn",
      summary: "embedding selected chunks",
      renderedText: "embedding selected chunks",
      parsed: true,
      matched: true,
    })).toBe('Matched “embedding” in an assistant reply');
    expect(matchExplanation(entry, "embedding", {
      index: 12,
      raw: '{"cwd":"/workspace/embedding-lab"}',
      kind: "assistant_turn",
      summary: "sounds good",
      renderedText: "sounds good, shipping it",
      parsed: true,
      matched: true,
    })).toBe('Matched “embedding”');
    expect(scoreMatchKind(entry)).toBe("Exact words");
  });

  test("folds unmatched tool noise around the matched conversation turn", () => {
    const blocks = buildConversationExcerpt([
      {
        index: 10,
        raw: "{}",
        kind: "user_turn",
        summary: "should we embed?",
        renderedText: "should we embed?",
        parsed: true,
      },
      {
        index: 11,
        raw: "{}",
        kind: "command_or_tool",
        summary: "Bash",
        renderedText: "ran bash",
        parsed: true,
      },
      {
        index: 12,
        raw: "{}",
        kind: "response_item",
        summary: "command output",
        renderedText: "command output",
        parsed: true,
      },
      {
        index: 13,
        raw: "{}",
        kind: "assistant_turn",
        summary: "yes embed chunks",
        renderedText: "yes, embed selected chunks",
        parsed: true,
        matched: true,
      },
    ]);

    expect(blocks.some((block) => block.kind === "folded")).toBe(true);
    expect(blocks.some((block) =>
      block.kind === "turn" && block.role === "assistant" && block.record.matched
    )).toBe(true);
  });

  test("keeps matched tool output folded instead of flooding the conversation", () => {
    const blocks = buildConversationExcerpt([
      {
        index: 20,
        raw: "tool output ".repeat(5_000),
        kind: "response_item",
        summary: "large command output",
        renderedText: "artifact presentation result",
        parsed: true,
        matched: true,
      },
      {
        index: 21,
        raw: "{}",
        kind: "assistant_turn",
        summary: "the result is ready",
        renderedText: "the result is ready",
        parsed: true,
      },
    ]);

    expect(blocks[0]).toMatchObject({
      kind: "folded",
      summary: "1 tool step · match inside",
    });
    expect(blocks.some((block) => block.kind === "turn" && block.role === "tool output")).toBe(false);
  });

  test("centers the excerpt on the same preferred match used by the explanation", () => {
    const records = Array.from({ length: 10 }, (_, index) => ({
      index,
      raw: "{}",
      kind: index === 0 ? "command_or_tool" : index === 9 ? "assistant_turn" : "user_turn",
      summary: index === 9 ? "embedding is ready" : `record ${index}`,
      renderedText: index === 9 ? "embedding is ready" : `record ${index}`,
      parsed: true,
      matched: index === 0 || index === 9,
    }));

    const blocks = buildConversationExcerpt(records, {
      contextRadius: 4,
      maxTurns: 6,
      centerRecordIndex: 9,
    });

    expect(blocks.some((block) => block.kind === "turn" && block.record.index === 9)).toBe(true);
    expect(blocks.some((block) =>
      block.kind === "folded" && block.records.some((record) => record.index === 0)
    )).toBe(false);
  });

  test("accounts for conversation turns omitted by the visible-turn cap", () => {
    const records = Array.from({ length: 9 }, (_, index) => ({
      index,
      raw: "{}",
      kind: index % 2 === 0 ? "user_turn" : "assistant_turn",
      summary: `turn ${index}`,
      renderedText: `turn ${index}`,
      parsed: true,
      matched: index === 4,
    }));

    const blocks = buildConversationExcerpt(records, {
      contextRadius: 4,
      maxTurns: 6,
      centerRecordIndex: 4,
    });
    const represented = blocks.flatMap((block) =>
      block.kind === "turn" ? [block.record.index] : block.records.map((record) => record.index)
    );

    expect(represented).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(blocks.at(-1)).toMatchObject({ kind: "folded", summary: "3 more conversation turns" });
  });

  test("round-trips filter state through URL params", () => {
    const filters = parseSearchFiltersFromUrl(
      "q=embed%20sessions&source=sessions,skills&harness=codex&project=openscout&time=7",
    );
    expect(filters).toEqual({
      query: "embed sessions",
      sourceKinds: ["sessions", "skills"],
      harness: ["codex"],
      project: ["openscout"],
      timeWindow: "7",
    });

    const back = serializeSearchFiltersToParams(filters, { hitId: "hit-9" });
    expect(back.get("q")).toBe("embed sessions");
    expect(back.get("source")).toBe("sessions,skills");
    expect(back.get("harness")).toBe("codex");
    expect(back.get("project")).toBe("openscout");
    expect(back.get("time")).toBe("7");
    expect(back.get("hit")).toBe("hit-9");
  });

  test("drops blank list entries and clamps unknown time windows to all", () => {
    expect(parseSearchFiltersFromUrl("source=,,sessions,&harness=&time=99")).toEqual({
      query: "",
      sourceKinds: ["sessions"],
      harness: [],
      project: [],
      timeWindow: "all",
    });
    expect(parseSearchFiltersFromUrl(undefined)).toEqual(EMPTY_SEARCH_FILTERS);
  });

  test("ignores filters that produce empty params so the URL stays clean", () => {
    const params = serializeSearchFiltersToParams(EMPTY_SEARCH_FILTERS);
    expect([...params.keys()]).toEqual([]);
  });

  test("treats harness/project lists as order-insensitive sets", () => {
    const left = { ...EMPTY_SEARCH_FILTERS, harness: ["codex", "claude"], project: ["openscout"] };
    const right = { ...EMPTY_SEARCH_FILTERS, harness: ["claude", "codex"], project: ["openscout"] };
    expect(searchFiltersAreEqual(left, right)).toBe(true);
    expect(searchFiltersAreEqual(left, { ...right, harness: ["codex"] })).toBe(false);
    expect(searchFiltersAreEqual(left, { ...right, timeWindow: "7" as const })).toBe(false);
  });

  test("active-filter predicate ignores blank fields and respected all-window", () => {
    expect(searchFiltersAreActive(EMPTY_SEARCH_FILTERS)).toBe(false);
    expect(searchFiltersAreActive({ ...EMPTY_SEARCH_FILTERS, query: "  " })).toBe(false);
    expect(searchFiltersAreActive({ ...EMPTY_SEARCH_FILTERS, sourceKinds: ["sessions"] })).toBe(true);
    expect(searchFiltersAreActive({ ...EMPTY_SEARCH_FILTERS, timeWindow: "30" })).toBe(true);
  });

  test("time window labels and ms boundaries", () => {
    expect(searchTimeWindowLabel("all")).toBe("Any time");
    expect(searchTimeWindowLabel("7")).toBe("Last 7 days");
    expect(searchTimeWindowMs("all")).toBeNull();
    const oneDayMs = searchTimeWindowMs("1");
    expect(typeof oneDayMs).toBe("number");
    expect(oneDayMs).not.toBeNull();
    // within a couple of seconds of one day ago
    expect(oneDayMs!).toBeLessThanOrEqual(Date.now() - 24 * 60 * 60 * 1000 + 1500);
  });

  test("exposes human labels for every known source kind", () => {
    expect(KNOWLEDGE_SOURCE_KIND_LABELS.sessions).toBe("Sessions");
    expect(KNOWLEDGE_SOURCE_KIND_LABELS.context_pack).toBe("Context packs");
  });
});
