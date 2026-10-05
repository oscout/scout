import { afterEach, expect, mock, spyOn, test } from "bun:test";
import type { Route } from "../../lib/types.ts";
// @ts-expect-error Runtime path avoids the repository's React type-only alias.
const React = await import("../../../node_modules/react/index.js");
// @ts-expect-error Runtime path avoids the repository's React type-only alias.
const ReactDOM = await import("../../../node_modules/react-dom/client.js");
mock.module("react", () => React);
const { useFollowTailQuery } = await import("./follow-tail-query.ts");
const { clearApiGetCache } = await import("../../lib/api.ts");

const originals = new Map<string, PropertyDescriptor | undefined>();
function globalValue(key: string, value: unknown) {
  if (!originals.has(key)) originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
let root: ReturnType<typeof ReactDOM.createRoot> | undefined;
let value: ReturnType<typeof useFollowTailQuery>;
let tick: () => void;
let intervalSpy: ReturnType<typeof spyOn> | undefined;
let clearSpy: ReturnType<typeof spyOn> | undefined;
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

async function mount(fetcher: typeof fetch) {
  // Null-rendering hook probe, with a minimal in-memory React DOM host.
  const win = Object.assign(new EventTarget(), { HTMLIFrameElement: class {} });
  const doc = Object.assign(new EventTarget(), { nodeType: 9, defaultView: win, activeElement: null, documentElement: { namespaceURI: "http://www.w3.org/1999/xhtml" } });
  const container = Object.assign(new EventTarget(), { nodeType: 1, tagName: "DIV", nodeName: "DIV", namespaceURI: "http://www.w3.org/1999/xhtml", ownerDocument: doc, textContent: "" });
  globalValue("window", win); globalValue("document", doc); globalValue("IS_REACT_ACT_ENVIRONMENT", true);
  globalValue("fetch", fetcher);
  intervalSpy = spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void) => {
    tick = callback;
    return 123;
  }) as typeof setInterval);
  clearSpy = spyOn(globalThis, "clearInterval").mockImplementation(() => {});
  root = ReactDOM.createRoot(container as unknown as Element);
}
function Probe({ route, query }: { route: Route; query?: string }) {
  value = useFollowTailQuery(route, query);
  return null;
}
async function render(route: Route, query?: string) {
  await React.act(async () => { root!.render(React.createElement(Probe, { route, query })); await flush(); });
}
async function poll() { await React.act(async () => { tick(); await flush(); }); }

afterEach(async () => {
  if (root) { await React.act(async () => root!.unmount()); root = undefined; }
  intervalSpy?.mockRestore(); clearSpy?.mockRestore();
  clearApiGetCache();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  originals.clear();
});

test("queued tasks resolve later, recover from a read failure, and follow a retry's new session", async () => {
  const responses: Array<string | null | Error> = [null, new Error("temporarily unavailable"), "native-1", "native-2"];
  const paths: string[] = [];
  await mount((async (path) => {
    paths.push(String(path));
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return Response.json({ harnessSessionId: next });
  }) as typeof fetch);
  await render({ view: "ops", mode: "tail", workId: "work-1" });
  expect(value).toEqual({ query: "work-1", sessionId: undefined });
  await poll();
  expect(value.query).toBe("work-1");
  await poll();
  expect(value).toEqual({ query: "native-1", sessionId: "native-1" });
  await poll();
  expect(value).toEqual({ query: "native-2", sessionId: "native-2" });
  expect(paths).toEqual(Array(4).fill("/api/follow?workId=work-1"));
  await React.act(async () => root!.unmount()); root = undefined;
  expect(clearSpy).toHaveBeenCalledWith(123);
});

test("navigation discards a late old-task resolution and plain Tail keeps its text filter", async () => {
  let finishOld!: (response: Response) => void;
  let requests = 0;
  await mount((async (_input: RequestInfo | URL) => {
    requests++;
    return requests === 1 ? new Promise<Response>((resolve) => { finishOld = resolve; }) : Response.json({ harnessSessionId: "new-native" });
  }) as typeof fetch);
  await render({ view: "ops", mode: "tail", flightId: "old-flight" }, "old-filter");
  await poll();
  expect(requests).toBe(1); // Polls do not overlap an in-flight lookup.
  await render({ view: "ops", mode: "tail", flightId: "new-flight" }, "new-filter");
  expect(value.sessionId).toBe("new-native");
  await React.act(async () => { finishOld(Response.json({ harnessSessionId: "old-native" })); await flush(); });
  expect(value.sessionId).toBe("new-native");
  await render({ view: "ops", mode: "tail" }, "warning|error");
  expect(value).toEqual({ query: "warning|error", sessionId: undefined });
  expect(requests).toBe(2);
});
