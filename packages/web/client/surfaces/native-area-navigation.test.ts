import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { nativeOpsOwnsInternalRoute, routeEmbeddedNavigation } from "./embed-navigation.ts";
import { PRIMARY_AREAS } from "../scout/primary-areas.ts";
import { installNativeAreaKeyboard } from "./native-area-keyboard.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("embedded area chords route once and relinquish typing, terminal, modal and blur ownership", () => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const listeners = new Map<string, (event: any) => void>();
  let modal = false;
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    addEventListener: (name: string, callback: any) => listeners.set(name, callback),
    removeEventListener: (name: string) => listeners.delete(name),
  } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelector: () => modal ? {} : null } });
  const routes: unknown[] = [];
  const cleanup = installNativeAreaKeyboard((route) => routes.push(route));
  const key = (value: string, target: unknown = null) => {
    let prevented = false;
    listeners.get("keydown")!({ key: value, target, preventDefault() { prevented = true; }, stopPropagation() {} });
    return prevented;
  };
  try {
    expect(key("g")).toBe(true); expect(key("c")).toBe(true);
    expect(routes).toEqual([{ view: "messages" }]);
    for (const target of [{ tagName: "INPUT" }, { closest: (s: string) => s.includes(".xterm") ? {} : null }]) {
      expect(key("g", target)).toBe(false); expect(key("c", target)).toBe(false);
    }
    key("g"); listeners.get("blur")!({}); expect(key("c")).toBe(false);
    key("g"); listeners.get("focusin")!({}); expect(key("c")).toBe(false);
    modal = true; expect(key("g")).toBe(false);
    expect(routes).toHaveLength(1);
  } finally {
    cleanup();
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow); else Reflect.deleteProperty(globalThis, "window");
    if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument); else Reflect.deleteProperty(globalThis, "document");
  }
});

test("native primary navigation follows the web area order", () => {
  const navigation = read("../../../../apps/macos/Sources/Scout/ScoutSidebarNavigation.swift");
  const sections = navigation.match(/static let destinations: \[ScoutSection\] = \[([^\]]+)/)![1]
    .match(/\.\w+/g)!.map((value) => value.slice(1));
  const nativeToWeb: Record<string, string> = {
    home: "home", comms: "chat", agents: "projects", terminals: "sessions",
    dispatch: "dispatch", search: "search", ops: "ops",
  };
  expect(sections.map((section) => nativeToWeb[section]))
    .toEqual(PRIMARY_AREAS.filter((area) => area.id !== "settings").map((area) => area.id));
});

test("new area embeds are registered in both hosts and have native navigation ingress", () => {
  const discovery = read("./discover.ts");
  const registry = read("../../../../apps/macos/Sources/Scout/ScoutEmbedSurface.swift");
  const host = read("../../../../apps/macos/Sources/Scout/ScoutWebEmbedView.swift");
  for (const area of ["home", "search", "ops"]) {
    const screen = read(`../screens/${area}/NativeAreaScreen.tsx`);
    expect(discovery).toContain(`../screens/${area}/NativeAreaScreen.tsx`);
    expect(screen).toContain(`path: "/embed/${area}"`);
    expect(screen).toContain("ownsInternalRoutes: true");
    expect(registry).toContain(`embedPath: "/embed/${area}"`);
    expect(host).toContain(`|| surface == .${area}`);
  }
});

test("Ops internal routing hands native siblings back without dropping World", () => {
  for (const mode of ["tail", "atop", "lanes", "agents"] as const) {
    const calls: string[] = [];
    routeEmbeddedNavigation({ view: "ops", mode }, () => calls.push("web"), () => { calls.push("native"); return true; }, nativeOpsOwnsInternalRoute);
    expect(calls).toEqual(["native"]);
  }
  for (const mode of ["world", "mission", "advisor", "issues"] as const) {
    const calls: string[] = [];
    routeEmbeddedNavigation({ view: "ops", mode }, () => calls.push("web"), () => { calls.push("native"); return true; }, nativeOpsOwnsInternalRoute);
    expect(calls).toEqual(["web"]);
  }
});

test("native primary chords agree with shared web destinations", () => {
  const keyMap = read("../../../../apps/macos/Sources/Scout/ScoutKeyMap.swift");
  for (const [section, chord] of [["home", "h"], ["comms", "c"], ["agents", "p"], ["terminals", "t"], ["dispatch", "d"], ["search", "f"], ["ops", "o"], ["tail", "l"], ["code", "b"]]) {
    expect(keyMap).toContain(`Destination(section: .${section}, chord: "${chord}")`);
  }
  expect(keyMap).not.toContain('Destination(section: .terminals, chord: "s")');
});
