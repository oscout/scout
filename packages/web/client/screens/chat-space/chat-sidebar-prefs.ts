/**
 * Per-space sidebar list prefs for Scout Chat.
 *
 * Pin, archive, sort, and "latest only" are window-local: they shape this
 * browser's channel list, they are not membership, and they do not go on the
 * wire. Last-opened timestamps are the only recency we actually have —
 * ConversationDefinition carries no activity clock.
 */

import type { ConversationDefinition } from "@openscout/protocol";

export type ChatSidebarSort = "alpha" | "recent";

export type ChatSidebarPrefs = {
  pinned: string[];
  archived: string[];
  sort: ChatSidebarSort;
  latestOnly: boolean;
  showArchived: boolean;
  lastOpened: Record<string, number>;
};

const LATEST_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export const EMPTY_CHAT_SIDEBAR_PREFS: ChatSidebarPrefs = {
  pinned: [],
  archived: [],
  sort: "alpha",
  latestOnly: false,
  showArchived: false,
  lastOpened: {},
};

export function chatSidebarPrefsKey(space: string): string {
  return `openscout.chat.sidebar.${space || "home"}`;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

export function parseChatSidebarPrefs(raw: unknown): ChatSidebarPrefs {
  if (!raw || typeof raw !== "object") return { ...EMPTY_CHAT_SIDEBAR_PREFS };
  const value = raw as Record<string, unknown>;
  const lastOpened: Record<string, number> = {};
  if (value.lastOpened && typeof value.lastOpened === "object") {
    for (const [id, at] of Object.entries(value.lastOpened as Record<string, unknown>)) {
      if (typeof at === "number" && Number.isFinite(at)) lastOpened[id] = at;
    }
  }
  return {
    pinned: asStringArray(value.pinned),
    archived: asStringArray(value.archived),
    sort: value.sort === "recent" ? "recent" : "alpha",
    latestOnly: value.latestOnly === true,
    showArchived: value.showArchived === true,
    lastOpened,
  };
}

export function readChatSidebarPrefs(space: string): ChatSidebarPrefs {
  if (typeof window === "undefined") return { ...EMPTY_CHAT_SIDEBAR_PREFS };
  try {
    const raw = window.localStorage.getItem(chatSidebarPrefsKey(space));
    if (!raw) return { ...EMPTY_CHAT_SIDEBAR_PREFS };
    return parseChatSidebarPrefs(JSON.parse(raw));
  } catch {
    return { ...EMPTY_CHAT_SIDEBAR_PREFS };
  }
}

export function writeChatSidebarPrefs(space: string, prefs: ChatSidebarPrefs): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(chatSidebarPrefsKey(space), JSON.stringify(prefs));
  } catch {
    // Prefs hold for this visit when device storage is unavailable.
  }
}

export function toggleId(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
}

function titleOf(conversation: ConversationDefinition): string {
  return conversation.title.replace(/^#/u, "").trim() || conversation.title;
}

function matchesQuery(conversation: ConversationDefinition, query: string): boolean {
  if (!query) return true;
  return titleOf(conversation).toLowerCase().includes(query);
}

function sortConversations(
  items: ConversationDefinition[],
  sort: ChatSidebarSort,
  lastOpened: Record<string, number>,
): ConversationDefinition[] {
  return [...items].sort((left, right) => {
    if (sort === "recent") {
      const delta = (lastOpened[right.id] ?? 0) - (lastOpened[left.id] ?? 0);
      if (delta !== 0) return delta;
    }
    return titleOf(left).localeCompare(titleOf(right), undefined, { sensitivity: "base" });
  });
}

export function isLatestKeep(input: {
  id: string;
  pinned: ReadonlySet<string>;
  addressed: ReadonlySet<string>;
  selectedId: string | null;
  lastOpened: Record<string, number>;
  nowMs: number;
  hasAnyLastOpened: boolean;
}): boolean {
  if (input.pinned.has(input.id) || input.addressed.has(input.id) || input.id === input.selectedId) {
    return true;
  }
  if (!input.hasAnyLastOpened) return true;
  const opened = input.lastOpened[input.id];
  return typeof opened === "number" && input.nowMs - opened <= LATEST_WINDOW_MS;
}

export function organizeChatSidebarList(input: {
  channels: ConversationDefinition[];
  directs: ConversationDefinition[];
  prefs: ChatSidebarPrefs;
  query: string;
  addressed: ReadonlySet<string>;
  selectedId: string | null;
  nowMs: number;
}): {
  pinned: ConversationDefinition[];
  channels: ConversationDefinition[];
  directs: ConversationDefinition[];
  archived: ConversationDefinition[];
} {
  const query = input.query.trim().toLowerCase();
  const pinned = new Set(input.prefs.pinned);
  const archived = new Set(input.prefs.archived);
  const hasAnyLastOpened = Object.keys(input.prefs.lastOpened).length > 0;
  const keep = (item: ConversationDefinition) => {
    if (!matchesQuery(item, query)) return false;
    if (input.prefs.latestOnly && !isLatestKeep({
      id: item.id,
      pinned,
      addressed: input.addressed,
      selectedId: input.selectedId,
      lastOpened: input.prefs.lastOpened,
      nowMs: input.nowMs,
      hasAnyLastOpened,
    })) return false;
    return true;
  };

  const visibleChannels = input.channels.filter((item) => keep(item) && !archived.has(item.id));
  const pinnedItems = sortConversations(
    visibleChannels.filter((item) => pinned.has(item.id)),
    input.prefs.sort,
    input.prefs.lastOpened,
  );
  const channelItems = sortConversations(
    visibleChannels.filter((item) => !pinned.has(item.id)),
    input.prefs.sort,
    input.prefs.lastOpened,
  );
  const directItems = sortConversations(
    input.directs.filter((item) => keep(item) && !archived.has(item.id)),
    input.prefs.sort,
    input.prefs.lastOpened,
  );
  const pinnedDirects = directItems.filter((item) => pinned.has(item.id));
  const restDirects = directItems.filter((item) => !pinned.has(item.id));
  const archivedItems = input.prefs.showArchived
    ? sortConversations(
      [...input.channels, ...input.directs].filter((item) => archived.has(item.id) && matchesQuery(item, query)),
      input.prefs.sort,
      input.prefs.lastOpened,
    )
    : [];

  return {
    pinned: pinnedItems,
    channels: channelItems,
    directs: [...pinnedDirects, ...restDirects],
    archived: archivedItems,
  };
}
