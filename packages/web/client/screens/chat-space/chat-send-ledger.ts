import { composerFileId } from "../../lib/composer-file-recovery.ts";
import { browserChatStorage, type ChatStorage } from "./chat-local-state.ts";
import type { MessageAttachment } from "@openscout/protocol";

export interface ChatSendIntent {
  actorId: string;
  space: string;
  channelId: string;
  body: string;
  replyToMessageId: string | null;
  targetActorId: string | null;
  files: File[];
  mentionActorIds: string[];
}

export interface PendingChatSend extends ChatSendIntent {
  requestId: string;
  attachments?: Array<MessageAttachment & { localPath?: string }>;
}

// Exact payload keys avoid collisions and shared-index races. File identities
// follow their browser-local persisted blobs across reconstruction.
function recoveryKey(intent: ChatSendIntent): string | null {
  return `openscout.chat.pending-send.v1:${JSON.stringify([
    intent.actorId, intent.space, intent.channelId, intent.replyToMessageId,
    intent.targetActorId, intent.body, [...new Set(intent.mentionActorIds)].sort(),
    ...(intent.files.length ? [intent.files.map(composerFileId)] : []),
  ])}`;
}

/** Uncertain writes keep their identity even while other composers make progress. */
export function createChatSendLedger(requestId: () => string, storage: ChatStorage | null = browserChatStorage()) {
  const pending = new Set<PendingChatSend>();
  return {
    begin(intent: ChatSendIntent): PendingChatSend {
      const mentions = [...new Set(intent.mentionActorIds)].sort();
      for (const entry of pending) {
        if (entry.actorId === intent.actorId && entry.space === intent.space
          && entry.channelId === intent.channelId && entry.body === intent.body
          && entry.replyToMessageId === intent.replyToMessageId && entry.targetActorId === intent.targetActorId
          && entry.files.length === intent.files.length && entry.files.every((file, index) => file === intent.files[index])
          && JSON.stringify(entry.mentionActorIds) === JSON.stringify(mentions)) return entry;
      }
      // Never silently evict an uncertain request and turn its next retry into a duplicate.
      if (pending.size >= 100) throw new Error("Too many sends are awaiting confirmation. Retry an existing message before sending another.");
      const key = recoveryKey(intent);
      let recovered: string | null = null;
      let attachments: PendingChatSend["attachments"];
      try {
        const raw = key ? storage?.getItem(key) : null;
        if (raw && /^[a-zA-Z0-9_-]{1,200}$/.test(raw)) recovered = raw;
        else if (raw) {
          const record = JSON.parse(raw);
          if (typeof record.requestId === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(record.requestId)) {
            recovered = record.requestId;
            if (Array.isArray(record.attachments) && record.attachments.every((item: unknown) => item && typeof item === "object" && typeof (item as MessageAttachment).id === "string" && typeof (item as MessageAttachment).mediaType === "string")) attachments = record.attachments;
          }
        }
      } catch { /* Keep working in memory when browser storage is unavailable. */ }
      const entry = { ...intent, files: [...intent.files], mentionActorIds: mentions, requestId: recovered ?? requestId(), attachments };
      // Persist before the network write: a reload after a lost response must
      // retry the same server-side idempotency key.
      try { if (key) storage?.setItem(key, JSON.stringify({ requestId: entry.requestId, attachments: entry.attachments })); } catch { /* In-memory recovery still works. */ }
      pending.add(entry);
      return entry;
    },
    prepared(entry: PendingChatSend, attachments: PendingChatSend["attachments"]) {
      entry.attachments = attachments;
      const key = recoveryKey(entry);
      try { if (key) storage?.setItem(key, JSON.stringify({ requestId: entry.requestId, attachments })); } catch { /* Existing request identity still allows deduplication. */ }
    },
    acknowledge(entry: PendingChatSend) {
      pending.delete(entry);
      const key = recoveryKey(entry);
      try {
        // Another tab may have created a later logical send of the same text.
        const raw = key ? storage?.getItem(key) : null;
        if (key && raw && (raw === entry.requestId || JSON.parse(raw).requestId === entry.requestId)) storage?.removeItem(key);
      } catch { /* A retained key favors deduplication over an accidental duplicate. */ }
    },
  };
}
