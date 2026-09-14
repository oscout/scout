import { useEffect, useState } from "react";
import { api } from "./api.ts";
import type { Message } from "./types.ts";

/** One page is plenty for a drawing: the point is the shape, not the archive. */
const AGENT_FLOW_LIMIT = 500;

/**
 * Every message in an agent's neighbourhood — each conversation it is a member
 * of or has spoken in, whole.
 *
 * Scoped to the agent rather than to one conversation, because the thing worth
 * seeing is what an agent is mixed up in: its sub-agents, the agents it hands
 * work to, and the ones handing work to it. A conversation-scoped view can
 * never show that, since the interesting traffic crosses conversations.
 */
export function useAgentFlowMessages(agentId: string | null, enabled: boolean): {
  messages: Message[];
  loading: boolean;
  error: string | null;
} {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Drop the previous agent's page before fetching this one. Holding it
    // would label the new agent's drawing with the old agent's partners for as
    // long as the request takes, and leave them standing for good if it fails.
    setMessages([]);
    if (!enabled || !agentId) {
      setLoading(false);
      setError(null);
      return;
    }
    let live = true;
    setLoading(true);
    setError(null);
    api<Message[]>(`/api/messages?actor=${encodeURIComponent(agentId)}&limit=${AGENT_FLOW_LIMIT}`)
      .then((page) => {
        if (!live) return;
        // The projection pages newest-first; every drawing reads forward.
        setMessages([...page].sort((a, b) => a.createdAt - b.createdAt));
      })
      .catch((cause: unknown) => {
        if (!live) return;
        setMessages([]);
        setError(cause instanceof Error ? cause.message : "Could not load this agent's messages.");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [agentId, enabled]);

  return { messages, loading, error };
}
