import { describe, expect, test } from "bun:test";
import type { ConversationDefinition } from "@openscout/protocol";

import {
  EMPTY_CHAT_SIDEBAR_PREFS,
  isLatestKeep,
  organizeChatSidebarList,
  parseChatSidebarPrefs,
  toggleId,
} from "./chat-sidebar-prefs.ts";

const NOW = 1_700_000_000_000;

const channel = (id: string, title: string): ConversationDefinition => ({
  id,
  kind: "channel",
  title,
  visibility: "workspace",
  shareMode: "shared",
  authorityNodeId: "node-1",
  participantIds: [],
});

const direct = (id: string, title: string): ConversationDefinition => ({
  ...channel(id, title),
  kind: "direct",
});

describe("parseChatSidebarPrefs", () => {
  test("fills defaults and drops junk", () => {
    expect(parseChatSidebarPrefs(null)).toEqual(EMPTY_CHAT_SIDEBAR_PREFS);
    expect(parseChatSidebarPrefs({
      pinned: ["a", 1, ""],
      archived: ["b"],
      sort: "recent",
      latestOnly: true,
      showArchived: true,
      lastOpened: { a: 12, b: "nope" },
    })).toEqual({
      pinned: ["a"],
      archived: ["b"],
      sort: "recent",
      latestOnly: true,
      showArchived: true,
      lastOpened: { a: 12 },
    });
  });
});

describe("organizeChatSidebarList", () => {
  const rooms = [channel("c-z", "#zeta"), channel("c-a", "#alpha"), channel("c-m", "#mid")];
  const dms = [direct("d-b", "Bea"), direct("d-a", "Ada")];

  test("pins rise, archives hide, DMs stay their own list", () => {
    const organized = organizeChatSidebarList({
      channels: rooms,
      directs: dms,
      prefs: {
        ...EMPTY_CHAT_SIDEBAR_PREFS,
        pinned: ["c-z"],
        archived: ["c-m"],
      },
      query: "",
      addressed: new Set(),
      selectedId: null,
      nowMs: NOW,
    });
    expect(organized.pinned.map((item) => item.id)).toEqual(["c-z"]);
    expect(organized.channels.map((item) => item.id)).toEqual(["c-a"]);
    expect(organized.directs.map((item) => item.id)).toEqual(["d-a", "d-b"]);
    expect(organized.archived).toEqual([]);
  });

  test("search filters titles and latest-only keeps pinned, addressed, selected", () => {
    const organized = organizeChatSidebarList({
      channels: rooms,
      directs: dms,
      prefs: {
        ...EMPTY_CHAT_SIDEBAR_PREFS,
        pinned: ["c-z"],
        latestOnly: true,
        lastOpened: { "c-a": NOW - 1000 },
      },
      query: "alp",
      addressed: new Set(["c-m"]),
      selectedId: "c-a",
      nowMs: NOW,
    });
    expect(organized.pinned.map((item) => item.id)).toEqual([]);
    expect(organized.channels.map((item) => item.id)).toEqual(["c-a"]);
    expect(organized.directs.map((item) => item.id)).toEqual([]);
  });

  test("recent sort uses lastOpened then title", () => {
    const organized = organizeChatSidebarList({
      channels: rooms,
      directs: [],
      prefs: {
        ...EMPTY_CHAT_SIDEBAR_PREFS,
        sort: "recent",
        lastOpened: { "c-m": NOW, "c-a": NOW - 10 },
      },
      query: "",
      addressed: new Set(),
      selectedId: null,
      nowMs: NOW,
    });
    expect(organized.channels.map((item) => item.id)).toEqual(["c-m", "c-a", "c-z"]);
  });
});

describe("isLatestKeep", () => {
  test("with no history, everything stays", () => {
    expect(isLatestKeep({
      id: "c-1",
      pinned: new Set(),
      addressed: new Set(),
      selectedId: null,
      lastOpened: {},
      nowMs: NOW,
      hasAnyLastOpened: false,
    })).toBe(true);
  });
});

describe("toggleId", () => {
  test("adds and removes", () => {
    expect(toggleId(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleId(["a", "b"], "a")).toEqual(["b"]);
  });
});
