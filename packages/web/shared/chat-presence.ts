export type ChatPresenceBeat = { clientId: string; sequence: number; active: boolean; typing: boolean; threadId?: string | null };
type Entry = ChatPresenceBeat & { scope: string; actorId: string; name: string; operator: boolean; expiresAt: number; typingUntil: number };

/** Advisory, instance-local web-tab activity. Never persisted or treated as delivery evidence. */
export class ChatPresence {
  private entries = new Map<string, Entry>();
  constructor(private readonly now = Date.now, private readonly maxClients = 2000) {}
  update(scope: string, actorId: string, name: string, operator: boolean, beat: ChatPresenceBeat): boolean {
    const now = this.now();
    this.prune(now);
    const key = JSON.stringify([scope, actorId, beat.clientId]);
    const current = this.entries.get(key);
    if (current && current.sequence >= beat.sequence) return true;
    if (!current && this.entries.size >= this.maxClients) return false;
    this.entries.set(key, { ...beat, scope, actorId, name, operator, expiresAt: now + 35000,
      typingUntil: beat.active && beat.typing ? now + 6000 : 0 });
    return true;
  }
  read(scope: string, allowed: ReadonlySet<string>) {
    const now = this.now(); this.prune(now);
    const people = new Map<string, { actorId: string; name: string; expiresInMs: number; typing: Array<{ threadId: string | null; expiresInMs: number }> }>();
    for (const entry of this.entries.values()) {
      if (entry.scope !== scope || !entry.active || (!entry.operator && !allowed.has(entry.actorId))) continue;
      const person = people.get(entry.actorId) ?? { actorId: entry.actorId, name: entry.name, expiresInMs: 0, typing: [] };
      person.expiresInMs = Math.max(person.expiresInMs, entry.expiresAt - now);
      if (entry.typingUntil > now) person.typing.push({ threadId: entry.threadId ?? null, expiresInMs: entry.typingUntil - now });
      people.set(entry.actorId, person);
    }
    return [...people.values()];
  }
  private prune(now: number) {
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(key);
  }
}

export function parseChatPresenceBeat(value: unknown): ChatPresenceBeat | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => !["clientId", "sequence", "active", "typing", "threadId"].includes(key))
    || typeof body.clientId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(body.clientId)
    || !Number.isSafeInteger(body.sequence) || (body.sequence as number) < 0 || typeof body.active !== "boolean" || typeof body.typing !== "boolean"
    || (body.threadId != null && (typeof body.threadId !== "string" || !body.threadId.trim() || body.threadId.length > 200))) return null;
  return body as ChatPresenceBeat;
}
