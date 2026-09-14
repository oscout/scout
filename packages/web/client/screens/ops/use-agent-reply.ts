import { useEffect, useState } from "react";
import { api } from "../../lib/api.ts";
import type { Message } from "../../lib/types.ts";
import { watchAgentReply, type ReplyWatchState } from "./agent-reply-watch.ts";

/** The first agent reply after dispatch; inactive, cancelled and expired watches stay distinct. */
export function useAgentReplyAfter(
  conversationId: string | null,
  since: number | null,
): ReplyWatchState {
  const [observed, setObserved] = useState<{
    conversationId: string;
    since: number;
    state: ReplyWatchState;
  } | null>(null);

  useEffect(() => {
    if (!conversationId || since === null) return;
    return watchAgentReply(
      since,
      (signal) => api<Message[]>(`/api/messages?conversationId=${encodeURIComponent(conversationId)}&limit=8`, { signal }),
      (state) => setObserved({ conversationId, since, state }),
    );
  }, [conversationId, since]);

  if (!conversationId || since === null) return { status: "idle", reply: null };
  // Never expose the preceding conversation's reply during the effect transition.
  if (observed?.conversationId !== conversationId || observed.since !== since) {
    return { status: "waiting", reply: null };
  }
  return observed.state;
}
