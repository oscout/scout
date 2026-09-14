import { describe, expect, test } from "bun:test";

import { buildNodeMenuActions, type NodeMenuContext } from "./node-actions.ts";

function context(overrides: Partial<NodeMenuContext> = {}): NodeMenuContext {
  const calls: string[] = [];
  const on = {
    select: (id: string) => calls.push(`select:${id}`),
    refresh: (id: string) => calls.push(`refresh:${id}`),
    focus: (id: string) => calls.push(`focus:${id}`),
    toggleHidden: (id: string) => calls.push(`toggleHidden:${id}`),
    showAll: () => calls.push("showAll"),
    clearPosition: (id: string) => calls.push(`clearPosition:${id}`),
    copy: (text: string) => calls.push(`copy:${text}`),
  };
  return {
    machineId: "arc-server-openscout",
    machineLabel: "arc-server",
    nodeId: "arc-server-openscout",
    brokerUrl: "http://arc-server:43110",
    hidden: false,
    anyHidden: false,
    positioned: false,
    canCopy: true,
    checking: false,
    on,
    // Test-only handle on what the actions actually did.
    ...({ calls } as unknown as Partial<NodeMenuContext>),
    ...overrides,
  } as NodeMenuContext & { calls: string[] };
}

function calls(ctx: NodeMenuContext): string[] {
  return (ctx as unknown as { calls: string[] }).calls;
}

describe("buildNodeMenuActions", () => {
  test("every machine can be opened and refreshed", () => {
    const ids = buildNodeMenuActions(context()).map((action) => action.id);
    expect(ids).toContain("open");
    expect(ids).toContain("refresh");
  });

  test("a tailnet device with no broker still gets a working refresh", () => {
    // arc-server and a bare tailnet row must both be actionable; the check is
    // what tells the operator whether anything is there.
    const ctx = context({ machineId: "tailnet:p-ipad", machineLabel: "ipad", nodeId: null, brokerUrl: null });
    const actions = buildNodeMenuActions(ctx);

    expect(actions.map((action) => action.id)).toContain("refresh");
    actions.find((action) => action.id === "refresh")?.run();
    expect(calls(ctx)).toEqual(["refresh:tailnet:p-ipad"]);
  });

  test("offers no action that would do nothing", () => {
    const bare = buildNodeMenuActions(context({
      nodeId: null,
      brokerUrl: null,
      anyHidden: false,
      positioned: false,
    })).map((action) => action.id);

    expect(bare).not.toContain("copy-node-id");
    expect(bare).not.toContain("copy-broker-url");
    expect(bare).not.toContain("show-all");
    expect(bare).not.toContain("clear-position");
  });

  test("omits copying entirely where there is no clipboard", () => {
    const ids = buildNodeMenuActions(context({ canCopy: false })).map((action) => action.id);
    expect(ids.filter((id) => id.startsWith("copy-"))).toEqual([]);
  });

  test("offers to clear a position only once one has been set", () => {
    expect(buildNodeMenuActions(context({ positioned: true })).map((a) => a.id))
      .toContain("clear-position");
  });

  test("names the visibility action after the state it will produce", () => {
    expect(buildNodeMenuActions(context()).find((a) => a.id === "visibility")?.label)
      .toBe("Hide this machine");
    expect(buildNodeMenuActions(context({ hidden: true })).find((a) => a.id === "visibility")?.label)
      .toBe("Show this machine");
  });

  test("says a check is already running rather than pretending to start another", () => {
    const refresh = buildNodeMenuActions(context({ checking: true })).find((a) => a.id === "refresh");
    expect(refresh?.label).toBe("Checking…");
    expect(refresh?.disabled).toBe(true);
  });

  test("each action runs the one thing it names", () => {
    const ctx = context({ anyHidden: true, positioned: true });
    for (const action of buildNodeMenuActions(ctx)) action.run();

    expect(calls(ctx)).toEqual([
      "select:arc-server-openscout",
      "refresh:arc-server-openscout",
      "focus:arc-server-openscout",
      "toggleHidden:arc-server-openscout",
      "showAll",
      "clearPosition:arc-server-openscout",
      "copy:arc-server-openscout",
      "copy:http://arc-server:43110",
    ]);
  });
});
