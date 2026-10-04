import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  COMPANION_EVENT,
  companionHostAvailable,
  isCompanionId,
  onCompanionState,
  allowCompanionScope,
  beginCompanionDrag,
  disallowCompanionScope,
  isCompanionProjectRoot,
  openFromCompanion,
  parseCompanionHostState,
  setCompanionPreferences,
  pinToCompanion,
  readCompanionState,
  reorderCompanion,
  COMPANION_POINTER_EVENT,
  onCompanionPointer,
  parseCompanionEdgeGeometry,
  reportCompanionHitRegions,
  budgetHitRegions,
  COMPANION_MAX_REGIONS,
} from "./companion-host.ts";

type Posted = { kind: string; id: string; method: string; params: Record<string, unknown> };

const originalWindow = (globalThis as { window?: unknown }).window;
let posted: Posted[] = [];
let reply: (message: Posted) => unknown;

function installHost() {
  const target = new EventTarget() as EventTarget & Record<string, unknown>;
  target.webkit = {
    messageHandlers: {
      scoutCompanion: {
        postMessage(body: Posted) {
          posted.push(body);
          const value = reply(body);
          queueMicrotask(() => {
            const respond = target.__scoutCompanionReply as (id: string, reply: unknown) => void;
            respond(body.id, value instanceof Error ? { ok: false, error: value.message } : { ok: true, value });
          });
        },
      },
    },
  };
  (globalThis as { window?: unknown }).window = target;
  return target;
}

beforeEach(() => {
  posted = [];
  reply = () => ({ pins: [], corner: "bottom-right", minimized: false, visible: true });
});

afterEach(() => {
  (globalThis as { window?: unknown }).window = originalWindow;
});

describe("ids", () => {
  test("accepts broker ids and rejects anything that could carry markup or paths", () => {
    expect(isCompanionId("work-murpazcf-d0g5fr")).toBe(true);
    expect(isCompanionId("node:arts-mini.local")).toBe(true);
    expect(isCompanionId("")).toBe(false);
    expect(isCompanionId("../etc")).toBe(false);
    expect(isCompanionId("<img src=x>")).toBe(false);
    expect(isCompanionId("a".repeat(129))).toBe(false);
    expect(isCompanionId(42)).toBe(false);
  });
});

describe("parseCompanionHostState", () => {
  test("drops malformed and duplicate pins, defaults the corner", () => {
    expect(parseCompanionHostState({
      pins: [{ workId: "work-1", machineId: "node-a" }, { workId: "work-1" }, { workId: "bad id" }, null, { workId: "work-2", machineId: "<x>" }],
      corner: "middle",
      minimized: "yes",
    })).toEqual({
      pins: [{ workId: "work-1", machineId: "node-a" }, { workId: "work-2", machineId: null }],
      corner: "bottom-right",
      minimized: false,
      visible: true,
      restingOpacity: 0.55,
      alwaysOn: false,
      scopes: [],
      mode: "stack",
      originPins: true,
      edgeAnchor: "right",
      edge: null,
    });
  });

  test("clamps opacity and keeps only well-formed, unique grants", () => {
    const state = parseCompanionHostState({
      pins: [],
      restingOpacity: 0.01,
      alwaysOn: true,
      scopes: [
        { kind: "agent", id: "agent-1", label: " Hudson " },
        { kind: "agent", id: "agent-1" },
        { kind: "project", id: "/Users/art/dev/openscout", label: null },
        { kind: "project", id: "relative" },
        { kind: "everything", id: "x" },
        { kind: "work", id: "bad id" },
      ],
    });
    expect(state?.restingOpacity).toBe(0.25);
    expect(state?.alwaysOn).toBe(true);
    expect(state?.scopes).toEqual([
      { kind: "agent", id: "agent-1", label: "Hudson" },
      { kind: "project", id: "/Users/art/dev/openscout", label: null },
    ]);
    expect(parseCompanionHostState({ pins: [], restingOpacity: Number.NaN })?.restingOpacity).toBe(0.55);
  });

  test("project roots are absolute and free of control characters", () => {
    expect(isCompanionProjectRoot("/Users/art/dev/openscout")).toBe(true);
    expect(isCompanionProjectRoot("relative/path")).toBe(false);
    expect(isCompanionProjectRoot("/a\u0000b")).toBe(false);
    expect(isCompanionProjectRoot("/" + "a".repeat(600))).toBe(false);
  });

  test("rejects non-objects and missing pins", () => {
    expect(parseCompanionHostState(null)).toBeNull();
    expect(parseCompanionHostState("{}")).toBeNull();
    expect(parseCompanionHostState({ corner: "top-left" })).toBeNull();
  });

  test("keeps explicit hidden and top corners", () => {
    expect(parseCompanionHostState({ pins: [], corner: "top-left", visible: false })?.visible).toBe(false);
    expect(parseCompanionHostState({ pins: [], corner: "top-left" })?.corner).toBe("top-left");
  });
});

describe("bridge calls", () => {
  test("without the Mac host nothing is offered and calls reject", async () => {
    (globalThis as { window?: unknown }).window = new EventTarget();
    expect(companionHostAvailable()).toBe(false);
    await expect(readCompanionState()).rejects.toThrow("needs the Scout app");
  });

  test("round-trips a request through the reply hook", async () => {
    installHost();
    reply = (message) => ({ pins: [{ workId: String(message.params.workId) }], corner: "top-right", minimized: false, visible: true });
    const state = await pinToCompanion("work-1", "node-a");
    expect(posted[0]).toMatchObject({ kind: "companion-request", method: "pin", params: { workId: "work-1", machineId: "node-a" } });
    expect(state.pins).toEqual([{ workId: "work-1", machineId: null }]);
    expect(state.corner).toBe("top-right");
  });

  test("host errors surface as rejections", async () => {
    installHost();
    reply = () => new Error("That work id is not pinned.");
    await expect(readCompanionState()).rejects.toThrow("not pinned");
  });

  test("an unreadable host state is an error, not an empty companion", async () => {
    installHost();
    reply = () => ({ nope: true });
    await expect(readCompanionState()).rejects.toThrow("unreadable");
  });

  test("invalid ids never reach the host", async () => {
    installHost();
    await expect(pinToCompanion("bad id")).rejects.toThrow();
    await expect(openFromCompanion("work", { workId: "<x>" })).rejects.toThrow();
    await reorderCompanion(["work-1", "bad id"]);
    expect(posted.map((message) => message.method)).toEqual(["reorder"]);
    expect(posted[0]!.params).toEqual({ workIds: ["work-1"] });
  });

  test("open drops invalid optional ids", async () => {
    installHost();
    reply = () => null;
    await openFromCompanion("thread", { workId: "work-1", machineId: "bad id", conversationId: "chn-1" });
    expect(posted[0]!.params).toEqual({ target: "thread", workId: "work-1", conversationId: "chn-1" });
  });

  test("pushed state is parsed before listeners see it", () => {
    const target = installHost();
    const seen: unknown[] = [];
    const stop = onCompanionState((state) => seen.push(state));
    target.dispatchEvent(new CustomEvent(COMPANION_EVENT, { detail: { pins: [{ workId: "work-9" }], corner: "bottom-left" } }));
    target.dispatchEvent(new CustomEvent(COMPANION_EVENT, { detail: "garbage" }));
    stop();
    target.dispatchEvent(new CustomEvent(COMPANION_EVENT, { detail: { pins: [] } }));
    expect(seen).toEqual([{
      pins: [{ workId: "work-9", machineId: null }],
      corner: "bottom-left",
      minimized: false,
      visible: true,
      restingOpacity: 0.55,
      alwaysOn: false,
      scopes: [],
      mode: "stack",
      originPins: true,
      edgeAnchor: "right",
      edge: null,
    }]);
  });

  test("drag names its source; preferences and grants are validated before posting", async () => {
    installHost();
    reply = () => ({ pins: [] });
    beginCompanionDrag("mark");
    await setCompanionPreferences({ restingOpacity: 0.1, preview: true });
    await setCompanionPreferences({ alwaysOn: true });
    await allowCompanionScope("project", "/Users/art/dev/openscout", "openscout");
    await disallowCompanionScope("agent", "agent-1");
    await expect(allowCompanionScope("agent", "bad id")).rejects.toThrow();
    await expect(allowCompanionScope("project", "relative")).rejects.toThrow();
    expect(posted.map((message) => [message.method, message.params])).toEqual([
      ["drag", { source: "mark" }],
      ["preferences", { restingOpacity: 0.25, preview: true }],
      ["preferences", { alwaysOn: true }],
      ["allow", { kind: "project", id: "/Users/art/dev/openscout", label: "openscout" }],
      ["disallow", { kind: "agent", id: "agent-1" }],
    ]);
  });
});

describe("edge mode", () => {
  test("mode defaults to the stack; geometry is read only in edge mode", () => {
    const geometry = { width: 1512, height: 470, anchor: "left", dock: "bottom", obstacles: [{ start: 194, end: 406, label: "Scout · Work" }] };
    expect(parseCompanionHostState({ pins: [], mode: "carousel", edge: geometry })).toMatchObject({ mode: "stack", edge: null, originPins: true });
    expect(parseCompanionHostState({ pins: [], mode: "edge", originPins: false, edgeAnchor: "left", edge: geometry })).toMatchObject({
      mode: "edge",
      originPins: false,
      edgeAnchor: "left",
      edge: geometry,
    });
  });

  test("malformed geometry is dropped or narrowed, never trusted", () => {
    expect(parseCompanionEdgeGeometry({ width: Number.NaN, height: 470 })).toBeNull();
    expect(parseCompanionEdgeGeometry("wide")).toBeNull();
    const narrowed = parseCompanionEdgeGeometry({
      width: 1000,
      height: 470,
      anchor: "middle",
      dock: "top",
      obstacles: [{ start: 50, end: 10 }, { start: 10, end: 5000 }, { start: 100, end: 200, label: 7 }, "x"],
    });
    expect(narrowed).toEqual({ width: 1000, height: 470, anchor: "right", dock: "hidden", obstacles: [{ start: 100, end: 200, label: "Scout window" }] });
  });

  test("hit regions are cleaned and bounded before they reach the host", async () => {
    installHost();
    reply = () => null;
    reportCompanionHitRegions([
      { id: "work-1", x: 10.4, y: 436.2, width: 29.5, height: 34 },
      { id: "bad id", x: 0, y: 0, width: 1, height: 1 },
      { id: "work-2", x: Number.NaN, y: 0, width: 1, height: 1 },
      { id: "work-3", x: 0, y: 0, width: 0, height: 1 },
    ]);
    await Promise.resolve();
    expect(posted.map((message) => [message.method, message.params])).toEqual([
      ["regions", { regions: [{ id: "work-1", x: 10, y: 436, width: 30, height: 34 }] }],
    ]);
    posted = [];
    // A wide screen at capacity: 224 figures, 112 origin pins, +N, home and the popover all fit.
    const full = [
      ...Array.from({ length: 224 }, (_, i) => ({ id: `w-${i}`, x: 0, y: 0, width: 1, height: 1 })),
      ...Array.from({ length: 112 }, (_, i) => ({ id: `pin.${i}`, x: 0, y: 0, width: 1, height: 1 })),
      { id: "stack", x: 0, y: 0, width: 1, height: 1 },
      { id: "home", x: 0, y: 0, width: 1, height: 1 },
      { id: "popover", x: 0, y: 0, width: 1, height: 1 },
    ];
    reportCompanionHitRegions(full);
    expect((posted[0]!.params.regions as unknown[]).length).toBe(full.length);
    expect(COMPANION_MAX_REGIONS).toBeGreaterThanOrEqual(full.length);
  });

  test("over budget, the popover and home survive and keep their stacking order", () => {
    const many = [
      ...Array.from({ length: COMPANION_MAX_REGIONS + 50 }, (_, i) => ({ id: `w-${i}`, x: 0, y: 0, width: 1, height: 1 })),
      { id: "home", x: 0, y: 0, width: 1, height: 1 },
      { id: "popover", x: 0, y: 0, width: 1, height: 1 },
    ];
    const kept = budgetHitRegions(many);
    expect(kept.length).toBe(COMPANION_MAX_REGIONS);
    expect(kept.slice(-2).map((r) => r.id)).toEqual(["home", "popover"]);
    expect(budgetHitRegions(many, 3).map((r) => r.id)).toEqual(["w-0", "home", "popover"]);
    expect(budgetHitRegions([{ id: "popover", x: 0, y: 0, width: 1, height: 1 }], 0)).toEqual([]);
  });

  test("edge preferences post only known values", async () => {
    installHost();
    reply = () => ({ pins: [] });
    await setCompanionPreferences({ mode: "edge", originPins: false, edgeAnchor: "left" });
    await setCompanionPreferences({ mode: "floating" as never, edgeAnchor: "top" as never });
    expect(posted.map((message) => message.params)).toEqual([{ mode: "edge", originPins: false, edgeAnchor: "left" }, {}]);
  });

  test("pointer reports are narrowed before listeners see them", () => {
    const target = installHost();
    const seen: unknown[] = [];
    const stop = onCompanionPointer((event) => seen.push(event));
    target.dispatchEvent(new CustomEvent(COMPANION_POINTER_EVENT, { detail: { id: "work-1", outside: false } }));
    target.dispatchEvent(new CustomEvent(COMPANION_POINTER_EVENT, { detail: { id: "<x>", outside: true } }));
    target.dispatchEvent(new CustomEvent(COMPANION_POINTER_EVENT, { detail: null }));
    stop();
    target.dispatchEvent(new CustomEvent(COMPANION_POINTER_EVENT, { detail: { id: "work-2" } }));
    expect(seen).toEqual([{ id: "work-1", outside: false }, { id: null, outside: true }]);
  });
});

describe("bridge timeout", () => {
  test("an unanswered call rejects, and a late reply is ignored", async () => {
    const target = installHost();
    // The host never answers this call on its own.
    (target.webkit as { messageHandlers: { scoutCompanion: { postMessage: (body: Posted) => void } } })
      .messageHandlers.scoutCompanion.postMessage = (body) => { posted.push(body); };
    const timers: (() => void)[] = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((callback: () => void) => {
      timers.push(callback);
      return 0;
    }) as unknown as typeof setTimeout;
    let call: Promise<unknown>;
    try {
      call = readCompanionState();
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    expect(timers).toHaveLength(1);
    timers[0]!();
    await expect(call).rejects.toThrow("The Scout app did not answer.");
    const respond = target.__scoutCompanionReply as (id: string, reply: unknown) => void;
    expect(() => respond(posted[0]!.id, { ok: true, value: { pins: [] } })).not.toThrow();
    // A later call still round-trips normally.
    installHost();
    await expect(readCompanionState()).resolves.toMatchObject({ pins: [] });
  });
});
