import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRoomListeningSupervisor } from "./room-listening-supervisor.js";

test("base child has bounded backoff, one error/exit retry, and owned shutdown", async () => {
  const children: EventEmitter[] = [], delays: number[] = [];
  let callback: (() => void) | undefined, terminated = 0, cancelled = 0, now = 0;
  const supervisor = createRoomListeningSupervisor({
    spawn: () => { const child = new EventEmitter(); children.push(child); return child as ChildProcess; },
    terminate: async child => { terminated++; child.emit("exit", 0); },
    warn: () => {}, now: () => now,
    schedule: (cb, delay) => { callback = cb; delays.push(delay); return { unref() {} } as any; },
    cancel: () => { cancelled++; callback = undefined; },
  });
  supervisor.start(); supervisor.start(); expect(children).toHaveLength(1);
  children[0]!.emit("error", new Error("fake")); children[0]!.emit("exit", 1);
  expect(delays).toEqual([1000]); callback!();
  children[1]!.emit("exit", 1); expect(delays).toEqual([1000, 2000]); callback!();
  now = 31_000; children[2]!.emit("exit", 1); expect(delays.at(-1)).toBe(1000); callback!();
  await supervisor.stop(); expect(terminated).toBe(1); expect(cancelled).toBe(0);
  supervisor.start(); expect(children).toHaveLength(4);
});
test("shutdown cancels retry and spawn exceptions do not strand service", async () => {
  let cancelled = false, attempts = 0;
  const supervisor = createRoomListeningSupervisor({ spawn: () => { attempts++; throw Error("fake"); },
    terminate: async () => {}, warn: () => {},
    schedule: () => ({ unref() {} }) as any, cancel: () => { cancelled = true; } });
  supervisor.start(); await supervisor.stop(); supervisor.start();
  expect(attempts).toBe(1); expect(cancelled).toBe(true);
});
test("only base owns listener; broker contains no listening registration or timer", () => {
  const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
  expect(read("base-daemon.ts")).toContain('runtimeEntrypoint(config), "listening"');
  expect(read("base-daemon.ts")).toContain("roomListeningSupervisor.stop()");
  expect(read("broker-daemon.ts")).not.toContain("chatListening");
  expect(read("sqlite-store.ts")).not.toContain("recordChatListeningChange");
  expect(read("room-listening-service.ts")).not.toContain("control-plane.sqlite");
  expect(read("room-listening-service.ts")).toContain("createRoomHttpSource");
  expect(read("broker-http-router.ts")).not.toContain("handleChatListeningRoute");
  expect(read("../bin/openscout-runtime.mjs")).toContain('listening: resolve(sourceDir, "room-listening-daemon.ts")');
});
