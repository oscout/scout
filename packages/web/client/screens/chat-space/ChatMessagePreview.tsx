import { useContext, useEffect, useRef, useState } from "react";
import { chatMessagePreviewText } from "./chat-message-preview.ts";
import { ChatCorrectionScope } from "./chat-correction-draft.ts";
import { useChatApi } from "./chat-transport.tsx";
import type { ChatMessage } from "./chat-api.ts";


export function ChatMessagePreview(props: { channelId: string; messageId: string; message?: ChatMessage; fallback: string }) {
  const scope = useContext(ChatCorrectionScope);
  return <MessagePreview key={JSON.stringify([scope?.actorId, scope?.space, props.channelId, props.messageId])} {...props} space={scope?.space} />;
}

function MessagePreview({ channelId, messageId, message, fallback, space }: { channelId: string; messageId: string; message?: ChatMessage; fallback: string; space?: string | null }) {
  const api = useChatApi();
  const element = useRef<HTMLSpanElement>(null);
  const [loaded, setLoaded] = useState<ChatMessage | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "unavailable">("idle");
  useEffect(() => {
    if (message || !api.messageContext || !element.current) return;
    let active = true;
    let started = false;
    const load = () => {
      if (started) return;
      started = true; setStatus("loading");
      void api.messageContext!(channelId, messageId, space).then(result => {
        if (!active) return;
        const found = result.messages.find(item => item.id === messageId);
        setLoaded(found ?? null); if (!found) setStatus("unavailable");
      }).catch(() => { if (active) setStatus("unavailable"); });
    };
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); load(); } });
    observer.observe(element.current);
    return () => { active = false; observer.disconnect(); };
  }, [api, channelId, messageId, space, message]);
  const current = message ?? loaded;
  return <span className="chat-message-preview" ref={element}>{current
    ? `${current.actorName || current.actorId} · ${chatMessagePreviewText(current)}`
    : status === "unavailable" ? "Preview unavailable — open message" : status === "loading" ? "Loading message…" : fallback}</span>;
}
