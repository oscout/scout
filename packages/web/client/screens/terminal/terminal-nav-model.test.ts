import { describe, expect, test } from "bun:test";
import type { TerminalSessionRecord } from "@openscout/protocol";
import { terminalListItems, type TerminalListItem } from "../../lib/terminal-sessions.ts";
import { groupTerminalNavItems } from "./terminal-nav-model.ts";

function session(
  id: string,
  backend: string,
  sessionName: string,
  options: {
    origin?: "discovered";
    state?: "live" | "detached" | "exited";
    activityAt?: number;
    attachedClients?: number;
    cwd?: string;
    project?: string;
  } = {},
): TerminalSessionRecord {
  return {
    id,
    harness: backend,
    sourceSessionId: sessionName,
    cwd: options.cwd ?? "",
    resumeCommand: `${backend} attach ${sessionName}`,
    surfaces: [{
      backend,
      sessionName,
      paneId: null,
      attachCommand: [backend, "attach", sessionName],
      observeCommand: null,
      relay: { backend, sessionName },
      state: options.state ?? "live",
    }],
    createdAt: 1,
    updatedAt: options.activityAt ?? 1,
    origin: options.origin,
    metadata: {
      ...(options.activityAt !== undefined ? { activityAt: options.activityAt } : {}),
      ...(options.attachedClients !== undefined ? { attachedClients: options.attachedClients } : {}),
      ...(options.project !== undefined ? { project: options.project } : {}),
    },
  };
}

function itemsOf(...sessions: TerminalSessionRecord[]): TerminalListItem[] {
  return terminalListItems(sessions);
}

const NOW = 1_800_000_000_000; // fixed reference instant
const MIN = 60 * 1_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("terminal nav modes", () => {
  test("fleet groups by intentionality in fixed order", () => {
    const items = itemsOf(
      session("s1", "tmux", "session-ms0hf3f7-3ngln1"),
      session("s2", "herdr", "blink"),
      session("s3", "tmux", "scout-tmux-obsidian"),
      session("s4", "tmux", "teamup", { origin: "discovered" }),
    );
    const sections = groupTerminalNavItems(items, "fleet", NOW);

    expect(sections.map((section) => section.key)).toEqual(["herdr", "tmux-named", "tmux-auto", "external"]);
    expect(sections.map((section) => section.items[0]?.surface.sessionName)).toEqual([
      "blink",
      "scout-tmux-obsidian",
      "session-ms0hf3f7-3ngln1",
      "teamup",
    ]);
  });

  test("places groups by project, most recently active project first", () => {
    const items = itemsOf(
      session("s1", "tmux", "one", { project: "openscout", activityAt: NOW - 2 * HOUR }),
      session("s2", "tmux", "two", { project: "hudson", activityAt: NOW - 5 * MIN }),
      session("s3", "tmux", "three", { project: "openscout", activityAt: NOW - 3 * HOUR }),
      session("s4", "tmux", "four", { origin: "discovered" }),
    );
    const sections = groupTerminalNavItems(items, "places", NOW);

    expect(sections.map((section) => section.label)).toEqual(["hudson", "openscout", "backend-only"]);
    expect(sections[1]?.items.map((item) => item.surface.sessionName)).toEqual(["one", "three"]);
  });

  test("places orders equal-activity projects alphabetically", () => {
    const items = itemsOf(
      session("s1", "tmux", "one", { project: "beta", activityAt: NOW - HOUR }),
      session("s2", "tmux", "two", { project: "alpha", activityAt: NOW - HOUR }),
    );
    const sections = groupTerminalNavItems(items, "places", NOW);

    expect(sections.map((section) => section.label)).toEqual(["alpha", "beta"]);
  });

  test("time buckets by last activity age", () => {
    const items = itemsOf(
      session("s1", "tmux", "now", { activityAt: NOW - 2 * MIN }),
      session("s2", "tmux", "today", { activityAt: NOW - 3 * HOUR }),
      session("s3", "tmux", "week", { activityAt: NOW - 2 * DAY }),
      session("s4", "tmux", "older", { activityAt: NOW - 10 * DAY }),
      session("s5", "tmux", "unknown", { origin: "discovered" }),
    );
    const sections = groupTerminalNavItems(items, "time", NOW);

    expect(sections.map((section) => section.key)).toEqual(["now", "today", "week", "older", "unknown"]);
    expect(sections.map((section) => section.items[0]?.surface.sessionName)).toEqual([
      "now",
      "today",
      "week",
      "older",
      "unknown",
    ]);
  });

  test("attention groups by attached, live, detached, exited", () => {
    const items = itemsOf(
      session("s1", "tmux", "exited", { state: "exited" }),
      session("s2", "tmux", "attached", { attachedClients: 2 }),
      session("s3", "tmux", "live"),
      session("s4", "tmux", "detached", { state: "detached" }),
    );
    const sections = groupTerminalNavItems(items, "attention", NOW);

    expect(sections.map((section) => section.key)).toEqual(["attached", "live", "detached", "exited"]);
    expect(sections.map((section) => section.items[0]?.surface.sessionName)).toEqual([
      "attached",
      "live",
      "detached",
      "exited",
    ]);
  });

  test("empty groups are dropped and an empty list yields no sections", () => {
    expect(groupTerminalNavItems([], "fleet", NOW)).toEqual([]);
    expect(groupTerminalNavItems([], "places", NOW)).toEqual([]);
    expect(groupTerminalNavItems([], "time", NOW)).toEqual([]);
    expect(groupTerminalNavItems([], "attention", NOW)).toEqual([]);

    const items = itemsOf(session("s1", "tmux", "solo", { activityAt: NOW - MIN }));
    expect(groupTerminalNavItems(items, "time", NOW).map((section) => section.key)).toEqual(["now"]);
  });
});
