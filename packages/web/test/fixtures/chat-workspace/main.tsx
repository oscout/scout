import { composerFileId, readComposerFiles, updateComposerFiles } from "../../../client/lib/composer-file-recovery.ts";
import { ChatPresence } from "../../../shared/chat-presence.ts";
import { correctChatMessage, ChatMessageCorrectionError, applyChatPinChange, applyChatAttentionPreferenceChange, readChatAttentionPreferences } from "@openscout/protocol";
import { createHostedChatApi, HOSTED_CHAT_CAPABILITIES } from "../../../client/hosted-chat/hosted-chat-api.ts";
import { installHostedFixtureWire } from "./hosted-wire.ts";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatSpaceSurface } from "../../../client/screens/chat-space/ChatSpaceSurface.tsx";
import { ChatTransportProvider } from "../../../client/screens/chat-space/chat-transport.tsx";
import { createQueryChatAddress } from "../../../client/screens/chat-space/chat-address.ts";
import { ChatApiError, LOCAL_CHAT_CAPABILITIES, type ChatApi, type ChatMessage, type ChannelMemberView, type TrackedRequest } from "../../../client/screens/chat-space/chat-api.ts";
import type { ConversationDefinition } from "@openscout/protocol";
import { projectChatReadLane } from "../../../shared/chat-read-state.ts";
import "../../../client/styles/tokens.css";
import "../../../client/styles/primitives.css";
import "../../../client/arc-tailwind.css";
import "../../../client/app.css";

// Controlled browser failures stay inside this fixture and target only file drafts.
const fileStorageFailure = new URLSearchParams(location.search).get("fileStorageFailure");
if (fileStorageFailure === "denied") {
  const open = indexedDB.open.bind(indexedDB);
  indexedDB.open = (name, version) => {
    if (name === "openscout-composer-files") throw new DOMException("Controlled storage denial", "SecurityError");
    return open(name, version);
  };
}
if (fileStorageFailure === "quota") {
  const transaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (names, mode, options) {
    if (this.name === "openscout-composer-files" && mode === "readwrite") throw new DOMException("Controlled storage quota", "QuotaExceededError");
    return transaction.call(this, names, mode, options);
  };
}

const scenario = new URLSearchParams(location.search).get("scenario");
const fixtureKey = `scout.test.chat-workspace${scenario ? `.${scenario}` : ""}`;
const stored = JSON.parse(localStorage.getItem(fixtureKey) ?? "null");
let actorId = stored?.actorId ?? "maya";
const fixturePresence = new ChatPresence();
let peerSequence = 0;
let fixtureTurn = 1;
let executionStopped = false;
let failNext = false;
let loseNextAcknowledgement = false;
let limitNext = false;
let delayNext = false;
let offline = false;
let hideEarlier = new URLSearchParams(location.search).has("older");
let agentAvailable = true;
let releaseSend: (() => void) | null = null;
const room = (id: string): ConversationDefinition => ({
  id, title: id, kind: "channel", topic: "Controlled collaboration checks — no real participants",
  visibility: "workspace", shareMode: "shared", authorityNodeId: "fixture", participantIds: ["maya", "alex", "codex"],
});
const channels = [room("general"), room("release")];
const baseTime = Date.now() - 3_600_000;
const messages: Record<string, ChatMessage[]> = stored?.messages ?? Object.fromEntries(channels.map(({ id }) => [id,
  Array.from({ length: 45 }, (_, index) => ({
    id: `${id}-${index}`, actorId: index % 2 ? "maya" : "alex", class: "agent",
    body: `Checkpoint ${index + 1}: ${index % 2 ? "I verified the draft and reconnect behavior. Next we should check the thread reply." : "The release discussion belongs here. Keep the reading position stable while new updates arrive."}`,
    createdAt: baseTime + index * 60_000,
  })),
]));
if (new URLSearchParams(location.search).has("long") && !messages.general!.some(message => message.id === "history-0")) {
  for (let i = 0; i < 115; i++) messages.general!.push({ id: `history-${i}`, actorId: "alex", body: `Historical reply ${i + 1}: retained context pagination check.`, class: "agent", replyToMessageId: "general-12", createdAt: baseTime + i * 1000 });
}
const postedRequests: Record<string, TrackedRequest[]> = stored?.postedRequests ?? {};
const reactionActors: Record<string, Record<string, string[]>> = stored?.reactionActors ?? {};
const persist = () => localStorage.setItem(fixtureKey, JSON.stringify({ actorId, messages, postedRequests, reactionActors }));
const reactionChips = (messageId: string) => Object.entries(reactionActors[messageId] ?? {}).filter(([, actors]) => actors.length).map(([emoji, actors]) => ({ emoji, count: actors.length, me: actors.includes(actorId) }));
const changeReaction = (channelId: string, messageId: string, emoji: string, remove: boolean) => {
  if (offline) throw new ChatApiError("Fixture disconnected", 503);
  if (!messages[channelId]?.some(message => message.id === messageId)) throw new ChatApiError("Message not found", 404);
  const record = reactionActors[messageId] ??= {};
  const actors = record[emoji] ?? [];
  const replayed = actors.includes(actorId) === !remove;
  record[emoji] = remove ? actors.filter(id => id !== actorId) : [...new Set([...actors, actorId])];
  persist();
  return { ok: true as const, replayed };
};
const members: ChannelMemberView[] = ["maya", "alex", "codex"].map((id) => ({
  actorId: id, displayName: id === "codex" ? "Codex" : id === "maya" ? "Maya" : "Alex",
  kind: id === "codex" ? "agent" : "person", harness: id === "codex" ? "codex" : undefined,
  ...(id === "codex" ? { owner: { actorId: "maya", displayName: "Maya" } } : {}),
  reception: { state: "ready_to_receive", routeKind: "persistent", listening: true,
    summary: "Ready to receive", detail: "Controlled fixture route", evidenceAt: baseTime,
    attachedSessionId: "fixture-session", redeemedAt: baseTime },
}));
// Author labels travel with history even when active membership changes.
for (const rows of Object.values(messages)) {
  for (const message of rows) message.actorName = members.find(member => member.actorId === message.actorId)?.displayName;
}
if (new URLSearchParams(location.search).has("mentions")) {
  for (const row of messages.general ?? []) if (row.actorId === "maya") row.mentions = [{ actorId: "alex", label: "Alex" }];
}
const unavailable = async (): Promise<never> => { throw new Error("Not provided by this fixture"); };
const fixtureInvites = ["general", "release"].flatMap(channelId => ["teammate", "api"].map((kind, index) => ({
  id: `${channelId}-invite-${index}`, channelId, kind: kind as "teammate" | "api", createdByActorId: "fixture-owner",
  scope: "channel_participation" as const, state: "active" as "active" | "revoked", tokenHint: `test${index}`,
  createdAt: Date.now(), expiresAt: Date.now() + 86400000, maxRedemptions: 1, redemptionCount: 0,
  route: { authorityNodeId: "fixture", host: location.host, baseUrl: location.origin, reachability: "unknown" as const }, redemptions: [],
})));
let fixtureRequestState: string | null = null;
let questionState = new URLSearchParams(location.search).get("question") === "open" ? "open" : "answered";
const questionChannel = new URLSearchParams(location.search).get("questionChannel") ?? "general";
let approvalVersion = 1;
let approvalPending = true;
let questionVersion = 1;
let questionAnswer = "The controlled recovery checks passed.";
const questionProjection = () => ({ recordId: "fixture-question", kind: "question" as const, state: questionState,
  title: "Confirm the recovery behavior", updatedAt: questionVersion, settled: questionState === "closed",
  actorId: questionState === "open" ? "alex" : "maya", actorName: questionState === "open" ? "Alex" : "Maya",
  answer: questionState === "open" ? undefined : questionAnswer,
  actions: questionState === "open" && actorId === "alex" ? ["answer" as const] : questionState === "answered" && actorId === "maya" ? ["close" as const, "reopen" as const] : [],
});
const removedMembers = new Map<string, Set<string>>();
const api: ChatApi = {
  async presence(channelId, beat) {
    if (offline) throw new ChatApiError("Fixture disconnected", 503);
    fixturePresence.update(channelId, actorId, actorId === "alex" ? "Alex" : "Maya", false, beat);
    return { people: fixturePresence.read(channelId, new Set(["alex", "maya"])) };
  },

  async execution() {
    if (offline) throw new ChatApiError("Fixture disconnected", 503);
    return { available: true, sessionId: "fixture-session", sessionName: "Controlled Codex", turnId: `turn-${fixtureTurn}`, status: executionStopped ? "interrupted" : "streaming", interruptible: !executionStopped };
  },
  async interruptExecution(_channelId, _flightId, input) {
    if (offline || failNext) { failNext = false; throw new ChatApiError("Controlled interrupt uncertainty", 502); }
    if (input.turnId !== `turn-${fixtureTurn}` || executionStopped) throw new ChatApiError("Stale turn", 409);
    return { ok: true, status: "submitted" };
  },

  async approvals() {
    if (offline) throw new ChatApiError("Fixture disconnected", 503);
    return { available: new URLSearchParams(location.search).has("approvals"), sessionId: "fixture-session", approvals: new URLSearchParams(location.search).has("approvals") && approvalPending ? [{ sessionId: "fixture-session", sessionName: "Controlled Codex", adapterType: "echo", turnId: "fixture-turn", blockId: "fixture-action", version: approvalVersion, turnStartedAt: Date.now(), title: "Approve test command", description: "Run the controlled fixture check.", detail: "echo fixture-check", risk: "low", actionKind: "command", actionStatus: "awaiting_approval" }] : [] };
  },
  async decideApproval(_channelId, _flightId, change) {
    if (offline || failNext) { failNext = false; throw new ChatApiError("Controlled decision failure", 502); }
    if (change.version !== approvalVersion || !approvalPending) throw new ChatApiError("Approval changed", 409);
    approvalPending = false;
    return { ok: true, status: "submitted", decision: change.decision };
  },
  async uploadAttachments(_channelId, files) { return files.map(file => ({ id: `fixture-file-${file.name}`, mediaType: file.type, fileName: file.name, url: `/fixture-${file.name}` })); },
  async questionHistory(channelId, cursor) {
    if (offline) throw new ChatApiError("Fixture disconnected", 503);
    const rows = channelId === questionChannel ? Array.from({ length: 53 }, (_, index) => ({ ...questionProjection(), recordId: `resolved-${index}`, title: `Resolved decision ${index + 1}`, updatedAt: 1759276800000 + index * 86400000, state: index % 2 ? "declined" : "closed", settled: true, actorId: undefined, actorName: undefined, actions: [], answer: `Retained answer ${index + 1}: verified the recovery behavior.` })) : [];
    if (channelId === questionChannel && questionState === "closed") rows.unshift({ ...questionProjection(), actorId: undefined, actorName: undefined, actions: [] });
    const offset = Number(cursor ?? 0);
    return { questions: rows.slice(offset, offset + 50), nextCursor: rows.length > offset + 50 ? String(offset + 50) : null };
  },
  async questions(channelId, cursor) {
    if (offline) throw new ChatApiError("Fixture disconnected", 503);
    const params = new URLSearchParams(location.search);
    const rows = channelId === questionChannel && (params.has("questions") || params.has("responsibility")) && questionState !== "closed" ? [questionProjection()] : [];
    if (params.has("manyQuestions")) for (let index = 0; index < 54; index++) rows.push({ ...questionProjection(), recordId: `older-question-${index}`, title: `Older question ${index + 1}`, actions: [] });
    const offset = Number(cursor ?? 0);
    return { questions: rows.slice(offset, offset + 50), nextCursor: rows.length > offset + 50 ? String(offset + 50) : null };
  },
  async respondQuestion(_channelId, _questionId, change) {
    if (offline) throw new ChatApiError("Fixture disconnected", 503);
    if (change.expectedUpdatedAt !== questionVersion) throw new ChatApiError("Question changed", 409);
    if (!questionProjection().actions.includes(change.action as never)) throw new ChatApiError("Not your action", 403);
    questionState = change.action === "answer" ? "answered" : change.action === "close" ? "closed" : "open";
    if (change.answer) questionAnswer = change.answer;
    questionVersion += 1;
    return { ok: true, responsibility: questionProjection() };
  },
  async searchMessages(channelId, query, cursor) {
    if (offline) throw new ChatApiError("Fixture disconnected", 0);
    const found = messages[channelId]!.filter(message => message.body.toLowerCase().includes(query.toLowerCase())).sort((a, b) => b.createdAt - a.createdAt);
    const start = Number(cursor ?? 0);
    return { messages: found.slice(start, start + 10), nextCursor: start + 10 < found.length ? String(start + 10) : null };
  },
  async messageContext(channelId, messageId, _space, cursor) {
    if (offline) throw new ChatApiError("Fixture disconnected", 503);
    if (offline) throw new ChatApiError("Fixture disconnected", 0);
    const target = messages[channelId]!.find(message => message.id === messageId);
    if (!target) throw new ChatApiError("Message unavailable", 404);
    const rootMessageId = target.replyToMessageId ?? target.id;
    const replies = messages[channelId]!.filter(message => message.replyToMessageId === rootMessageId).sort((a, b) => a.createdAt - b.createdAt);
    const end = cursor ? Number(cursor) : replies.length;
    const start = Math.max(0, end - 20);
    const selected = [messages[channelId]!.find(message => message.id === rootMessageId)!, ...replies.slice(start, end), target];
    return { rootMessageId, messages: [...new Map(selected.map(message => [message.id, message])).values()], hasMore: start > 0, nextCursor: start > 0 ? String(start) : null };
  },
  async correctMessage(channelId, messageId, change) {
    if (offline) throw new ChatApiError("Fixture disconnected. Your changes have not been saved.", 0);
    const index = messages[channelId]!.findIndex(message => message.id === messageId);
    if (index < 0) throw new ChatApiError("Message unavailable", 404);
    try {
      const message = correctChatMessage(messages[channelId]![index]!, change, actorId, true, Date.now());
      messages[channelId]![index] = message;
      persist();
      return { ok: true, message };
    } catch (error) {
      if (error instanceof ChatMessageCorrectionError) throw new ChatApiError(error.message, error.status);
      throw error;
    }
  },
  async updatePins(channelId, change) {
    if (offline) throw new ChatApiError("Fixture disconnected", 0);
    const all = JSON.parse(localStorage.getItem(`${fixtureKey}.pins`) ?? "{}");
    const pins = applyChatPinChange(all[channelId], change, actorId, Date.now());
    all[channelId] = pins;
    localStorage.setItem(`${fixtureKey}.pins`, JSON.stringify(all));
    return { ok: true, pins };
  },
  async updateAttention(channelId, change) {
    if (offline) throw new ChatApiError("Fixture disconnected", 0);
    const all = JSON.parse(localStorage.getItem(`${fixtureKey}.attention`) ?? "{}");
    const key = JSON.stringify([actorId, channelId]);
    const preferences = applyChatAttentionPreferenceChange(all[key], change);
    all[key] = preferences;
    localStorage.setItem(`${fixtureKey}.attention`, JSON.stringify(all));
    return { ok: true, preferences };
  },
  async readState(channelId) {
    if (offline) throw new ChatApiError("Fixture disconnected", 0);
    const cursors = JSON.parse(localStorage.getItem(`${fixtureKey}.reads`) ?? "{}");
    const roots = new Set<string | null>([null, ...messages[channelId]!.filter((message) => message.replyToMessageId).map((message) => message.replyToMessageId!)]);
    const allPreferences = JSON.parse(localStorage.getItem(`${fixtureKey}.attention`) ?? "{}");
    return { channelId, actorId, pins: JSON.parse(localStorage.getItem(`${fixtureKey}.pins`) ?? "{}")[channelId] ?? [], preferences: readChatAttentionPreferences(allPreferences[JSON.stringify([actorId, channelId])]), lanes: [...roots].map((rootMessageId) => projectChatReadLane({
      actorId, rootMessageId,
      messages: messages[channelId]!.filter((message) => (message.replyToMessageId ?? null) === rootMessageId),
      cursor: cursors[JSON.stringify([actorId, channelId, rootMessageId])], pageLimit: 500,
    })) };
  },
  async markRead(channelId, input) {
    if (offline) throw new ChatApiError("Fixture disconnected", 0);
    const message = messages[channelId]!.find((row) => row.id === input.messageId && (row.replyToMessageId ?? null) === (input.rootMessageId ?? null));
    if (!message) throw new ChatApiError("Read position not found", 400);
    const key = JSON.stringify([actorId, channelId, input.rootMessageId ?? null]);
    const cursors = JSON.parse(localStorage.getItem(`${fixtureKey}.reads`) ?? "{}");
    const previous = cursors[key]?.metadata?.scoutReadBoundary;
    if (!previous || message.createdAt > previous.createdAt || (message.createdAt === previous.createdAt && message.id >= previous.id)) {
      cursors[key] = { conversationId: channelId, actorId, lastReadMessageId: message.id, lastReadAt: Date.now(), updatedAt: Date.now(), metadata: { scoutReadBoundary: { id: message.id, createdAt: message.createdAt } } };
      localStorage.setItem(`${fixtureKey}.reads`, JSON.stringify(cursors));
    }
    return { ok: true };
  },
  async bootstrap() {
    return { viewer: { actorId, displayName: actorId === "maya" ? "Maya" : "Alex", isOperator: !new URLSearchParams(location.search).has("member") },
      channels, questionCounts: (new URLSearchParams(location.search).has("questions") || new URLSearchParams(location.search).has("responsibility")) && questionProjection().actions.length ? { [questionChannel]: 1 } : {}, space: "home", spaces: [{ slug: "home", title: "Test workspace", conversationId: null, isDefault: true }] };
  },
  async feed(channelId) {
    if (offline) throw new ChatApiError("Fixture disconnected", 0);
    return { messages: [...messages[channelId]!].filter(message => !hideEarlier || (!message.replyToMessageId && Number(message.id.split("-").at(-1)) >= 25)).map(message => ({ ...message, reactions: reactionChips(message.id) })), requests: [...(postedRequests[channelId] ?? []), ...(new URLSearchParams(location.search).has("asks") ? [{
      messageId: `${channelId}-44`, flightId: "fixture-flight", state: fixtureRequestState ?? (new URLSearchParams(location.search).get("asks") || "queued"),
      targetActorId: "codex", targetName: "Codex", requesterActorId: "maya", requesterName: "Maya",
      ...(new URLSearchParams(location.search).has("responsibility") ? { responsibility: questionProjection() } : {}),
      summary: "Verified the draft and reconnect behavior.", output: new URLSearchParams(location.search).has("longOutcome") ? "Verified behavior.\n".repeat(250).slice(0, 4000) : "Draft recovery and recipient isolation checks passed.\nNo production messages were sent.",
      ...(new URLSearchParams(location.search).has("longOutcome") ? { outputTruncated: true, outputUrl: `/api/channels/${channelId}/asks/fixture-flight/output` } : {}),
    }] : [])] };
  },
  async removeMember(channelId, targetActorId) {
    if (offline) throw new ChatApiError("Fixture disconnected. Membership has not changed.", 503);
    if (new URLSearchParams(location.search).has("member")) throw new ChatApiError("Owner required", 403);
    const removed = removedMembers.get(channelId) ?? new Set<string>();
    removed.add(targetActorId);
    removedMembers.set(channelId, removed);
    return { ok: true };
  },
  async members(channelId) { return { channelId, authoritative: true, members: members.filter((member) => (agentAvailable || member.actorId !== "codex") && !removedMembers.get(channelId)?.has(member.actorId)) }; },
  async postMessage(channelId, input) {
    if (limitNext) { limitNext = false; throw new ChatApiError("You are sending too quickly. Wait 1 second and try again; your draft is preserved.", 429, "space_request_limit"); }
    if (delayNext) {
      delayNext = false;
      await new Promise<void>((resolve) => { releaseSend = resolve; });
    }
    if (failNext || offline) {
      failNext = false;
      throw new ChatApiError("Controlled send failure. Your draft is still here.", 503);
    }
    const existing = messages[channelId]!.find((message) => message.id === input.requestId);
    if (existing) return { message: existing };
    const message: ChatMessage = { id: input.requestId, actorId, body: input.body,
      attachments: input.attachments,
      mentions: input.mentionActorIds?.map(actorId => ({ actorId })),
      class: "agent", createdAt: Date.now(), replyToMessageId: input.replyToMessageId };
    messages[channelId]!.push(message);
    persist();
    if (loseNextAcknowledgement) { loseNextAcknowledgement = false; throw new ChatApiError("Message stored, but its acknowledgement was lost. Retry safely.", 503); }
    return { message };
  },
  async postAsk(channelId, input) {
    const result = await api.postMessage(channelId, input);
    const request: TrackedRequest = { messageId: result.message.id, flightId: `fixture-${input.requestId}`, state: "running", targetActorId: input.targetActorId };
    postedRequests[channelId] = [...(postedRequests[channelId] ?? []).filter(item => item.flightId !== request.flightId), request];
    persist();
    return { ...result, request };
  },
  async spaces() { return { spaces: [] }; },
  async me() { return { member: null }; },
  createSpace: unavailable, createChannel: unavailable, signOut: unavailable,
  async cancelAsk(channelId, flightId) {
    if (offline) throw new ChatApiError("Disconnected", 503);
    if (new URLSearchParams(location.search).get("asks") !== "queued") throw new ChatApiError("This request has already started. Chat cannot stop its active session yet. Its status has not been changed.", 409);
    fixtureRequestState = "cancelled";
    return { ok: true, replayed: false, request: { messageId: `${channelId}-44`, flightId, state: "cancelled", targetActorId: "codex" } };
  },
  async addReaction(channelId, input) { return changeReaction(channelId, input.messageId, input.emoji, false); },
  async removeReaction(channelId, input) { return changeReaction(channelId, input.messageId, input.emoji, true); },
  async invites(channelId) {
    if (offline) throw new ChatApiError("Fixture disconnected", 503);
    return { invites: fixtureInvites.filter(invite => invite.channelId === channelId) };
  },
  createInvite: unavailable,
  async revokeInvite(channelId, inviteId) {
    if (offline) throw new ChatApiError("Fixture disconnected", 503);
    if (new URLSearchParams(location.search).has("member")) throw new ChatApiError("Owner required", 403);
    const invite = fixtureInvites.find(invite => invite.id === inviteId && invite.channelId === channelId);
    if (!invite) throw new ChatApiError("Invitation missing", 404);
    invite.state = "revoked";
    return { ok: true, invite };
  },
  invitePreview: unavailable, joinInvite: unavailable,
};
const capabilities = { ...LOCAL_CHAT_CAPABILITIES, liveStream: false, inviteList: false,
  inviteKinds: [], inviteRevoke: false, channelCreate: false, spaceCreate: false,
  attachments: new URLSearchParams(location.search).has("attachments"), reactions: true, signOut: false };
const hosted = new URLSearchParams(location.search).has("hosted");
if (hosted) installHostedFixtureWire(api);
const surfaceApi = hosted ? createHostedChatApi() : api;
const surfaceCapabilities = hosted ? { ...HOSTED_CHAT_CAPABILITIES, attachments: capabilities.attachments, spaceCreate: false, channelCreate: false, inviteKinds: [], signOut: false } : capabilities;
const address = createQueryChatAddress("home");
function Fixture() {
  const [generation, setGeneration] = useState(0);
  const [notice, setNotice] = useState("Ready — all records are test fixtures");
  const remount = () => setGeneration((value) => value + 1);
  const addMessage = () => {
    const channelId = address.read().channelId ?? "general";
    messages[channelId]!.push({ id: `arrival-${Date.now()}`, actorId: "alex", body: "New arrival while you were reading earlier messages.\n\n" + "A substantial update to test tail following. ".repeat(20), class: "agent", createdAt: Date.now() });
    persist();
    document.dispatchEvent(new Event("visibilitychange"));
    setNotice("New arrival added; the regular feed poll will pick it up");
  };
  return <>
    <div style={{ position: "fixed", top: 0, left: 0, right: 0, zIndex: 9999, maxHeight: 76, overflow: "auto", background: "#fff", color: "#111", padding: 8, display: "flex", gap: 8, flexWrap: "wrap", font: "12px system-ui" }}>
      <strong>Test fixture</strong>
      {new URLSearchParams(location.search).has("fileStoreTest") ? <button onClick={async () => {
        const scope = `fixture-recovery-${crypto.randomUUID()}`;
        const first = new File(["first bytes"], "first.md", { type: "text/markdown", lastModified: 123 });
        const second = new File(["second bytes"], "second.md", { type: "text/markdown" });
        try {
          await updateComposerFiles(scope, [first], []);
          const sameCapture = new File(["first bytes"], "first.md", { type: "text/markdown", lastModified: 123 });
          await Promise.all([updateComposerFiles(scope, [first], []), updateComposerFiles(scope, [sameCapture], [])]);
          const copies = await readComposerFiles(scope);
          if (copies.length !== 1 || composerFileId(first) !== composerFileId(sameCapture)) throw new Error("Concurrent same-file staging duplicated the capture");
          const restored = copies[0]!;
          if (await restored.text() !== "first bytes" || restored.name !== first.name || restored.lastModified !== 123 || composerFileId(restored) !== composerFileId(first)) throw new Error("Restored content or identity mismatch");
          if ((await readComposerFiles(`${scope}-other`)).length) throw new Error("Scope leaked");
          await updateComposerFiles(scope, [second], []);
          const ordered = await readComposerFiles(scope);
          if (ordered.map(composerFileId).join() !== [first, second].map(composerFileId).join()) throw new Error("Attachment order changed");
          await updateComposerFiles(scope, [], [restored]);
          const retained = await readComposerFiles(scope);
          if (retained.length !== 1 || composerFileId(retained[0]!) !== composerFileId(second)) throw new Error("Late removal erased a newer attachment");
          setNotice("File recovery checks passed: bytes, metadata, identity, order, scope isolation, late removal, concurrent duplicate staging");
        } catch (error) { setNotice(`File recovery check failed: ${String(error)}`); }
        finally { await updateComposerFiles(scope, [], [first, second]); }
      }}>Check file recovery</button> : null}
      {new URLSearchParams(location.search).has("keyboard") ? <button onClick={async () => {
        const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        const trigger = document.querySelector<HTMLButtonElement>(".chat-jump")!;
        const check = (ok: boolean, label: string) => { if (!ok) throw new Error(label); };
        try {
          trigger.focus(); trigger.click(); await frame();
          const input = document.querySelector<HTMLInputElement>(".chat-palette input")!;
          const options = [...document.querySelectorAll<HTMLButtonElement>(".chat-palette-option")];
          check(document.activeElement === input, "initial focus");
          input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
          check(document.activeElement === options.at(-1), "reverse Tab containment"); await frame();
          options.at(-1)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
          check(document.activeElement === input, "forward Tab containment"); await frame();
          const activeBefore = options.findIndex(option => option.id === input.getAttribute("aria-activedescendant"));
          check(activeBefore >= 0, "focused option association");
          input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })); await frame();
          check(input.getAttribute("aria-activedescendant") === options[(activeBefore + 1) % options.length]?.id, "ArrowDown advances the active result");
          options[1]!.focus();
          options[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await frame();
          check(!document.querySelector(".chat-palette") && document.activeElement === trigger, "Escape and focus restoration");
          trigger.click(); await frame();
          // HTMLElement.click models the activation emitted by a native button's
          // Enter/Space action; no mouse-down event is dispatched here.
          document.querySelectorAll<HTMLButtonElement>(".chat-palette-option")[1]!.click(); await frame();
          check(!document.querySelector(".chat-palette") && location.search.includes("channel=release"), "button activation");
          setNotice("Keyboard checks passed: initial focus, Tab boundaries, active result, Escape, restore, activation");
        } catch (error) { setNotice(`Keyboard check failed: ${String(error)}`); }
      }}>Check picker keyboard</button> : null}
      {new URLSearchParams(location.search).has("approvals") ? <button onClick={() => { approvalVersion++; approvalPending = true; setNotice(`Approval version ${approvalVersion}`); }}>New approval version</button> : null}
      {new URLSearchParams(location.search).has("attachments") ? <button onClick={() => {
        const clipboardData = new DataTransfer();
        clipboardData.items.add(new File(["Controlled attachment content"], `review-${Date.now()}.md`, { type: "text/markdown" }));
        document.querySelector(".chat-composer-input")?.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
      }}>Attach test notes</button> : null}
      <button onClick={() => { actorId = actorId === "maya" ? "alex" : "maya"; persist(); remount(); }}>Switch person</button>

      <button onClick={() => { const peer = actorId === "alex" ? "maya" : "alex"; fixturePresence.update("general", peer, peer === "alex" ? "Alex" : "Maya", false, { clientId: "peer", sequence: ++peerSequence, active: true, typing: true }); setNotice("Peer typing signal sent"); }}>Peer starts typing</button>
      <button onClick={() => { const peer = actorId === "alex" ? "maya" : "alex"; fixturePresence.update("general", peer, peer === "alex" ? "Alex" : "Maya", false, { clientId: "peer", sequence: ++peerSequence, active: false, typing: false }); setNotice("Peer left"); }}>Peer leaves</button>
      <button onClick={() => { fixtureTurn++; executionStopped = false; setNotice("New execution turn"); }}>New execution turn</button>
      <button onClick={() => { executionStopped = true; setNotice("Observed interrupted turn"); }}>Observe interrupted turn</button>
      <button onClick={() => { limitNext = true; setNotice("Next send will be rate limited"); }}>Limit next send</button>
      <button onClick={() => { loseNextAcknowledgement = true; setNotice("Next send acknowledgement will be lost"); }}>Lose next acknowledgement</button>
      <button onClick={() => { failNext = true; setNotice("Next send will fail"); }}>Fail next send</button>
      <button onClick={() => { delayNext = true; setNotice("Next send waits for Release send"); }}>Delay next send</button>
      <button onClick={() => { releaseSend?.(); releaseSend = null; }}>Release send</button>
      <button onClick={addMessage}>Add incoming message</button>
      <button onClick={() => { offline = !offline; setNotice(offline ? "Offline" : "Reconnected"); }}>Toggle connection</button>
      <button onClick={() => { agentAvailable = !agentAvailable; document.dispatchEvent(new Event("visibilitychange")); }}>Toggle agent availability</button>
      <button data-fixture="read-earlier" onClick={() => {
        document.querySelector('.chat-feed [data-message-id$="-12"]')?.scrollIntoView({ block: "start" });
      }}>Read earlier</button>
      <button data-fixture="inspect-reading" onClick={() => {
        const feed = document.querySelector<HTMLElement>(".chat-feed")!;
        const top = feed.getBoundingClientRect().top;
        const first = [...feed.querySelectorAll<HTMLElement>("[data-message-id]")].find((item) => item.getBoundingClientRect().bottom > top);
        setNotice(JSON.stringify({ anchor: first?.dataset.messageId, offset: Math.round((first?.getBoundingClientRect().top ?? top) - top), top: Math.round(feed.scrollTop), tail: Math.round(feed.scrollHeight - feed.scrollTop - feed.clientHeight) }));
      }}>Inspect reading</button>
      <button data-fixture="add-reply" onClick={() => {
        const channelId = address.read().channelId ?? "general";
        messages[channelId]!.push({ id: `reply-${Date.now()}`, actorId: "alex", body: "A thread reply needing your attention.", replyToMessageId: `${channelId}-12`, class: "agent", createdAt: Date.now(), mentions: [{ actorId: "maya" }] });
        persist();
        document.dispatchEvent(new Event("visibilitychange"));
        setNotice("Unread thread reply added with a structured mention for Maya");
      }}>Add thread reply</button>
      <button data-fixture="concurrent-edit" style={{ order: 20 }} onClick={() => {
        const index = messages.general!.findIndex(message => message.id === "general-12");
        const message = messages.general![index]!;
        const revision = (message.metadata?.chatCorrection as { revision?: number } | undefined)?.revision ?? 0;
        messages.general![index] = correctChatMessage(message, { expectedRevision: revision, body: "Newer version from another device." }, message.actorId, false, Date.now());
        persist();
      }}>Concurrent edit</button>
      {new URLSearchParams(location.search).has("asks") ? <button data-fixture="review-ask" onClick={() => document.querySelector(".chat-ask-card")?.scrollIntoView({ block: "center" })}>Review tracked request</button> : null}
      <span role="status">{notice}</span>
    </div>
    <div style={{ paddingTop: 48 }}>
      <ChatTransportProvider api={surfaceApi} capabilities={surfaceCapabilities} address={address}>
        <ChatSpaceSurface key={generation} />
      </ChatTransportProvider>
    </div>
  </>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>);
