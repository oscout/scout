import { describe, expect, test } from "bun:test";
import type { TerminalSessionRecord } from "@openscout/protocol";
import { terminalListItems, type TerminalListItem } from "../../lib/terminal-sessions.ts";
import { groupTerminalNavItems, normalizeTerminalNavMode } from "./terminal-nav-model.ts";
import { summarizeHerdrTopology, terminalNavHandle, terminalNavRow } from "./terminal-nav-row.ts";

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

const labels = (sections: ReturnType<typeof groupTerminalNavItems>) => sections.map((section) => section.label);
const names = (items: TerminalListItem[]) => items.map((item) => item.surface.sessionName);

describe("terminal index: projects", () => {
  test("groups by project, most recent first, catch-alls and Home sink", () => {
    const items = itemsOf(
      session("a", "tmux", "a", { cwd: "/Users/art/dev/openscout", activityAt: NOW - 3 * HOUR }),
      session("b", "tmux", "b", { cwd: "/Users/art/dev/lp", activityAt: NOW - 5 * MIN }),
      session("c", "tmux", "c", { cwd: "/Users/art", activityAt: NOW - MIN }),
      session("d", "tmux", "d", { cwd: "/Users/art/dev/openscout", activityAt: NOW - 10 * MIN }),
    );
    const sections = groupTerminalNavItems(items, "projects", { now: NOW });
    expect(labels(sections)).toEqual(["lp", "openscout", "Home"]);
    expect(names(sections[1]!.items)).toEqual(["d", "a"]);
  });

  test("a working terminal lifts its project and leads within it", () => {
    const items = itemsOf(
      session("a", "tmux", "a", { cwd: "/Users/art/dev/openscout", activityAt: NOW - 3 * HOUR }),
      session("d", "tmux", "d", { cwd: "/Users/art/dev/openscout", activityAt: NOW - 2 * HOUR }),
      session("b", "tmux", "b", { cwd: "/Users/art/dev/lp", activityAt: NOW - MIN }),
    );
    const sections = groupTerminalNavItems(items, "projects", {
      now: NOW,
      isWorking: (item) => item.surface.sessionName === "a",
    });
    expect(labels(sections)).toEqual(["openscout", "lp"]);
    expect(sections[0]!.working).toBe(true);
    expect(names(sections[0]!.items)).toEqual(["a", "d"]);
  });

  test("stopped herdr sessions fold into their section; projectOf places live herdr", () => {
    const items = itemsOf(
      session("h1", "herdr", "scout", { activityAt: NOW - MIN }),
      session("h2", "herdr", "old-layout", { state: "detached", cwd: "/Users/art/dev/openscout" }),
      session("t1", "tmux", "t1", { cwd: "/Users/art/dev/openscout", activityAt: NOW - HOUR }),
    );
    const sections = groupTerminalNavItems(items, "projects", {
      now: NOW,
      projectOf: (item) => (item.surface.sessionName === "scout" ? "openscout" : null),
    });
    expect(labels(sections)).toEqual(["openscout"]);
    expect(names(sections[0]!.items)).toEqual(["scout", "t1"]);
    expect(names(sections[0]!.stopped)).toEqual(["old-layout"]);
  });
});

describe("terminal index: recent", () => {
  test("buckets by last activity with working on top and stopped at the foot", () => {
    const items = itemsOf(
      session("w", "tmux", "w", { activityAt: NOW - 2 * DAY }),
      session("h", "tmux", "h", { activityAt: NOW - 10 * MIN }),
      session("o", "tmux", "o", { activityAt: NOW - 30 * DAY }),
      session("u", "tmux", "u"),
      session("s", "herdr", "s", { state: "detached" }),
    );
    // `u` has updatedAt 1, so it reads as old rather than unknown.
    const sections = groupTerminalNavItems(items, "recent", {
      now: NOW,
      isWorking: (item) => item.surface.sessionName === "w",
    });
    expect(labels(sections)).toEqual(["Working now", "Last hour", "Older", "Stopped"]);
    expect(names(sections[2]!.items).sort()).toEqual(["o", "u"]);
    expect(names(sections[3]!.stopped)).toEqual(["s"]);
    expect(sections[3]!.items).toEqual([]);
  });

  test("old persisted modes map onto the two cuts", () => {
    expect(normalizeTerminalNavMode("fleet")).toBe("projects");
    expect(normalizeTerminalNavMode("places")).toBe("projects");
    expect(normalizeTerminalNavMode("time")).toBe("recent");
    expect(normalizeTerminalNavMode("attention")).toBe("recent");
    expect(normalizeTerminalNavMode(undefined)).toBe("projects");
  });
});

describe("terminal index rows", () => {
  test("handles shorten generated names only", () => {
    expect(terminalNavHandle("session-mulg1xl0-bvteeb")).toBe("mulg1xl0");
    expect(terminalNavHandle("lp")).toBe("lp");
  });

  test("a tmux row marks its harness and skips Claude's version as a command", () => {
    const [item] = itemsOf({
      ...session("c", "tmux", "session-mulg1xl0-bvteeb"),
      harness: "claude-code",
      metadata: { currentCommand: "2.1.280" },
    });
    const row = terminalNavRow(item!, null, null);
    expect(row.mark).toEqual({ kind: "harness", harness: "claude" });
    expect(row.title).toBe("mulg1xl0");
    expect(row.handle).toBe("claude");
    expect(row.working).toBe(false);
  });

  test("a plain shell row shows its foreground command", () => {
    const [item] = itemsOf({
      ...session("z", "tmux", "logs"),
      harness: "zsh",
      metadata: { currentCommand: "tail -f broker.log" },
    });
    const row = terminalNavRow(item!, null, null);
    expect(row.mark).toEqual({ kind: "shell" });
    expect(row.title).toBe("tail -f broker.log");
  });

  test("herdr topology groups panes by harness and names the common folder", () => {
    const pane = (agent: string | null, agentStatus: string, cwd: string) => ({ agent, agentStatus, cwd, foregroundCwd: null });
    const summary = summarizeHerdrTopology({
      running: true,
      workspaces: [{
        tabs: [{
          panes: [
            pane("claude", "working", "/Users/art/dev/openscout"),
            pane("claude", "idle", "/Users/art/dev/openscout"),
            pane("codex", "idle", "/Users/art/dev/openscout/"),
            pane(null, "idle", "/Users/art"),
          ],
        }],
      }],
    } as never);
    expect(summary).toEqual({
      panes: [
        { harness: "claude", count: 2, working: 1 },
        { harness: "codex", count: 1, working: 0 },
      ],
      paneCount: 4,
      working: 1,
      project: "openscout",
    });
    const [item] = itemsOf(session("h", "herdr", "scout"));
    const row = terminalNavRow(item!, null, summary);
    expect(row.mark).toEqual({ kind: "herdr" });
    expect(row.working).toBe(true);
    expect(row.title).toBe("scout");
  });
});

describe("terminal index row titles", () => {
  test("an owner named after its session falls back to the handle", () => {
    const [item] = itemsOf({ ...session("c", "tmux", "session-mulg1xl0-bvteeb"), harness: "claude" });
    const owner = { name: "Session Mulg1xl0 Bvteeb", harness: "claude", state: "idle", brokerActivity: [] } as never;
    expect(terminalNavRow(item!, owner, null).title).toBe("mulg1xl0");
  });
});
