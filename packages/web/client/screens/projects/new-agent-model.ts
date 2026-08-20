/* ── New-agent creation model ─────────────────────────────────────────────
   Pure helpers behind the project "New agent" flow: handle normalization,
   validation (auto / invalid / conflict), handle suggestions, and the routing
   preview. Kept side-effect free so the modal stays a thin view and the rules
   are unit-testable. Routing language follows the Agent Identity And Addressing
   section of docs/architecture.md — a handle
   is a fresh-session target; session:<id> is the only exact-continuation
   handle. ── */

export type ProjectLaunchHarness = "codex" | "claude" | "pi";
export type ProjectLaunchPersistence = "one_time" | "sticky";

export const PROJECT_LAUNCH_HARNESSES: Array<{
  value: ProjectLaunchHarness;
  label: string;
  /** Harness-catalog id used to read readiness from /api/agent-config/snapshot. */
  runtimeId: string;
}> = [
  { value: "codex", label: "Codex", runtimeId: "codex" },
  { value: "claude", label: "Claude", runtimeId: "claude" },
  { value: "pi", label: "Grok", runtimeId: "pi" },
];

/** Slug a free-typed handle into a broker-safe handle, or undefined. */
export function normalizeAgentHandle(value: string): string | undefined {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || undefined;
}

export type HandleValidationStatus = "ok" | "auto" | "invalid" | "conflict";

export type HandleValidation = {
  status: HandleValidationStatus;
  /** The handle that would actually be persisted (slugged), when user-supplied. */
  normalized: string | undefined;
  /** Whether the handle differs from what the user typed (so we can echo it). */
  rewritten: boolean;
  message: string | null;
  /** Soft states (empty/invalid/conflict) still allow submit; only root gates it. */
  tone: "ok" | "hint" | "warn";
};

/** Build the set of existing handle slugs in a project for conflict checks. */
export function existingHandleSet(handles: Iterable<string | null | undefined>): Set<string> {
  const set = new Set<string>();
  for (const handle of handles) {
    if (!handle) continue;
    const slug = normalizeAgentHandle(handle);
    if (slug) set.add(slug);
  }
  return set;
}

export function validateHandle(
  raw: string,
  existing: Set<string>,
  persistence: ProjectLaunchPersistence,
): HandleValidation {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      status: "auto",
      normalized: undefined,
      rewritten: false,
      message:
        persistence === "sticky"
          ? "Scout will assign a reusable handle from the name pool."
          : "Scout will assign a disposable handle from the name pool.",
      tone: "ok",
    };
  }
  const normalized = normalizeAgentHandle(trimmed);
  if (!normalized) {
    return {
      status: "invalid",
      normalized: undefined,
      rewritten: false,
      message: "Use letters, numbers, dot, or dash.",
      tone: "warn",
    };
  }
  if (existing.has(normalized)) {
    return {
      status: "conflict",
      normalized,
      rewritten: normalized !== trimmed.toLowerCase().replace(/^@+/, ""),
      message: `@${normalized} already exists here. Pick another handle or leave it blank for auto.`,
      tone: "warn",
    };
  }
  return {
    status: "ok",
    normalized,
    rewritten: normalized !== trimmed.toLowerCase().replace(/^@+/, ""),
    message: null,
    tone: "ok",
  };
}

function harnessSlug(harness: ProjectLaunchHarness): string {
  return harness === "pi" ? "grok" : harness;
}

/** Up to `limit` free handle suggestions, conflict-filtered, project-first. */
export function suggestHandles(
  projectTitle: string,
  harness: ProjectLaunchHarness,
  existing: Set<string>,
  limit = 3,
): string[] {
  const base = normalizeAgentHandle(projectTitle) ?? "agent";
  const candidates = [
    base,
    `${base}-${harnessSlug(harness)}`,
    `${base}-dev`,
    `${base}-2`,
    `${base}-${harnessSlug(harness)}-2`,
  ];
  const out: string[] = [];
  for (const candidate of candidates) {
    const slug = normalizeAgentHandle(candidate);
    if (!slug || existing.has(slug) || out.includes(slug)) continue;
    out.push(slug);
    if (out.length >= limit) break;
  }
  return out;
}

export type RoutingPreview = {
  /** True for one-off dispatch — disposable session, not addressable later. */
  disposable: boolean;
  /** Address when a durable handle is known or auto-assigned, else null. */
  card: string | null;
  /** Copy-pasteable CLI that addresses the agent for future work. */
  cli: string;
  /** How the broker resolves the target on Create. */
  resolves: string;
  /** Continuity reminder, constant but surfaced in context. */
  note: string;
};

/* The creation mode is the switch. A sticky session gets a reusable handle; if
   the user leaves it blank, Scout allocates one from the configured pool. */
export function routingPreview(input: {
  handle: string | undefined;
  persistence: ProjectLaunchPersistence;
  harness: ProjectLaunchHarness;
  projectRootLabel: string;
}): RoutingPreview {
  const { handle, persistence, harness, projectRootLabel } = input;
  const note = "A card starts a fresh session for each request. Use session:<id> only to continue an exact run.";

  if (persistence === "one_time") {
    return {
      disposable: true,
      card: null,
      cli: `scout ask --project ${projectRootLabel} --harness ${harness} "…"`,
      resolves:
        "Disposable session — Scout assigns a provisional handle that may be recycled. Not addressable later.",
      note,
    };
  }
  if (handle) {
    return {
      disposable: false,
      card: `@${handle}`,
      cli: `scout ask @${handle} "…"`,
      resolves: `Reusable ${harnessSlug(harness)} session on this project — @${handle} routes here from any surface.`,
      note,
    };
  }
  return {
    disposable: false,
    card: "@auto",
    cli: `scout ask @<assigned-handle> "…"`,
    resolves: `Scout assigns a reusable ${harnessSlug(harness)} handle from the name pool.`,
    note,
  };
}
