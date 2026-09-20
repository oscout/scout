import { subscribeTerminalSessionInventory } from "./session-terminal-hop.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { TerminalSessionRecord } from "@openscout/protocol";
import { formatTerminalSurfaceId } from "@openscout/protocol";

import { clearApiGetCache } from "./api.ts";
import {
  getTerminalSessionInventory,
  herdrFocusableSurface,
  peekTerminalSessionInventory,
  requestLocalTerminalOpen,
  resolveSessionTerminalTarget,
  terminalHopDeepLink,
  terminalHopRoute,
} from "./session-terminal-hop.ts";

function record(overrides: Partial<TerminalSessionRecord> = {}): TerminalSessionRecord {
  return {
    id: "ts.1",
    harness: "claude",
    sourceSessionId: "",
    cwd: "/workspace/pomo",
    resumeCommand: "",
    origin: "registry",
    createdAt: 0,
    updatedAt: 0,
    surfaces: [{
      backend: "tmux",
      sessionName: "session-abc123",
      paneId: null,
      attachCommand: ["tmux", "attach", "-t", "session-abc123"],
      observeCommand: null,
      relay: { backend: "tmux", sessionName: "session-abc123" },
      state: "live",
    }],
    metadata: {},
    ...overrides,
  };
}

describe("session-terminal-hop", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => clearApiGetCache());
  afterEach(() => {
    clearApiGetCache();
    globalThis.fetch = originalFetch;
  });

  test("resolves a ref to its live surface with an opaque key", () => {
    const sessions = [record()];
    const target = resolveSessionTerminalTarget(sessions, {
      sessionRefs: ["session-abc123"],
    });
    expect(target?.session.id).toBe("ts.1");
    expect(target?.via).toBe("sessionName");
    expect(target?.surfaceKey).toBe(
      formatTerminalSurfaceId({ backend: "tmux", hostSession: "session-abc123" }),
    );
  });

  test("path and .jsonl refs normalize to the transcript leaf", () => {
    const sessions = [record()];
    const target = resolveSessionTerminalTarget(sessions, {
      sessionRefs: ["/Users/art/.claude/projects/x/session-abc123.jsonl"],
    });
    expect(target?.session.id).toBe("ts.1");
  });

  test("returns null when nothing provably matches", () => {
    expect(resolveSessionTerminalTarget([record()], {
      sessionRefs: ["someone-else"],
      agentId: "agent-1",
    })).toBeNull();
    expect(resolveSessionTerminalTarget([record()], {})).toBeNull();
  });

  test("hop route prefers the resolved surface, then the agent fallback", () => {
    const sessions = [record()];
    const target = resolveSessionTerminalTarget(sessions, { sessionRefs: ["session-abc123"] });
    expect(terminalHopRoute(target, "agent-1")).toEqual({
      view: "terminal",
      terminalSessionId: "ts.1",
      terminalSurfaceKey: formatTerminalSurfaceId({ backend: "tmux", hostSession: "session-abc123" }),
      mode: "takeover",
    });
    expect(terminalHopRoute(null, "agent-1")).toEqual({
      view: "terminal",
      agentId: "agent-1",
      mode: "takeover",
    });
    expect(terminalHopRoute(null, null)).toBeNull();
  });

  test("deep link carries the legacy backend:name surface key", () => {
    const target = resolveSessionTerminalTarget([record()], { sessionRefs: ["session-abc123"] })!;
    const link = terminalHopDeepLink(target);
    expect(link).toBe(
      "scout://terminal?session=ts.1&surface=tmux%3Asession-abc123&mode=takeover",
    );
  });

  test("herdr pane surfaces are focusable, session-level ones are not", () => {
    const pane = record({
      surfaces: [{
        backend: "herdr",
        sessionName: "dev",
        paneId: "pane-7",
        attachCommand: ["herdr", "attach", "dev"],
        observeCommand: null,
        relay: { backend: "herdr", sessionName: "dev" },
        state: "live",
      }],
    });
    const target = resolveSessionTerminalTarget([pane], { sessionRefs: ["dev"] })!;
    expect(herdrFocusableSurface(target)).toBe(true);
    expect(herdrFocusableSurface(
      resolveSessionTerminalTarget([record()], { sessionRefs: ["session-abc123"] })!,
    )).toBe(false);
  });

  test("open-local posts the surface handle, never argv", async () => {
    let seen: { url: string; body: string } | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen = { url: String(input), body: String(init?.body ?? "") };
      return new Response(JSON.stringify({ ok: true, app: "Ghostty" }), { status: 200 });
    }) as unknown as typeof fetch;

    const target = resolveSessionTerminalTarget([record()], { sessionRefs: ["session-abc123"] })!;
    const result = await requestLocalTerminalOpen(target);

    expect(result.app).toBe("Ghostty");
    expect(seen!.url).toBe("/api/terminal-sessions/open-local");
    expect(JSON.parse(seen!.body)).toEqual({ surface: target.surfaceKey });
  });

  test("inventory fetch is coalesced and then peekable", async () => {
    let calls = 0;
    let notifications = 0;
    const unsubscribe = subscribeTerminalSessionInventory(() => { notifications++; });
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ sessions: [record()] }), { status: 200 });
    }) as unknown as typeof fetch;

    expect(peekTerminalSessionInventory()).toBeNull();
    const [a, b] = await Promise.all([getTerminalSessionInventory(), getTerminalSessionInventory()]);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(calls).toBe(1);
    expect(notifications).toBe(1);
    unsubscribe();
    expect(peekTerminalSessionInventory()).toHaveLength(1);
  });
});
