import type { Message } from "../../lib/types.ts";

export type ReplyWatchState =
  | { status: "idle" | "waiting" | "timed-out"; reply: null }
  | { status: "received"; reply: Message };

const POLL_MS = 2_500;
const GIVE_UP_MS = 5 * 60_000;

/** One bounded outstanding reply. Cancellation also rejects late request results. */
export function watchAgentReply(
  since: number,
  read: (signal: AbortSignal) => Promise<Message[]>,
  publish: (state: ReplyWatchState) => void,
  schedule: (callback: () => void, delay: number) => () => void = (callback, delay) => {
    const timer = setTimeout(callback, delay);
    return () => clearTimeout(timer);
  },
): () => void {
  const controller = new AbortController();
  let stopped = false;
  let cancelPoll = () => {};
  let cancelDeadline = () => {};
  const stop = () => {
    stopped = true;
    controller.abort();
    cancelPoll();
    cancelDeadline();
  };
  const poll = async () => {
    if (stopped) return;
    try {
      const messages = await read(controller.signal);
      if (stopped) return;
      // Both API row orders occur. Include same-millisecond replies after dispatch.
      const next = messages
        .filter((message) => message.class === "agent" && message.createdAt >= since)
        .reduce<Message | null>((first, message) =>
          !first || message.createdAt < first.createdAt ? message : first, null);
      if (next) {
        stop();
        publish({ status: "received", reply: next });
        return;
      }
    } catch {
      // Transient failures retry until the independent deadline expires.
    }
    if (!stopped) cancelPoll = schedule(() => void poll(), POLL_MS);
  };
  publish({ status: "waiting", reply: null });
  // Separate from polling so a stalled request cannot leave the UI listening forever.
  cancelDeadline = schedule(() => {
    if (stopped) return;
    stop();
    publish({ status: "timed-out", reply: null });
  }, GIVE_UP_MS);
  cancelPoll = schedule(() => void poll(), POLL_MS);
  return stop;
}
