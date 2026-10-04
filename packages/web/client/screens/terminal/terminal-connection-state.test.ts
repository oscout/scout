import { describe, expect, test } from "bun:test";
import { terminalLoadNotice, terminalRelayNotice, terminalRelayTraceError } from "./terminal-connection-state.ts";

const relay = { status: "error" as const, error: "Relay service is not running", exitCode: null, attempted: true, apiOffline: false };

describe("terminal connection notices", () => {
  test("connecting is a loading state even after an offline observation", () => {
    expect(terminalRelayNotice({ ...relay, status: "connecting", apiOffline: true })?.kind).toBe("loading");
    expect(terminalLoadNotice("loading", "Failed to fetch")?.kind).toBe("loading");
  });
  test("a failed relay health check does not prove that Scout stopped", () => {
    const notice = terminalRelayNotice(relay)!;
    expect(notice.title).toBe("Terminal connection unavailable");
    expect(notice.detail).not.toContain("Workspace Manager");
    expect(notice.detail).not.toContain("not running");
    expect(notice.diagnostics).toBe(relay.error);
    expect(terminalRelayTraceError(relay.error)).toBe("Terminal service health check did not respond");
  });
  test("an unreachable Scout has recovery instructions, not an empty inventory", () => {
    for (const error of ["Failed to fetch", "Load failed", "Scout server is unreachable", "connect ECONNREFUSED"]) {
      const notice = terminalLoadNotice("failed", error)!;
      expect(notice.kind).toBe("error");
      expect(notice.title).toBe("Can’t connect to Scout");
      expect(notice.detail).toContain("host computer");
    }
  });
  test("successful connection removes the notice despite a stale API failure", () => {
    expect(terminalRelayNotice({ ...relay, status: "connected", apiOffline: true })).toBeNull();
    expect(terminalLoadNotice("ready")).toBeNull();
  });
  test("clean process exit differs from a connection or process failure", () => {
    expect(terminalRelayNotice({ ...relay, status: "disconnected", exitCode: 0 })?.title).toBe("Terminal session ended");
    const stopped = terminalRelayNotice({ ...relay, error: "Process failed", exitCode: 2 })!;
    expect(stopped.title).toBe("Terminal process stopped");
    expect(stopped.diagnostics).toContain("Exit code: 2");
  });
  test("server errors retain their diagnostic instead of claiming an outage", () => {
    expect(terminalLoadNotice("failed", "Permission denied")?.title).toBe("Couldn’t load your terminals");
    expect(terminalLoadNotice("failed", "Permission denied")?.diagnostics).toBe("Permission denied");
  });
});
