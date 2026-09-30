import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatReadState, ChatAttentionPreferenceChange } from "@openscout/protocol";
import type { ChatApi } from "./chat-api.ts";
import { usePoll } from "./use-poll.ts";

export function useChatReadState({ api, actorId, space, channelIds, enabled, activeChannelId }: {
  api: ChatApi;
  actorId: string | null;
  space: string;
  channelIds: string[];
  enabled: boolean;
  activeChannelId?: string | null;
}) {
  const identity = JSON.stringify([actorId, space]);
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const [snapshot, setSnapshot] = useState<{ identity: string; states: Record<string, ChatReadState>; error: string | null }>({ identity, states: {}, error: null });
  const idsKey = JSON.stringify(channelIds);
  const ids = useMemo(() => JSON.parse(idsKey) as string[], [idsKey]);
  const pending = useRef(new Set<string>());
  const attentionWrite = useRef(false);
  const [attentionBusy, setAttentionBusy] = useState(false);
  const [attentionError, setAttentionError] = useState<{ identity: string; text: string } | null>(null);
  const readGenerations = useRef(new Map<string, number>());

  const refresh = useCallback(async (onlyChannel?: string) => {
    if (!enabled || !actorId || !api.readState) return;
    const updates: Record<string, ChatReadState> = {};
    const updateGenerations: Record<string, { key: string; generation: number }> = {};
    let failed = false;
    const selected = onlyChannel ? [onlyChannel] : ids;
    // Keep room-count growth from producing an unbounded burst of requests.
    for (let start = 0; start < selected.length; start += 4) {
      if (identityRef.current !== identity) return;
      const reads = selected.slice(start, start + 4).map((id) => {
        const key = JSON.stringify([identity, id]);
        const generation = (readGenerations.current.get(key) ?? 0) + 1;
        readGenerations.current.set(key, generation);
        return { id, key, generation };
      });
      const batch = await Promise.allSettled(reads.map(({ id }) => api.readState!(id, space)));
      for (const [index, result] of batch.entries()) {
        const read = reads[index]!;
        if (readGenerations.current.get(read.key) !== read.generation) continue;
        if (result.status === "fulfilled" && result.value.actorId === actorId && result.value.channelId === read.id) {
          updates[read.id] = result.value;
          updateGenerations[read.id] = read;
        }
        else failed = true;
      }
    }
    if (identityRef.current !== identity) return;
    // Earlier batches may have been superseded while later batches waited.
    for (const [id, read] of Object.entries(updateGenerations)) {
      if (readGenerations.current.get(read.key) !== read.generation) delete updates[id];
    }
    setSnapshot((previous) => ({
      identity,
      states: { ...(previous.identity === identity ? previous.states : {}), ...updates },
      error: failed ? "Unread activity could not be refreshed. Showing the last available reading." : null,
    }));
  }, [actorId, api, enabled, identity, ids, space]);

  useEffect(() => { void refresh(); }, [refresh]);
  usePoll(refresh, 60_000, enabled);
  const refreshActive = useCallback(() => activeChannelId ? refresh(activeChannelId) : Promise.resolve(), [activeChannelId, refresh]);
  useEffect(() => { void refreshActive(); }, [refreshActive]);
  usePoll(refreshActive, 15_000, enabled && !!activeChannelId);

  const markRead = useCallback(async (channelId: string, messageId: string, rootMessageId: string | null = null) => {
    if (!enabled || !api.markRead || !actorId) return;
    const key = JSON.stringify([identity, channelId, rootMessageId, messageId]);
    if (pending.current.has(key)) return;
    pending.current.add(key);
    try {
      await api.markRead(channelId, { messageId, rootMessageId, space });
      if (identityRef.current === identity) await refresh(channelId);
    } catch {
      if (identityRef.current === identity) setSnapshot((previous) => ({
        identity, states: previous.identity === identity ? previous.states : {},
        error: "Your read position could not be saved. It will be retried when you return to the conversation.",
      }));
    } finally { pending.current.delete(key); }
  }, [actorId, api, enabled, identity, refresh, space]);

  const updateAttention = useCallback(async (channelId: string, change: ChatAttentionPreferenceChange) => {
    if (!enabled || !actorId || !api.updateAttention || attentionWrite.current) return;
    attentionWrite.current = true;
    setAttentionBusy(true);
    setAttentionError(null);
    try {
      const result = await api.updateAttention(channelId, change, space);
      if (identityRef.current !== identity) return;
      // Invalidate reads started before this mutation so an old response cannot
      // replace the just-saved preference while the fresh read is in flight.
      const key = JSON.stringify([identity, channelId]);
      readGenerations.current.set(key, (readGenerations.current.get(key) ?? 0) + 1);
      setSnapshot(previous => previous.identity === identity && previous.states[channelId]
        ? { ...previous, states: { ...previous.states, [channelId]: { ...previous.states[channelId]!, preferences: result.preferences } } }
        : previous);
      await refresh(channelId);
    } catch {
      if (identityRef.current === identity) setAttentionError({ identity, text: "Your activity preference could not be saved. Try again." });
    } finally { attentionWrite.current = false; setAttentionBusy(false); }
  }, [actorId, api, enabled, identity, refresh, space]);

  const updatePins = useCallback(async (channelId: string, messageId: string, pinned: boolean) => {
    if (!enabled || !actorId || !api.updatePins || attentionWrite.current) return;
    attentionWrite.current = true;
    setAttentionBusy(true);
    setAttentionError(null);
    try {
      const result = await api.updatePins(channelId, { messageId, pinned }, space);
      if (identityRef.current !== identity) return;
      const key = JSON.stringify([identity, channelId]);
      readGenerations.current.set(key, (readGenerations.current.get(key) ?? 0) + 1);
      setSnapshot(previous => previous.identity === identity && previous.states[channelId]
        ? { ...previous, states: { ...previous.states, [channelId]: { ...previous.states[channelId]!, pins: result.pins } } }
        : previous);
      await refresh(channelId);
    } catch {
      if (identityRef.current === identity) setAttentionError({ identity, text: "Channel pins could not be saved. Try again." });
    } finally { attentionWrite.current = false; setAttentionBusy(false); }
  }, [actorId, api, enabled, identity, refresh, space]);

  return {
    states: snapshot.identity === identity && enabled ? snapshot.states : {},
    error: snapshot.identity === identity && enabled ? snapshot.error : null,
    refresh,
    markRead,
    updateAttention,
    updatePins,
    attentionBusy,
    attentionError: attentionError?.identity === identity ? attentionError.text : null,
  };
}
