import { describe, expect, test } from "bun:test";

import {
  buildTmuxAttachCommand,
  isDebugTransportAttachable,
} from "./debug-attach";

describe("debug attach protocol helpers", () => {
  test("only ready attachable debug transports are attachable", () => {
    expect(isDebugTransportAttachable({ state: "ready", attachable: true })).toBe(true);
    expect(isDebugTransportAttachable({ state: "starting", attachable: true })).toBe(false);
    expect(isDebugTransportAttachable({ state: "ready", attachable: false })).toBe(false);
    expect(isDebugTransportAttachable(undefined)).toBe(false);
  });

  test("builds tmux attach as argv instead of shell text", () => {
    expect(buildTmuxAttachCommand("openscout-agent")).toEqual([
      "tmux",
      "attach-session",
      "-t",
      "openscout-agent",
    ]);
  });
});
