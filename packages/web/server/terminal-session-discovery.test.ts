import { describe, expect, test } from "bun:test";

import { formatTerminalSurfaceId, parseTerminalSurfaceId } from "@openscout/protocol";
import type { TerminalSessionRecord } from "@openscout/protocol";

import {
  isDiscoverableTerminalBackend,
  parseTmuxSessionList,
  queryDiscoveredTerminalSessions,
  parseZellijSessionList,
  reconcileTerminalSessionInventory,
  terminalSurfaceKey,
} from "./terminal-session-discovery.ts";

describe("terminal session discovery", () => {
  test("parses tmux session inventory", () => {
    expect(parseTmuxSessionList("relay-claude|1|0|claude|/Users/art/dev/openscout\nlattices-c36f74\t2\t1\tzsh\t/Users/art\n")).toEqual([
      { name: "relay-claude", windows: 1, attached: 0, currentCommand: "claude", currentPath: "/Users/art/dev/openscout" },
      { name: "lattices-c36f74", windows: 2, attached: 1, currentCommand: "zsh", currentPath: "/Users/art" },
    ]);
  });


  test("keeps delimiters inside tmux current paths", () => {
    expect(parseTmuxSessionList("dev|2|1|zsh|/Users/art/dev/foo|bar\n")).toEqual([
      { name: "dev", windows: 2, attached: 1, currentCommand: "zsh", currentPath: "/Users/art/dev/foo|bar" },
    ]);
  });

  test("parses colorized zellij session inventory", () => {
    expect(parseZellijSessionList(
      "\x1B[32;1mscout-zj-final-7e55c009\x1B[m [Created \x1B[35;1m13h\x1B[m ago] (\x1B[31;1mEXITED\x1B[m - attach to resurrect)\n",
    )).toEqual([{
      name: "scout-zj-final-7e55c009",
      state: "exited",
      raw: "scout-zj-final-7e55c009 [Created 13h ago] (EXITED - attach to resurrect)",
    }]);
  });

  test("keys backend surfaces through the one surface-id constructor", () => {
    const key = terminalSurfaceKey("tmux", "relay-claude");
    expect(key).toBe(formatTerminalSurfaceId({ backend: "tmux", hostSession: "relay-claude" }));
    expect(parseTerminalSurfaceId(key)).toEqual({
      backend: "tmux",
      hostSession: "relay-claude",
      paneId: null,
      nodeId: null,
    });
  });
});

describe("discovered records", () => {
  test("stop stuffing the backend into harness and the attach argv into resumeCommand", async () => {
    // No host reachable: discovery must degrade to an empty inventory, not throw.
    const sessions = await queryDiscoveredTerminalSessions({
      env: { ...process.env, PATH: "/nonexistent-scout-probe" },
    });
    expect(Array.isArray(sessions)).toBe(true);
    for (const session of sessions) {
      expect(session.origin).toBe("discovered");
      expect(session.harness).toBe("");
      expect(session.resumeCommand).toBe("");
    }
  });

  test("rejects an unregistered backend filter by discovering nothing", async () => {
    expect(await queryDiscoveredTerminalSessions({ backend: "not-a-host" })).toEqual([]);
  });

  test("knows which backends are discoverable from the registry, not a literal", () => {
    expect(isDiscoverableTerminalBackend("tmux")).toBe(true);
    expect(isDiscoverableTerminalBackend("zellij")).toBe(true);
    expect(isDiscoverableTerminalBackend("herdr")).toBe(true);
    expect(isDiscoverableTerminalBackend("screen")).toBe(false);
    expect(isDiscoverableTerminalBackend(null)).toBe(false);
  });
});

describe("terminal inventory reconciliation", () => {
  test("enriches a registered surface with live host activity without duplicating it", () => {
    const registered = terminalSession("registered", "shared", 1, { owner: "scout" });
    const discovered = terminalSession("discovered", "shared", 2, {
      source: "backend-discovery",
      activityAt: 9_000,
    });
    const other = terminalSession("other", "other", 3, { activityAt: 8_000 });

    expect(reconcileTerminalSessionInventory([registered], [discovered, other], 10)).toEqual([
      {
        ...registered,
        metadata: { owner: "scout", activityAt: 9_000 },
      },
      other,
    ]);
  });

  test("keeps the newest known activity and honors the result limit", () => {
    const registered = terminalSession("registered", "shared", 1, { activityAt: 12_000 });
    const discovered = terminalSession("discovered", "shared", 2, { activityAt: 9_000 });
    const other = terminalSession("other", "other", 3, { activityAt: 8_000 });

    expect(reconcileTerminalSessionInventory([registered], [discovered, other], 1)).toEqual([registered]);
  });
});

function terminalSession(
  id: string,
  sessionName: string,
  updatedAt: number,
  metadata: Record<string, unknown>,
): TerminalSessionRecord {
  return {
    id,
    harness: id === "discovered" ? "" : "claude",
    sourceSessionId: sessionName,
    cwd: "/repo",
    resumeCommand: id === "discovered" ? "" : `claude --resume ${sessionName}`,
    surfaces: [{
      backend: "tmux",
      sessionName,
      paneId: null,
      attachCommand: ["tmux", "attach", "-t", sessionName],
      observeCommand: null,
      relay: { backend: "tmux", sessionName, tmuxSession: sessionName },
      state: "live",
    }],
    createdAt: updatedAt,
    updatedAt,
    metadata,
  };
}
