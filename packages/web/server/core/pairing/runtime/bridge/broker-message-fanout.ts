import { watchScoutMessages, type ScoutWatchOptions } from "../../../broker/service.ts";

type ListenerOptions = Pick<ScoutWatchOptions, "signal" | "onMessage" | "onLifecycle"> & {
  allConversations: true;
};

/** One broker stream per bridge process, released when the last peer leaves.
 * A watch retains broker lifecycle state, so starting one per socket multiplies
 * that state by the number of connected devices (and abandoned clients).
 */
export function createBrokerMessageFanout(watch = watchScoutMessages) {
  type Listener = { options: ListenerOptions; finish: (error?: unknown) => void };
  const listeners = new Set<Listener>();
  let active: AbortController | null = null;

  const start = () => {
    if (active) return;
    const controller = new AbortController();
    active = controller;
    const dispatch = (deliver: (options: ListenerOptions) => void) => {
      if (active !== controller) return;
      for (const listener of [...listeners]) {
        try { deliver(listener.options); }
        catch (error) { listener.finish(error); }
      }
    };
    const finish = (error?: unknown) => {
      // A new peer may already have opened a replacement stream.
      if (active !== controller) return;
      active = null;
      controller.abort();
      for (const listener of [...listeners]) listener.finish(error);
    };
    void Promise.resolve().then(() => {
      if (controller.signal.aborted) return;
      return watch({
        allConversations: true,
        signal: controller.signal,
        onMessage: (message) => dispatch((options) => options.onMessage(message)),
        onLifecycle: (event) => dispatch((options) => options.onLifecycle?.(event)),
      });
    }).then(() => finish(), finish);
  };

  return (options: ListenerOptions): Promise<void> => {
    if (options.signal?.aborted) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const abort = () => listener.finish();
      const listener: Listener = {
        options,
        finish(error) {
          if (!listeners.delete(listener)) return;
          options.signal?.removeEventListener("abort", abort);
          if (listeners.size === 0) {
            const previous = active;
            active = null;
            previous?.abort();
          }
          if (error !== undefined) reject(error);
          else resolve();
        },
      };
      listeners.add(listener);
      options.signal?.addEventListener("abort", abort, { once: true });
      start();
    });
  };
}

export const watchSharedScoutMessages = createBrokerMessageFanout();
