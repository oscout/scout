# Comms threads — implementation brief (macOS reply-to + sub-threads)

_Claude spec for Codex, 2026-07-06. Scope: implement the signed-off studio study `/studies/scout-comms-threads` in the native macOS Comms surface, in two strictly ordered phases. Phase 1 is client-side plus one route param. Phase 2 is server-first; its UI must not ship before its server fields are live._

Design source of truth: `design/studio/views/scout-comms-threads.tsx` (three treatments: Current / Reply-to / Sub-thread, plus the data-contract table). Grammar rules that bind the port: avatar-led turns (no bubbles), 0.5pt hairlines (`HudStrokeWidth.thin`), one accent only (no categorical status color), no emoji (geometric marks), and **no left accent-bar on rounded elements** — the hairline chain rail is legal because the stream is a flat region; the composer reply band lives inside the rounded well as a full-width band, never a left edge.

Key files:

- macOS: `apps/macos/Sources/Scout/ScoutRootView.swift` (`messageList` ~:1578, composer ~:1694), `ScoutCommsView.swift` (`ScoutMessageRow` ~:1273, context menu ~:1312, `custodyLabel` ~:1470), `ScoutCommsStore.swift` (`send` ~:319), `apps/macos/Sources/ScoutAppCore/ScoutCommsModels.swift` (`ScoutMessage` ~:223), `ScoutCommsClient.swift` (`send` ~:44)
- Server: `packages/web/server/create-openscout-web-server.ts` (`POST /api/send` :5560), `packages/web/server/core/broker/service.ts` (`sendScoutConversationMessage` ~:2131, `sendScoutConversationSteer` ~:2228 — **both already accept `replyToMessageId`**)
- Schema (already exists, do not migrate): `packages/runtime/src/schema.ts` — `messages.reply_to_message_id`, `messages.thread_conversation_id` (~:174–189); `conversations.parent_conversation_id`, `conversations.message_id` (~:153–165)

---

## Phase 1 — Reply-to (ship first, independently)

Reply becomes an affordance instead of a mono custody caption. Everything here is backed today except the send-path plumbing.

### 1.1 Server: pass `replyToMessageId` through `/api/send`

In the `POST /api/send` handler (create-openscout-web-server.ts:5560): add `replyToMessageId?: string` to the body destructure/type, validate it as an optional non-empty string, and forward it into **both** the `sendScoutConversationMessage` and `sendScoutConversationSteer` calls in the `routedConversationId` branch. Do not touch the scoutbot branch — the existing `threadId` param there is the **scoutbot thread registry** (`scoutbot/thread-map.ts`), a different concept entirely; do not overload or rename it.

### 1.2 macOS store + client

`ScoutCommsStore`: add `@Published var replyTarget: ScoutMessage?`. In `send(_:images:)` (~:319), when `replyTarget` is set include `"replyToMessageId": replyTarget.id` in the payload dict, and clear the target after a successful send (also clear it on conversation switch). Mirror the key in `ScoutCommsClient.send(body:cId:)` (~:44) so both send paths carry it.

### 1.3 macOS UI: Reply affordance + composer chip

- **Context menu**: add "Reply" to `ScoutMessageRow`'s menu (ScoutCommsView ~:1312), above "New chat from this message…". It sets `store.replyTarget`. Optionally also a hover action, but the context menu is the required minimum.
- **Composer reply band**: when `replyTarget != nil`, render a flat band inside the composer well, above the text field: reply glyph · mono micro-caps `REPLYING TO` · author — first ~60 chars of the target body · trailing `×` clear button. Accent-soft tint background, hairline bottom border. This is a band inside the rounded well — the well continues to signal active via its border, not a left edge.
- Esc clears the reply target before it clears/blurs the composer.

### 1.4 macOS rendering: chain gathering

Replace pure-chronological rendering in `messageList` (ScoutRootView ~:1578) with:

1. Resolve each message's **chain root** by following `replyToMessageId` transitively upward until a message with no reply target (or a target not in the loaded window). Cycle-guard with a visited set.
2. **Gather rule (Rule A)**: a reply is pulled into a chain block under its root **only if its parent is not the immediately preceding rendered message**. Adjacent replies stay inline — plain adjacency already reads as a reply, and this keeps existing conversations (whose first agent turn replies to the seed message, which is adjacent) rendering exactly as today.
3. A chain block renders directly below its root turn: members chronological, **flat within the block regardless of reply depth** (one visual level), behind a hairline left rail indented to the root's content edge (rail = `--s-hairline-strong` equivalent, i.e. `ScoutPalette` hairline — never accent).
4. **Fallback**: if a message's reply target is not in the loaded window (pagination — `fetchMessages` has a `limit`), keep today's custody caption (`custodyLabel`) for that message and render it inline chronologically. The caption is retired *only* for messages that actually gather.
5. Exclude `messageClass == "status"` and system rows from gathering — they stay inline chronological. The in-flight turn row (`ScoutInFlightTurnRow`) and bottom sentinel are untouched.
6. The ask-correlation metadata path (`metadata.sourceMessageId` / `parentScoutbotTurnId`, `completesPendingConversation`) is read-only correlation logic — leave it intact.

### 1.5 Before locking the render rule: probe live data

Fetch `/api/messages` for a handful of real conversations (long agent sessions, ask/answer flows, scoutbot) and measure how often `replyToMessageId` is set and where it points. Acceptance depends on it: **a conversation where many turns reply to the same seed message must not collapse into one giant chain** — Rule A should already prevent the known cases (seed-reply is adjacent), but verify against real data and flag anything that still degenerates rather than shipping a cap heuristic silently.

### Phase 1 acceptance

- Send with a reply target set → the message row lands with `replyToMessageId` persisted (verify via `/api/messages`) and, when non-adjacent, gathers under its parent.
- Existing conversations render visually unchanged except where genuine non-adjacent replies exist (spot-check ≥3 real conversations before/after).
- Reply target survives composer typing, clears on send / Esc / conversation switch.
- Parent-outside-window renders with custody caption, no crash, no misgrouping.
- Adversarial cases to reproduce, not just unit-test: reply chain crossing a pagination boundary; reply to a deleted/missing id; self-referential or cyclic `replyToMessageId` data; two replies racing into the same parent between polls.

---

## Phase 2 — Sub-threads (server first, UI gated on it)

A thread is an **anchored child conversation**: `conversations.parent_conversation_id` + `conversations.message_id` point at the parent conversation and anchor message. Because it is a real conversation it can carry its own agent session — a scoped side question that doesn't pollute the main context. **Do not build any macOS thread UI until 2.1–2.3 are live** (no unbacked affordances).

### 2.1 Server: create anchored child conversations

Extend the conversation-creation path so a child can be minted with parent linkage:

- `POST /api/sessions`: when `seed.fromMessageId` + `seed.fromConversationId` are present, set `parent_conversation_id` + `message_id` on the minted conversation (this folds "New chat from this message…" into anchoring — delta ③ of the study; seeding behavior is unchanged).
- A lighter same-agent path for "Start thread" without a new session: minting a child conversation on the existing agent's session. Reuse whatever the broker exposes for conversation minting; if only the session path exists today, phase 2 can ship with threads-as-new-sessions first — note which in the PR.
- When a turn lands in a child conversation, populate `messages.thread_conversation_id` on the anchor-side write if the broker write path supports it; otherwise the conversations table alone is the source of truth (summaries are computed, below).

### 2.2 Server: expose linkage on the channels payload

Add `parentConversationId?: string` and `anchorMessageId?: string` to the `/api/comms` (and `/api/conversations`) channel payload, read from the conversations row. **The server must NOT suppress child conversations from the payload** — older clients (iOS, web) still need to see them; suppression is a client-side filter.

### 2.3 Server: `threadSummary` on messages

For each message in a `/api/messages` response that anchors ≥1 child conversation, attach `threadSummary: { count: number, participants: string[], lastActiveAt: number }` (message count across children, distinct participant display handles, latest message timestamp). Computed server-side from the conversations + messages tables — the client must not fetch child conversations to draw a stub.

### 2.4 macOS UI (after 2.1–2.3 are deployed)

- `ScoutMessage` decodes `threadSummary`; `ScoutChannel` decodes `parentConversationId` + `anchorMessageId`.
- **List filter**: channels with `parentConversationId != nil` are excluded from the top-level conversation list (this removes the orphan-row problem the study's Current treatment shows).
- **Stub row** under an anchor turn: overlapping small avatars (existing sprite/initial idiom, ~16px) · `N replies` in accent · mono `· participants · last <t>` · disclose control. Click toggles inline expansion.
- **Expanded rail**: hairline left rail, compact turns (smaller avatar, same turn grammar), mini composer at the bottom posting to the child cId via the existing `/api/send` path. Read-cursor advance fires for the child conversation on expand.
- **Context menu**: "Start thread" on turns; "New chat from this message…" keeps its label but now produces an anchored child (server does this automatically once 2.1 lands — no client branching).

### Phase 2 acceptance

- Starting a thread from a message creates a conversation with correct `parent_conversation_id`/`message_id`; the parent's message shows a stub with accurate count/participants/recency; the top-level list does not grow a row.
- A reply in the rail round-trips: posts to the child cId, stub summary updates on next poll, unread accounting stays sane (child unread must not double-count into the parent).
- Legacy: conversations created before this change (no linkage) render exactly as today; a child whose parent conversation was deleted degrades to a visible top-level conversation (never invisible/orphaned data).
- Adversarial: anchor message outside the loaded message window (stub must still render when the anchor loads later, and nothing crashes when it hasn't); deep nesting attempts (thread-on-a-thread — either flatten to the root parent or hide "Start thread" inside rails; pick one and state it in the PR); concurrent thread creation from two clients on the same anchor.

---

## Out of scope

- Web client rendering of threads (macOS first; web follows the same payload).
- Session fork/clone (`execution.session: "fork"`) — separate track, web-first.
- The scoutbot thread registry (`scoutbotThreadId`, `/api/scoutbot/threads`) — unrelated concept, leave untouched.
- Any change to ask/flight correlation (`[ask:<flightId>]`, `metadata.sourceMessageId`, `completesPendingConversation`).

Build check: `bun bin/scout-app.ts dev-build` (plain `swift build` fails — HudsonVoice is env-gated). Server tests colocated in `packages/web/server/*.test.ts`; use `./node_modules/.bin/tsc`, never `npx tsc`.
