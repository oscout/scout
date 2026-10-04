import { ROOM_LISTENING_PAGE_BYTES, ROOM_LISTENING_MESSAGE_BYTES } from "@openscout/protocol";
import { Database } from "bun:sqlite";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { statSync } from "node:fs";
import { resolveDbPath } from "./db/internal/db.ts";

export class RoomListeningPageError extends Error {}
/** Bound JSON bytes, not UTF-16 length: escapes and UTF-8 both expand. */
function boundedMessage(message: any) {
  const original = message.body as string;
  // Avoid serializing an arbitrarily large body just to discover it is too large.
  let candidate = { ...message, body: original.slice(0, ROOM_LISTENING_MESSAGE_BYTES) };
  if (candidate.body.length === original.length && Buffer.byteLength(JSON.stringify(candidate)) <= ROOM_LISTENING_MESSAGE_BYTES) return candidate;
  candidate = { ...candidate, bodyTruncated: true };
  let low = 0, high = candidate.body.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify({ ...candidate, body: original.slice(0, middle) })) <= ROOM_LISTENING_MESSAGE_BYTES) low = middle;
    else high = middle - 1;
  }
  // Do not cut an astral character's surrogate pair in half.
  if (low && /[\uD800-\uDBFF]/.test(original[low - 1]!) && /[\uDC00-\uDFFF]/.test(original[low] ?? "")) low--;
  candidate.body = original.slice(0, low);
  if (Buffer.byteLength(JSON.stringify(candidate)) > ROOM_LISTENING_MESSAGE_BYTES) throw new RoomListeningPageError("source_invalid_message");
  return candidate;
}
type Db = Pick<Database, "query">;
type Frontier = [conversationId: string, seq: number, anchorHash: string | null];
const anchorHash = (id: string) => createHash("sha256").update(id).digest("base64url").slice(0, 22);
/** Each conversation's existing seq is stable across unrelated deletes and VACUUM.
 * The encrypted vector covers the room and its threads; no broker write hook or
 * new SQLite projection. Candidate reads are indexed and bounded per thread.
 */
export function roomListeningPage(db: Db, input: { channelId: string; actorId: string; cursor?: string; epoch: string; secret: string; limit?: number; afterMessageId?: string }) {
  const aad = Buffer.from(`${input.channelId}\0${input.actorId}`);
  const encode = (frontiers: Frontier[]) => {
    const key = createHash("sha256").update(`room-listening.v2\0${input.secret}`).digest();
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(aad);
    const payload = Buffer.from(JSON.stringify({ epoch: input.epoch, frontiers }));
    if (payload.length > 256 * 1024) throw new RoomListeningPageError("source_cursor_capacity");
    const body = Buffer.concat([cipher.update(deflateRawSync(payload)), cipher.final()]);
    const result = `room.v2.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url")}`;
    if (result.length > 16384) throw new RoomListeningPageError("source_cursor_capacity");
    return result;
  };
  const scope = db.query<{ id: string }, [string, string]>(
    "SELECT id FROM conversations WHERE id=? OR parent_conversation_id=? ORDER BY id",
  ).all(input.channelId, input.channelId).map(row => row.id);
  if (!scope.includes(input.channelId)) throw new RoomListeningPageError("source_history_gap");
  const tails = new Map(scope.map(id => [id, db.query<{ seq: number; id: string }, [string]>(
    "SELECT seq,id FROM thread_events WHERE conversation_id=? ORDER BY seq DESC LIMIT 1",
  ).get(id)]));
  let frontiers: Frontier[] = [];
  let migrated = false, legacyPosition: number | undefined;
  if (input.cursor) {
    try {
      const version = input.cursor.startsWith("room.v2.") ? 2 : input.cursor.startsWith("room.v1.") ? 1 : 0;
      if (!version || input.cursor.length > 16384) throw Error();
      const key = createHash("sha256").update(`room-listening.v${version}\0${input.secret}`).digest();
      const bytes = Buffer.from(input.cursor.slice(8), "base64url"), decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decipher.setAAD(aad); decipher.setAuthTag(bytes.subarray(12, 28));
      const plaintext = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
      const value = JSON.parse((version === 2 ? inflateRawSync(plaintext, { maxOutputLength: 256 * 1024 }) : plaintext).toString());
      if (value.epoch !== input.epoch) throw Error();
      if (version === 1) {
        if (!Number.isSafeInteger(value.after) || value.after < 0 || (value.after > 0 && typeof value.anchor !== "string")) throw Error();
        migrated = true;
        // Locate a surviving stable ID, never trust a possibly reused rowid.
        legacyPosition = value.after === 0 ? 0 : db.query<{ position: number }, [string]>(
          "SELECT rowid AS position FROM thread_events WHERE id=?",
        ).get(value.anchor)?.position;
        if (legacyPosition === undefined && input.afterMessageId) {
          const m = db.query<{ id: string; conversation_id: string; created_at: number; actor_id: string; audience_json: string | null }, [string]>(
            "SELECT id,conversation_id,created_at,actor_id,audience_json FROM messages WHERE id=?",
          ).get(input.afterMessageId);
          const audience = m?.audience_json ? JSON.parse(m.audience_json) : null;
          if (m && scope.includes(m.conversation_id) && (!audience?.visibleTo || audience.visibleTo.includes(input.actorId) || m.actor_id === input.actorId)) {
            legacyPosition = db.query<{ position: number }, [string]>("SELECT rowid AS position FROM thread_events WHERE id=?")
              .get(`thread-event:message:${m.id}:${m.created_at}`)?.position;
          }
        }
        // With neither anchor left, replay retained room history rather than
        // silently jumping to today's tail. Accumulator message IDs dedupe it.
        legacyPosition ??= 0;
      } else {
        if (!Array.isArray(value.frontiers)) throw Error();
        const seen = new Set<string>();
        for (const f of value.frontiers) {
          if (!Array.isArray(f) || f.length !== 3 || typeof f[0] !== "string" || seen.has(f[0]) || !scope.includes(f[0])
            || !Number.isSafeInteger(f[1]) || f[1] < 0 || (f[1] === 0 ? f[2] !== null : typeof f[2] !== "string")) throw Error();
          seen.add(f[0]); frontiers.push(f as Frontier);
        }
      }
    } catch { throw new RoomListeningPageError("source_history_gap"); }
  }
  let changed = !input.cursor || migrated;
  const saved = new Map(frontiers.map(f => [f[0], f]));
  for (const id of scope) {
    if (!saved.has(id)) {
      if (id !== input.channelId && !tails.get(id)) continue; // Empty threads have no frontier to retain.
      const tail = !input.cursor ? tails.get(id) : migrated ? db.query<{ seq: number; id: string }, [string, number]>(
        "SELECT seq,id FROM thread_events WHERE conversation_id=? AND rowid<=? ORDER BY seq DESC LIMIT 1",
      ).get(id, legacyPosition!) : null;
      const f: Frontier = [id, tail?.seq ?? 0, tail ? anchorHash(tail.id) : null];
      frontiers.push(f); saved.set(id, f); changed = true;
    }
  }
  const candidates: { position: number; id: string; conversation_id: string; seq: number; kind: string }[] = [];
  for (const f of frontiers) {
    const tail = tails.get(f[0]);
    if (f[1] > (tail?.seq ?? 0)) throw new RoomListeningPageError("source_history_gap");
    if (f[1]) {
      const anchor = db.query<{ id: string }, [string, number]>("SELECT id FROM thread_events WHERE conversation_id=? AND seq=?").get(f[0], f[1]);
      if (!anchor || anchorHash(anchor.id) !== f[2]) throw new RoomListeningPageError("source_history_gap");
    }
    if (input.cursor && f[1] < (tail?.seq ?? 0)) candidates.push(...db.query<typeof candidates[number], [string, number]>(
      "SELECT rowid AS position,id,conversation_id,seq,kind FROM thread_events WHERE conversation_id=? AND seq>? ORDER BY seq LIMIT 100",
    ).all(f[0], f[1]));
  }
  const limit = Math.max(1, Math.min(100, Number.isFinite(input.limit) ? Math.floor(input.limit!) : 100));
  const rows = candidates.sort((a, b) => a.position - b.position).slice(0, limit);
  let pageBytes = 2;
  let budget = 256;
  const conversation = (id: string) => db.query<any, [string]>("SELECT id,kind,parent_conversation_id,message_id FROM conversations WHERE id=?").get(id);
  const message = (id: string, ancestry = false) => {
    if (ancestry && --budget < 0) return null;
    const row = db.query<any, [string]>("SELECT * FROM messages WHERE id=?").get(id);
    if (!row) return null;
    const c = conversation(row.conversation_id);
    if (c?.id !== input.channelId && c?.parent_conversation_id !== input.channelId) return null;
    const audience = row.audience_json ? JSON.parse(row.audience_json) : null;
    if (audience?.visibleTo && !audience.visibleTo.includes(input.actorId) && row.actor_id !== input.actorId) return null;
    return { ...row, parent: row.reply_to_message_id ?? (c?.kind === "thread" ? c.message_id : null) };
  };
  const messages: any[] = [];
  for (const row of rows) {
    const frontier = saved.get(row.conversation_id)!;
    const previousSeq = frontier[1], previousAnchor = frontier[2];
    if (row.seq !== previousSeq + 1) throw new RoomListeningPageError("source_history_gap");
    frontier[1] = row.seq; frontier[2] = anchorHash(row.id); changed = true;
    if (row.kind !== "message.posted") continue;
    const c = conversation(row.conversation_id);
    if (c?.id !== input.channelId && c?.parent_conversation_id !== input.channelId) continue;
    const id = db.query<{ messageId: unknown }, [string]>(
      "SELECT json_extract(payload_json, '$.message.id') AS messageId FROM thread_events WHERE id=?",
    ).get(row.id)?.messageId;
    if (typeof id !== "string") throw new RoomListeningPageError("source_invalid_message");
    // Always read CURRENT content/audience, never resurrect an edited/deleted event payload.
    const m = message(id); if (!m) continue;
    let current = m, root: string | null = m.id, replyActorId: string | null = null;
    const visited = new Set<string>();
    while (current.parent) {
      if (visited.has(current.id) || visited.size >= 32) { root = null; break; }
      visited.add(current.id); const parent = message(current.parent, true);
      if (!parent) { root = null; break; }
      if (current === m) replyActorId = parent.actor_id;
      current = parent; root = parent.id;
    }
    const mentions = db.query<{ actor_id: string }, [string]>("SELECT actor_id FROM message_mentions WHERE message_id=?").all(m.id).map(r => ({ actorId: r.actor_id }));
    const projected = boundedMessage({ id: m.id, actorId: m.actor_id, body: m.body, createdAt: m.created_at,
      replyToMessageId: m.parent, threadRootId: root, replyActorId, mentions });
    const bytes = Buffer.byteLength(JSON.stringify(projected)) + (messages.length ? 1 : 0);
    if (pageBytes + bytes > ROOM_LISTENING_PAGE_BYTES) { frontier[1] = previousSeq; frontier[2] = previousAnchor; break; }
    messages.push(projected); pageBytes += bytes;
  }
  // Preserve the exact opaque cursor on an empty pass; no needless state writes.
  const nextCursor = !changed ? input.cursor! : encode(frontiers.sort((a, b) => a[0].localeCompare(b[0])));
  return { protocol: "room-listening.v1", channelId: input.channelId, messages, nextCursor, hasMore: frontiers.some(f => f[1] < (tails.get(f[0])?.seq ?? 0)), ...(migrated ? { cursorMigrated: true } : {}) };
}
export function readLocalRoomListeningPage(input: { channelId: string; actorId: string; cursor?: string; secret: string; limit?: number; afterMessageId?: string }) {
  const path = resolveDbPath(), file = statSync(path);
  const db = new Database(path, { readonly: true, create: false });
  try {
    db.exec("PRAGMA busy_timeout=250; BEGIN;");
    return roomListeningPage(db, { ...input, epoch: `${file.dev}:${file.ino}:${file.birthtimeMs}` });
  } finally { db.close(); }
}
