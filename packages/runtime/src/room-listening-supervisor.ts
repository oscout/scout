import type { ChildProcess } from "node:child_process";

/** Owned by scout-base, never by scout-broker. Injectable process/time edges
 * keep supervision tests from touching the live supervisor or service. */
export function createRoomListeningSupervisor(options: {
  spawn: () => ChildProcess;
  terminate: (child: ChildProcess) => Promise<void>;
  warn: (message: string) => void;
  now?: () => number;
  schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}) {
  let child: ChildProcess | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false, delay = 1000;
  const now = options.now ?? Date.now;
  function retry() {
    if (stopped || timer) return;
    timer = (options.schedule ?? setTimeout)(() => { timer = undefined; start(); }, delay);
    timer.unref?.(); delay = Math.min(delay * 2, 30_000);
  }
  function start() {
    if (stopped || child || timer) return;
    try {
      const startedAt = now(), current = options.spawn(); child = current;
      let finished = false;
      const end = () => {
        if (finished) return; finished = true;
        if (child === current) child = undefined;
        if (now() - startedAt >= 30_000) delay = 1000;
        if (!stopped) { options.warn("room listening child stopped; retrying"); retry(); }
      };
      current.once("exit", end); current.once("error", end);
    } catch { options.warn("room listening child could not start; retrying"); retry(); }
  }
  return { start, async stop() {
    stopped = true;
    if (timer) (options.cancel ?? clearTimeout)(timer);
    timer = undefined;
    const current = child; child = undefined;
    if (current) await options.terminate(current);
  } };
}
