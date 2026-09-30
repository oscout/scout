import { Bell } from "lucide-react";
import { ChatMessagePreview } from "./ChatMessagePreview.tsx";
import { useState } from "react";
import { readChatAttentionPreferences, type ChatAttentionPreferences, type ChatReadState, type ConversationDefinition } from "@openscout/protocol";
import type { ChatMessage } from "./chat-api.ts";

import { attentionMessageCount } from "./chat-attention-model.ts";

export function ChatAttention({ channels, channelId, states, messages, questionCounts, actorNames = {}, busy, error, onMode, onOpen, onUnfollow, onUnsave, onOpenSaved, onUnpin, open: controlledOpen, onOpenChange }: {
  channels: ConversationDefinition[];
  channelId: string;
  states: Record<string, ChatReadState>;
  messages: ChatMessage[];
  questionCounts?: Record<string, number>;
  actorNames?: Record<string, string>;
  busy: boolean;
  error: string | null;
  onUnpin?: (messageId: string) => void;
  onUnsave: (channelId: string, messageId: string) => void;
  onOpenSaved: (channelId: string, messageId: string) => void;
  onMode: (mode: ChatAttentionPreferences["notificationMode"]) => void;
  onOpen: (channelId: string, rootId?: string) => void;
  onUnfollow: (channelId: string, rootId: string) => void;
  /** Controlled by the channel header, which keeps one tray open at a time. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = (next: boolean | ((value: boolean) => boolean)) => {
    const value = typeof next === "function" ? next(open) : next;
    if (onOpenChange) onOpenChange(value); else setLocalOpen(value);
  };
  const selected = states[channelId];
  const preferences = readChatAttentionPreferences(selected?.preferences);
  const active = channels.filter(channel => states[channel.id] && attentionMessageCount(states[channel.id]!) > 0);
  const followed = channels.flatMap(channel => readChatAttentionPreferences(states[channel.id]?.preferences).followedThreadIds.map(rootId => ({ channel, rootId })));
  const saved = channels.flatMap(channel => (readChatAttentionPreferences(states[channel.id]?.preferences).savedMessageIds ?? []).map(messageId => ({ channel, messageId })));
  const missing = channels.some(channel => !states[channel.id]);
  const incomplete = channels.some(channel => states[channel.id]?.lanes.some(lane => lane.incomplete));
  const total = active.reduce((sum, channel) => sum + attentionMessageCount(states[channel.id]!), 0);
  return <section className="chat-attention" aria-label="Conversation activity">
    <button type="button" className="chat-head-tool" aria-expanded={open} aria-controls="chat-attention-content"
      aria-label={`Activity and notifications${total ? `, ${total} new` : ""}`} title="Activity and notifications" onClick={() => setOpen(value => !value)}>
      <Bell size={16} strokeWidth={1.8} aria-hidden />
      {total ? <span className="chat-head-tool-count">{total}</span> : null}
    </button>
    {open ? <div id="chat-attention-content" className="chat-attention-content">
      <label className="chat-attention-setting">Activity notifications for this channel
        <select aria-label="Activity notifications for this channel" value={preferences.notificationMode} disabled={busy || !selected} onChange={event => onMode(event.target.value as ChatAttentionPreferences["notificationMode"])}>
          <option value="all">All messages</option>
          <option value="mentions">Mentions and followed replies</option>
          <option value="muted">Muted</option>
        </select>
      </label>
      <p className="chat-attention-hint">Controls this activity view. Channel unread counts stay visible. No desktop notifications are sent.</p>
      {error ? <p role="alert" className="chat-feed-notice">{error}</p> : null}
      {questionCounts ? <>
        <h3>Questions for you</h3>
        <p className="chat-attention-hint">Assigned questions stay visible regardless of message notification preferences.</p>
        {channels.some(channel => (questionCounts[channel.id] ?? 0) > 0) ? channels.filter(channel => (questionCounts[channel.id] ?? 0) > 0).map(channel => <button type="button" className="chat-attention-row" key={`question-${channel.id}`} onClick={() => { setOpen(false); onOpen(channel.id); }}>
          <span>#{channel.title.replace(/^#/, "")}</span><span>{questionCounts[channel.id]} awaiting your response</span>
        </button>) : <p>No questions awaiting your response.</p>}
      </> : null}
      <h3>Needs attention</h3>
      {missing ? <p>Some channel activity is not available yet.</p> : incomplete ? <p>Counts cover the available history; older unread activity may be missing.</p> : null}
      {!selected ? <p>Loading activity…</p> : !active.length ? <p>No new activity matching your preferences.</p> : active.map(channel => <button type="button" className="chat-attention-row" key={channel.id} onClick={() => { setOpen(false); onOpen(channel.id); }}>
        <span>#{channel.title.replace(/^#/, "")}</span><span>{attentionMessageCount(states[channel.id]!)} unread</span>
      </button>)}
      <h3>Pinned in this channel · Everyone</h3>
      {!selected?.pins?.length ? <p>No pinned messages in this channel.</p> : selected.pins.map(pin => {
        const message = messages.find(item => item.id === pin.messageId);
        return <div className="chat-attention-follow" key={`pin:${pin.messageId}`}>
          <button type="button" className="chat-attention-row" onClick={() => { setOpen(false); onOpenSaved(channelId, pin.messageId); }}>
            <ChatMessagePreview channelId={channelId} messageId={pin.messageId} message={message} fallback="Pinned message" />
            <span title={new Date(pin.pinnedAt).toLocaleString()}>Pinned by {actorNames[pin.pinnedBy] || pin.pinnedBy}</span>
          </button>
          {onUnpin ? <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => onUnpin(pin.messageId)} aria-label="Unpin shared message">Unpin</button> : null}
        </div>;
      })}
      <h3>Saved messages · Only you</h3>
      {!saved.length ? <p>Save useful messages to return to them here.</p> : saved.map(({ channel, messageId }) => {
        const message = channel.id === channelId ? messages.find(item => item.id === messageId) : undefined;
        return <div className="chat-attention-follow" key={`saved:${channel.id}:${messageId}`}>
          <button type="button" className="chat-attention-row" onClick={() => { setOpen(false); onOpenSaved(channel.id, messageId); }}>
            <span>#{channel.title.replace(/^#/, "")} · <ChatMessagePreview channelId={channel.id} messageId={messageId} message={message} fallback="Saved message" /></span>
          </button>
          <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => onUnsave(channel.id, messageId)} aria-label={`Remove saved message in ${channel.title}`}>Remove</button>
        </div>;
      })}
      <h3>Followed threads</h3>
      {!followed.length ? <p>Follow a thread to keep it here and include its replies in your activity.</p> : followed.map(({ channel, rootId }) => {
        const root = channel.id === channelId ? messages.find(message => message.id === rootId) : undefined;
        const unread = states[channel.id]?.lanes.find(lane => lane.rootMessageId === rootId)?.unreadMessageIds.length ?? 0;
        return <div className="chat-attention-follow" key={`${channel.id}:${rootId}`}>
          <button type="button" className="chat-attention-row" onClick={() => { setOpen(false); onOpen(channel.id, rootId); }}>
            <span>#{channel.title.replace(/^#/, "")} · <ChatMessagePreview channelId={channel.id} messageId={rootId} message={root} fallback="Followed discussion" /></span>
            {unread ? <span>{unread} new</span> : null}
          </button>
          <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => onUnfollow(channel.id, rootId)} aria-label={`Unfollow thread in ${channel.title}`}>Unfollow</button>
        </div>;
      })}
    </div> : null}
  </section>;
}
