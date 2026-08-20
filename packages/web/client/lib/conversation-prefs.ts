/**
 * Operator-local pin / archive preferences for the chat rail.
 *
 * Scoped to this browser profile (localStorage), not broker state — pins and
 * archives are personal rail chrome, not shared conversation metadata.
 */

const STORAGE_KEY = "scout:conversations:prefs:v1";

export type ConversationPrefs = {
  /** conversationId → pin timestamp (ms). Higher = more recently pinned. */
  pinned: Record<string, number>;
  /** conversationId → archive timestamp (ms). */
  archived: Record<string, number>;
};

const EMPTY: ConversationPrefs = { pinned: {}, archived: {} };

/** In-process fallback when localStorage is missing or throws (tests, private mode). */
let memoryPrefs: ConversationPrefs = { pinned: {}, archived: {} };

export function loadConversationPrefs(): ConversationPrefs {
  try {
    if (typeof localStorage !== "undefined") {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<ConversationPrefs> | null;
        if (parsed && typeof parsed === "object") {
          const next = {
            pinned: isRecord(parsed.pinned) ? { ...parsed.pinned } : {},
            archived: isRecord(parsed.archived) ? { ...parsed.archived } : {},
          };
          memoryPrefs = next;
          return { pinned: { ...next.pinned }, archived: { ...next.archived } };
        }
      }
    }
  } catch {
    // fall through to memory
  }
  return { pinned: { ...memoryPrefs.pinned }, archived: { ...memoryPrefs.archived } };
}

export function saveConversationPrefs(prefs: ConversationPrefs): ConversationPrefs {
  const next: ConversationPrefs = {
    pinned: { ...prefs.pinned },
    archived: { ...prefs.archived },
  };
  memoryPrefs = next;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    }
  } catch {
    // Ignore quota/disabled localStorage — memory still holds it for the session
  }
  return { pinned: { ...next.pinned }, archived: { ...next.archived } };
}

export function isPinned(id: string, prefs: ConversationPrefs): boolean {
  return prefs.pinned[id] != null;
}

export function isArchived(id: string, prefs: ConversationPrefs): boolean {
  return prefs.archived[id] != null;
}

/** Pin (or re-pin to bump sort). Mutually exclusive with archive. */
export function pinConversation(id: string, prefs: ConversationPrefs, at = Date.now()): ConversationPrefs {
  const next: ConversationPrefs = {
    pinned: { ...prefs.pinned, [id]: at },
    archived: { ...prefs.archived },
  };
  delete next.archived[id];
  return saveConversationPrefs(next);
}

export function unpinConversation(id: string, prefs: ConversationPrefs): ConversationPrefs {
  if (prefs.pinned[id] == null) return prefs;
  const next: ConversationPrefs = {
    pinned: { ...prefs.pinned },
    archived: { ...prefs.archived },
  };
  delete next.pinned[id];
  return saveConversationPrefs(next);
}

/** Archive. Mutually exclusive with pin. */
export function archiveConversation(id: string, prefs: ConversationPrefs, at = Date.now()): ConversationPrefs {
  const next: ConversationPrefs = {
    pinned: { ...prefs.pinned },
    archived: { ...prefs.archived, [id]: at },
  };
  delete next.pinned[id];
  return saveConversationPrefs(next);
}

export function unarchiveConversation(id: string, prefs: ConversationPrefs): ConversationPrefs {
  if (prefs.archived[id] == null) return prefs;
  const next: ConversationPrefs = {
    pinned: { ...prefs.pinned },
    archived: { ...prefs.archived },
  };
  delete next.archived[id];
  return saveConversationPrefs(next);
}

export function togglePin(id: string, prefs: ConversationPrefs): ConversationPrefs {
  return isPinned(id, prefs) ? unpinConversation(id, prefs) : pinConversation(id, prefs);
}

export function toggleArchive(id: string, prefs: ConversationPrefs): ConversationPrefs {
  return isArchived(id, prefs) ? unarchiveConversation(id, prefs) : archiveConversation(id, prefs);
}

/** Sort key: higher = more recently pinned (for stable top-of-rail order). */
export function pinRank(id: string, prefs: ConversationPrefs): number {
  return prefs.pinned[id] ?? 0;
}

function isRecord(value: unknown): value is Record<string, number> {
  if (!value || typeof value !== "object") return false;
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (typeof v !== "number" || !Number.isFinite(v)) return false;
  }
  return true;
}

/** Test helper — not used in production. */
export function emptyConversationPrefs(): ConversationPrefs {
  return { pinned: {}, archived: {} };
}

export const __test = { EMPTY, STORAGE_KEY };
