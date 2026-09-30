import { compareMessagesAsc } from "../../../shared/message-pagination.ts";
import { useEffect, useRef, useState } from "react";
import { mergeChatMessageRevisions, newestChatMessage } from "./chat-message-revisions.ts";
import { usePoll } from "./use-poll.ts";
import type { ChatApi, ChatMessage } from "./chat-api.ts";

type Context = Awaited<ReturnType<NonNullable<ChatApi["messageContext"]>>>;

export function useChatMessageContext(api: ChatApi, actorId: string | null, space: string, channelId: string | null, messageId: string | null) {
  const key = JSON.stringify([actorId, space, channelId, messageId]);
  const liveKey = useRef(key);
  liveKey.current = key;
  const epoch = useRef(0);
  const pendingPage = useRef<string | null>(null);
  const [pageState, setPageState] = useState<{ key: string; busy: boolean; error?: string }>({ key: "", busy: false });
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ key: string; value?: Context; error?: string }>({ key: "" });
  useEffect(() => {
    if (!actorId || !channelId || !messageId || !api.messageContext) return;
    let current = true;
    const started = ++epoch.current;
    setPageState({ key, busy: false });
    setState({ key });
    void api.messageContext(channelId, messageId, space).then(value => {
      if (current && epoch.current === started) setState(previous => ({ key, value: { ...value, messages: mergeChatMessageRevisions(previous.key === key ? previous.value?.messages ?? [] : [], value.messages) } }));
    }, () => {
      if (current) setState({ key, error: "This discussion could not be loaded. It may be unavailable, or the connection may have failed." });
    });
    return () => { current = false; };
  }, [actorId, api, attempt, channelId, key, messageId, space]);
  const loadEarlier = async () => {
    const current = state.key === key ? state.value : undefined;
    if (!current?.nextCursor || !channelId || !messageId || !api.messageContext || pendingPage.current === key) return;
    const started = epoch.current;
    pendingPage.current = key;
    setPageState({ key, busy: true });
    try {
      const page = await api.messageContext(channelId, messageId, space, current.nextCursor);
      if (liveKey.current !== key || started !== epoch.current) return;
      if (page.rootMessageId !== current.rootMessageId) throw new Error("Thread changed.");
      setState(previous => previous.key === key && previous.value ? { key, value: {
        ...page,
        messages: [...new Map([...previous.value.messages, ...mergeChatMessageRevisions(previous.value.messages, page.messages)].map(message => [message.id, message])).values()].sort(compareMessagesAsc),
      } } : previous);
      setPageState({ key, busy: false });
    } catch {
      if (liveKey.current === key && started === epoch.current) setPageState({ key, busy: false, error: "Earlier replies could not be loaded. Try again." });
    } finally { if (pendingPage.current === key) pendingPage.current = null; }
  };

  const refresh = async () => {
    if (!api.messageContext || !channelId || !messageId || !state.value || state.key !== key) return;
    try {
      const value = await api.messageContext(channelId, messageId, space);
      if (liveKey.current !== key) return;
      setState(previous => {
        if (previous.key !== key || !previous.value) return previous;
        const merged = new Map(previous.value.messages.map(message => [message.id, message]));
        for (const message of mergeChatMessageRevisions(previous.value.messages, value.messages)) merged.set(message.id, message);
        return { ...previous, value: { ...previous.value, messages: [...merged.values()].sort(compareMessagesAsc) } };
      });
    } catch { /* Keep retained context; the feed owns connection status. */ }
  };
  usePoll(refresh, 15_000, Boolean(actorId && channelId && messageId && api.messageContext));

  return {
    replaceMessage: (message: ChatMessage) => {
      setState(previous => previous.key === key && previous.value ? { ...previous, value: {
        ...previous.value, messages: previous.value.messages.map(item => item.id === message.id ? newestChatMessage(item, message) : item),
      } } : previous);
    },
    context: state.key === key ? state.value : undefined,
    error: state.key === key ? state.error : undefined,
    loading: Boolean(api.messageContext && messageId && (state.key !== key || (!state.value && !state.error))),
    loadEarlier,
    loadingEarlier: pageState.key === key && pageState.busy,
    earlierError: pageState.key === key ? pageState.error : undefined,
    retry: () => setAttempt(value => value + 1),
  };
}
