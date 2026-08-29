import { describe, expect, test } from "bun:test";
import {
  bufferPtyOutput,
  buildTmuxAttachArgs,
  clampObserverDimensions,
  isValidMultiplexerName,
} from "./terminal-relay-session.ts";

describe("terminal relay multiplexer session names", () => {
  test("accepts the full generated name of an existing tmux session", () => {
    const sessionName = "relay-arc-opus-beautification-master-arachs-mac-mini-local-claude";

    expect(sessionName).toHaveLength(65);
    expect(isValidMultiplexerName(sessionName)).toBe(true);
  });

  test("rejects names that are unsafe to pass to a multiplexer", () => {
    expect(isValidMultiplexerName("")).toBe(false);
    expect(isValidMultiplexerName("-starts-with-a-dash")).toBe(false);
    expect(isValidMultiplexerName("contains spaces")).toBe(false);
    expect(isValidMultiplexerName("contains/slashes")).toBe(false);
  });
});

describe("tmux relay attach arguments", () => {
  test("makes observe clients read-only and excludes them from size arbitration", () => {
    expect(buildTmuxAttachArgs("relay-agent-1-claude", "observe"))
      .toEqual(["-u", "attach", "-r", "-t", "relay-agent-1-claude"]);
  });

  test("keeps takeover clients writable", () => {
    expect(buildTmuxAttachArgs("relay-agent-1-claude", "takeover"))
      .toEqual(["-u", "attach", "-t", "relay-agent-1-claude"]);
  });
});

describe("tmux observer viewport", () => {
  test("uses the requested grid when it fits inside the tmux window", () => {
    expect(clampObserverDimensions(
      { cols: 120, rows: 40 },
      { cols: 164, rows: 82 },
    )).toEqual({ cols: 120, rows: 40 });
  });

  test("caps a larger observer to the authoritative tmux grid", () => {
    expect(clampObserverDimensions(
      { cols: 183, rows: 90 },
      { cols: 164, rows: 82 },
    )).toEqual({ cols: 164, rows: 82 });
  });
});

describe("tmux relay initial output", () => {
  test("preserves output emitted before the session handler is ready", () => {
    let emit: ((data: string) => void) | null = null;
    const attachOutput = bufferPtyOutput({
      onData(handler) {
        emit = handler;
        return { dispose() {} };
      },
    });
    const received: string[] = [];

    emit?.("initial frame");
    attachOutput((data) => received.push(data));
    emit?.("live update");

    expect(received).toEqual(["initial frame", "live update"]);
  });
});
