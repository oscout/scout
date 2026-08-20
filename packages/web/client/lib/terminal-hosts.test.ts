import { describe, expect, test } from "bun:test";

import { terminalStartOptions, type TerminalHostDescriptor } from "./terminal-host-capabilities.ts";

function host(
  id: string,
  overrides: { installed?: boolean; create?: boolean; relayAttach?: boolean } = {},
): TerminalHostDescriptor {
  return {
    id,
    label: id,
    description: `${id} sessions`,
    capabilities: {
      attach: true,
      relayAttach: overrides.relayAttach ?? true,
      observe: true,
      sendInput: true,
      capture: true,
      create: overrides.create ?? true,
      list: true,
      observedAgentState: false,
      control: [],
      harnessControl: [],
    },
    availability: { installed: overrides.installed ?? true },
  };
}

describe("terminalStartOptions", () => {
  test("offers a shell plus every installed host that can create a session", () => {
    expect(terminalStartOptions([host("tmux"), host("zellij"), host("herdr", { relayAttach: false })])
      .map((option) => option.value)).toEqual(["pty", "tmux", "zellij", "herdr"]);
  });

  test("puts hosts the browser can render before hosts it cannot", () => {
    expect(terminalStartOptions([host("herdr", { relayAttach: false }), host("zellij"), host("tmux")])
      .map((option) => option.value)).toEqual(["pty", "tmux", "zellij", "herdr"]);
  });

  test("never offers a host that is not installed here", () => {
    expect(terminalStartOptions([host("tmux"), host("zellij", { installed: false })])
      .map((option) => option.value)).toEqual(["pty", "tmux"]);
  });

  test("never offers a host that cannot create a session", () => {
    expect(terminalStartOptions([host("tmux"), host("readonly-host", { create: false })])
      .map((option) => option.value)).toEqual(["pty", "tmux"]);
  });

  test("a shell is always available even with no hosts at all", () => {
    expect(terminalStartOptions([])).toEqual([
      { value: "pty", label: "Shell", detail: "Disposable local shell", relayAttach: true },
    ]);
  });

  test("flags a host Scout can start but the browser cannot render", () => {
    const herdr = terminalStartOptions([host("herdr", { relayAttach: false })])
      .find((option) => option.value === "herdr");
    expect(herdr?.relayAttach).toBe(false);
  });
});
