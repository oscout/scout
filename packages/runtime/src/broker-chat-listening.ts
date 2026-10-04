import type { BindingObservation } from "./broker-chat-listening-binding.js";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, chmod } from "node:fs/promises";
import { dirname } from "node:path";

export type ListeningMembership = {
  origin: string; channelId: string; space: string; token: string; actorId: string;
};
export type ListeningMessage = {
  id: string; actorId: string; body: string; createdAt: number;
  replyToMessageId?: string; threadRootId: string | null;
  relevance: "mention" | "direct-reply" | null; update?: boolean; bodyTruncated?: boolean;
};
/** Opaque to the service. Every production source supplies an opaque room-HTTP cursor.
 * Local and hosted authorities own their cursor grammar and history guarantees. */
export interface ChatListeningSource {
  read(membership: ListeningMembership, cursor: string | null, agentId: string, recovery?: { afterMessageId?: string }): Promise<{
    cursor: string; messages: ListeningMessage[]; expiresAt: number; hasMore?: boolean;
  }>;
}
export class ChatListeningError extends Error {
  constructor(readonly code: string) { super(code); }
}
export type ListeningBinding = {
  mode: "agent" | "session"; facing: "operator" | "background"; facingSource?: "derived" | "explicit" | "fallback";
  sessionId?: string; endpointId?: string; harness?: string; herdrSession?: string; pane?: string; terminalId?: string;
  state?: "active" | "ended"; endedAt?: number; revision?: number; author?: string; updatedAt?: number;
};
type Attention = ListeningMessage & { position: number };
type Subscription = {
  id: string; agentId: string; membership: ListeningMembership; enabled: boolean; sourceKind: "local-canonical-v1" | "local-changes-v2" | "room-http-v1"; binding?: ListeningBinding;
  enrolledAt: number; enrolledBy: string; sourceCursor: string;
  expiresAt: number; lastConnectedAt: number; readPosition: number;
  messages: Attention[];
  receipt?: { id: string; from: number; through: number };
  lastAck?: string;
  policy: { mode: "catch-up"; awake: "steer" | "queue"; idle: "revive" | "hold";
    author: string; updatedAt: number; revision: number; active: false };
};
type State = { version: 1; lastEventSeq?: number; subscriptions: Subscription[] };

/** Listening-service-owned canonical store. Atomic snapshot includes custody, source frontier,
 * attention and ack together; no separate cursor write can skip a message.
 * Private local pilot storage, not encrypted-at-rest or a rebuildable projection. */
export class BrokerChatListening {
  private state: State = { version: 1, subscriptions: [] };
  private queue: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private backlog = false;
  private closing = false;
  private connections = new Map<string, string>();
  private indexes = new WeakMap<Subscription, Map<string, Attention>>();
  private bindingAvailability = new Map<string, string>();
  private connectedAt = new Map<string, number>();
  private enrolling = new Map<string, number>();
  constructor(private readonly options: {
    path: string; source: ChatListeningSource; isDurableAgent: (id: string) => boolean | undefined | Promise<boolean | undefined>;
    sourceKind?: "local-changes-v2" | "room-http-v1";
    deriveFacing?: (agentId: string) => "operator" | "background" | undefined | Promise<"operator" | "background" | undefined>;
    now?: () => number; observeSession?: (binding: ListeningBinding) => Promise<BindingObservation>;
  }) {}
  private now() { return (this.options.now ?? Date.now)(); }
  async load() {
    try {
      const state = JSON.parse(await readFile(this.options.path, "utf8"));
      if (state.version !== 1 || !Array.isArray(state.subscriptions)) throw new Error("Invalid listening store");
      await chmod(dirname(this.options.path), 0o700);
      await chmod(this.options.path, 0o600);
      this.state = state;
      let events = "";
      try { events = await readFile(`${this.options.path}.events`, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      // A torn final append is repairable; an invalid COMPLETE event fails closed.
      const boundary = events.lastIndexOf("\n") + 1;
      if (boundary < events.length) {
        const file = await open(`${this.options.path}.events`, "r+");
        try { await file.truncate(Buffer.byteLength(events.slice(0, boundary))); await file.sync(); } finally { await file.close(); }
      }
      for (const line of events.slice(0, boundary).split("\n").filter(Boolean)) {
        const event = JSON.parse(line);
        if (event.seq <= (this.state.lastEventSeq ?? 0)) continue;
        if (event.seq !== (this.state.lastEventSeq ?? 0) + 1) throw new Error("Listening event gap");
        const subscription = this.state.subscriptions.find(s => s.id === event.id);
        if (!subscription) throw new Error("Listening event references unknown subscription");
        if (event.page) this.applyPage(subscription, event.page);
        if (event.binding) subscription.binding = event.binding;
        this.state.lastEventSeq = event.seq;
      }
      this.rebuildIndexes();
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  private rebuildIndexes() {
    for (const subscription of this.state.subscriptions) this.indexes.set(subscription, new Map(subscription.messages.map(m => [m.id, m])));
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => undefined);
    return result;
  }
  private async commit(state: State) {
    await mkdir(dirname(this.options.path), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.options.path), 0o700);
    const temp = `${this.options.path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temp, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(state)); await handle.sync(); } finally { await handle.close(); }
      await rename(temp, this.options.path);
      // Publish memory only once the atomic replacement succeeded.
      this.state = state;
      this.rebuildIndexes();
      const directory = await open(dirname(this.options.path), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await unlink(temp).catch(() => undefined); }
  }
  hasIdentityReference(id: string): boolean {
    return this.enrolling.has(id) || this.state.subscriptions.some(s => s.agentId === id || s.membership.actorId === id);
  }
  async enroll(agentId: string, membership: ListeningMembership, author: string, requested?: Partial<ListeningBinding>) {
    const identities = [agentId, membership?.actorId].filter((id): id is string => typeof id === "string");
    for (const id of identities) this.enrolling.set(id, (this.enrolling.get(id) ?? 0) + 1);
    try { return await this.serial(async () => {
      if (requested !== undefined && (requested === null || typeof requested !== "object" || Array.isArray(requested))) throw new ChatListeningError("invalid_binding");
      if (requested?.mode !== undefined && !["agent", "session"].includes(requested.mode)) throw new ChatListeningError("invalid_binding");
      if (requested?.facing !== undefined && !["operator", "background"].includes(requested.facing)) throw new ChatListeningError("invalid_facing");
      const derivedFacing = requested?.mode === "session" ? undefined : await this.options.deriveFacing?.(agentId);
      const binding: ListeningBinding = { mode: requested?.mode ?? "agent", facing: requested?.facing ?? derivedFacing ?? "background",
        facingSource: requested?.facing ? "explicit" : derivedFacing ? "derived" : "fallback", state: "active", author, updatedAt: this.now(), revision: 1 };
      for (const key of ["sessionId", "endpointId", "harness", "herdrSession", "pane"] as const) {
        if (requested?.[key] !== undefined) {
          if (typeof requested[key] !== "string" || !requested[key]!.trim() || requested[key]!.length > 512) throw new ChatListeningError("invalid_binding");
          binding[key] = requested[key];
        }
      }
      if (binding.mode === "session") {
        if (!binding.sessionId || !this.options.observeSession) throw new ChatListeningError("session_proof_required");
        const observed = await this.options.observeSession(binding);
        if (observed.availability !== "available") throw new ChatListeningError("session_not_verified_live");
        binding.facing = requested?.facing ?? observed.facing ?? "background";
        binding.facingSource = requested?.facing ? "explicit" : observed.facing ? "derived" : "fallback";
        binding.terminalId = observed.terminalId; binding.endpointId = observed.endpointId ?? binding.endpointId;
      } else if (!await this.options.isDurableAgent(agentId)) throw new ChatListeningError("durable_agent_required");
      for (const key of ["origin", "channelId", "space", "token", "actorId"] as const) {
        if (typeof membership?.[key] !== "string" || !membership[key].trim() || membership[key].length > 8192) throw new ChatListeningError("invalid_membership");
      }
      const origin = new URL(membership.origin);
      if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new ChatListeningError("invalid_origin");
      membership = { origin: origin.origin, channelId: membership.channelId,
        space: membership.space, token: membership.token, actorId: membership.actorId };
      const id = createHash("sha256").update(JSON.stringify([agentId, membership.origin, membership.space, membership.channelId])).digest("hex").slice(0, 32);
      const next = structuredClone(this.state);
      const existing = next.subscriptions.find(s => s.id === id);
      if (next.subscriptions.some(s => s.enabled && s.id !== id && s.membership.origin === membership.origin
        && s.membership.space === membership.space && s.membership.channelId === membership.channelId
        && s.membership.actorId === membership.actorId)) throw new ChatListeningError("membership_already_owned");
      if (existing && existing.membership.actorId !== membership.actorId) throw new ChatListeningError("membership_identity_changed");
      // Retried adoption/credential refresh keeps the original frontier and ack.
      if (existing?.binding?.state === "ended") throw new ChatListeningError("binding_ended_reconcile_required");
      if (existing?.binding && (existing.binding.mode !== binding.mode || existing.binding.sessionId !== binding.sessionId
        || (["terminalId", "herdrSession", "pane", "endpointId"] as const).some(key => existing.binding![key] !== binding[key]))) throw new ChatListeningError("binding_identity_changed");
      const page = await this.options.source.read(membership, existing?.sourceCursor ?? null, agentId, { afterMessageId: existing?.messages.at(-1)?.id });
      if (binding.mode === "agent" && !await this.options.isDurableAgent(agentId)) throw new ChatListeningError("durable_agent_required");
      const now = this.now();
      const subscription: Subscription = existing ?? {
        id, agentId, membership, enabled: true, sourceKind: this.options.sourceKind ?? "room-http-v1", binding, enrolledAt: now, enrolledBy: author,
        sourceCursor: page.cursor, expiresAt: page.expiresAt, lastConnectedAt: now,
        messages: [], readPosition: 0,
        policy: { mode: "catch-up", awake: "queue", idle: "hold", author, updatedAt: now, revision: 1, active: false },
      };
      if (existing?.binding) binding.revision = (existing.binding.revision ?? 1) + 1;
      subscription.binding = binding; subscription.sourceKind = this.options.sourceKind ?? "room-http-v1";
      subscription.membership = membership; subscription.enabled = true;
      this.applyPage(subscription, page);
      if (!existing) next.subscriptions.push(subscription);
      await this.commit(next);
      this.connections.set(id, "connected");
      return this.status(agentId).find(s => s.id === id)!;
    }); } finally {
      for (const id of identities) {
        const remaining = (this.enrolling.get(id) ?? 1) - 1;
        if (remaining) this.enrolling.set(id, remaining); else this.enrolling.delete(id);
      }
    }
  }
  private applyPage(s: Subscription, page: Awaited<ReturnType<ChatListeningSource["read"]>>) {
    let index = this.indexes.get(s);
    if (!index) { index = new Map(s.messages.map(m => [m.id, m])); this.indexes.set(s, index); }
    const seen = index;
    for (const message of page.messages) {
      if (seen.has(message.id)) {
        const prior = index.get(message.id)!;
        Object.assign(prior, message, { position: prior.position });
        continue;
      }
      // Changes to the enrollment baseline are not new unread messages.
      if (message.update) continue;
      const attention = { ...message, position: s.messages.length + 1 };
      index.set(message.id, attention); s.messages.push(attention);
    }
    s.sourceCursor = page.cursor; s.expiresAt = page.expiresAt; s.lastConnectedAt = this.now();
  }
  status(agentId: string) {
    return this.state.subscriptions.filter(s => s.agentId === agentId).map(s => ({
      id: s.id, agentId, sourceKind: s.sourceKind, binding: s.binding ?? { mode: "agent", facing: "background", state: "active" }, bindingAvailability: s.binding?.state === "ended" ? "ended" : this.bindingAvailability.get(s.id) ?? "unknown", room: { origin: s.membership.origin, channelId: s.membership.channelId, space: s.membership.space, actorId: s.membership.actorId },
      membership: !s.enabled ? "withdrawn" : s.expiresAt <= this.now() ? "expired" : this.connections.get(s.id) === "membership_denied" ? "denied" : "enrolled",
      connection: this.connections.get(s.id) ?? "disconnected",
      expiresAt: s.expiresAt === Number.MAX_SAFE_INTEGER ? null : s.expiresAt, lastConnectedAt: this.connectedAt.get(s.id) ?? s.lastConnectedAt,
      pendingCount: s.messages.filter(m => m.position > s.readPosition && m.relevance).length,
      unreadCount: s.messages.length - s.readPosition, readPosition: s.readPosition,
      ingestedCount: s.messages.length, policy: s.policy,
    }));
  }
  private async persistDelta(subscription: Subscription, change: { page?: Awaited<ReturnType<ChatListeningSource["read"]>>; binding?: ListeningBinding }) {
    const seq = (this.state.lastEventSeq ?? 0) + 1;
    const handle = await open(`${this.options.path}.events`, "a", 0o600);
    const size = (await handle.stat()).size;
    try { await handle.writeFile(JSON.stringify({ seq, id: subscription.id, ...change }) + "\n"); await handle.sync(); }
    catch (error) { await handle.truncate(size); throw error; }
    finally { await handle.close(); }
    if (change.page) this.applyPage(subscription, change.page);
    if (change.binding) subscription.binding = change.binding;
    this.state.lastEventSeq = seq;
  }
  async tick() {
    return this.serial(async () => {
      this.backlog = false;
      for (const original of this.state.subscriptions) {
        if (this.closing) break;
        if (!original.enabled) continue;
        if (original.sourceKind !== (this.options.sourceKind ?? "room-http-v1")) { this.connections.set(original.id, "source_cursor_upgrade_required"); continue; }
        try {
          const current = original;
          if (original.binding?.mode === "session" && original.binding.state !== "ended") {
            const observed = await this.options.observeSession?.(original.binding);
            if (observed?.availability === "unavailable") {
              await this.persistDelta(current, { binding: { ...original.binding, state: "ended", endedAt: this.now() } });
              this.bindingAvailability.set(original.id, "ended");
            }
            else this.bindingAvailability.set(original.id, observed?.availability ?? "unknown");
          } else if (original.binding?.mode !== "session" && await this.options.isDurableAgent(original.agentId) === false) { this.connections.set(original.id, "identity_unavailable"); continue; }
          const page = await this.options.source.read(current.membership, current.sourceCursor, current.agentId, { afterMessageId: current.messages.at(-1)?.id });
          if (page.hasMore) this.backlog = true;
          if (page.cursor !== current.sourceCursor || page.messages.length || page.expiresAt !== current.expiresAt) {
            // Append only this bounded delta; never clone/stringify accumulated history on a scan.
            await this.persistDelta(current, { page });
          }
          this.connectedAt.set(original.id, this.now());
          this.connections.set(original.id, "connected");
        } catch (error) {
          // Never put raw transport responses (which can contain tokens) in status.
          this.connections.set(original.id, error instanceof ChatListeningError ? error.code : "source_unavailable");
        }
      }
    });
  }
  async catchUp(agentId: string, id: string, limit = 50) {
    return this.serial(async () => {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ChatListeningError("invalid_limit");
      const next = structuredClone(this.state);
      const s = this.find(next, agentId, id);
      let messages = s.messages.filter(m => m.position > s.readPosition && (!s.receipt || m.position <= s.receipt.through));
      // A receipt is replayable after a lost response/restart. Never overwrite an
      // outstanding batch with a later batch that could implicitly ack skipped rows.
      if (!s.receipt) {
        messages = messages.slice(0, limit);
        let bytes = 0;
        messages = messages.filter((message, index) => { bytes += Buffer.byteLength(JSON.stringify(message)); return index === 0 || bytes <= 64 * 1024; });
        if (messages.length) s.receipt = { id: randomUUID(), from: s.readPosition, through: messages.at(-1)!.position };
        await this.commit(next);
      }
      return { subscriptionId: id, readPosition: s.readPosition, ack: s.receipt?.id ?? null,
        hasMore: s.messages.length > (messages.at(-1)?.position ?? s.readPosition),
        messages: messages.map(m => ({ ...m, body: m.body.slice(0, 16000), bodyTruncated: m.bodyTruncated === true || m.body.length > 16000, reply: { origin: s.membership.origin, space: s.membership.space,
          channelId: s.membership.channelId, messageId: m.id, threadRootId: m.threadRootId } })) };
    });
  }
  async unenroll(agentId: string, id: string) {
    return this.serial(async () => {
      const next = structuredClone(this.state), s = this.find(next, agentId, id);
      s.enabled = false; s.membership.token = "";
      await this.commit(next); this.connections.set(id, "stopped");
      return { subscriptionId: id, membership: "withdrawn", retainedForCatchUp: true };
    });
  }
  async ack(agentId: string, id: string, receipt: string) {
    return this.serial(async () => {
      const next = structuredClone(this.state), s = this.find(next, agentId, id);
      if (s.lastAck === receipt) return { readPosition: s.readPosition };
      if (!s.receipt || s.receipt.id !== receipt || s.receipt.from !== s.readPosition) throw new ChatListeningError("invalid_ack");
      s.readPosition = s.receipt.through; s.lastAck = receipt; delete s.receipt;
      await this.commit(next);
      return { readPosition: s.readPosition };
    });
  }
  private find(state: State, agentId: string, id: string) {
    const s = state.subscriptions.find(s => s.id === id && s.agentId === agentId);
    if (!s) throw new ChatListeningError("unknown_subscription");
    return s;
  }
  start(intervalMs = 5000) {
    if (!this.stopped) return;
    this.stopped = false; this.closing = false;
    const run = async () => {
      try { await this.tick(); } catch { /* Retry on the next bounded timer; never dispatch. */ } finally {
        if (!this.stopped) { this.timer = setTimeout(() => { void run(); }, this.backlog ? Math.min(intervalMs, 250) : intervalMs); this.timer.unref(); }
      }
    };
    this.timer = setTimeout(() => { void run(); }, 0); this.timer.unref();
  }
  async stop() { this.stopped = true; this.closing = true; clearTimeout(this.timer); await this.queue; }
}
