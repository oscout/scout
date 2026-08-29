# Studio → App level-up brief (comms + inspectors)

_Fresh Claude review, 2026-06-21. Scope: how the four scout-* studies should level up the live app. No broad rewrite — this is a today-actionable brief._

Reviewed: `design/studio/lib/studio-pages.ts`, the four study pages, `packages/web/client/screens/chat/*`, `packages/web/client/screens/agents/*`, `apps/macos/Sources/Scout/ScoutCommsView.swift` + `ScoutRootView.swift`.

---

## 1. Source-of-truth vs exploratory

These four are **not variants of one surface** — they cover two real surfaces (comms, channels) plus one cross-cutting grammar.

| Study | Status (registry) | Verdict |
|---|---|---|
| **scout-comms** | `in-flight`, **primary** of `scout-surfaces` family | **CANONICAL** comms source-of-truth. Self-labels "the implementation spec," source-links the live Swift file, ships a real `DataContract` (`unreadCount`, `askState` on `ScoutChannel`). Follow it for the DM/thread surface. |
| **scout-inspectors** | `draft`, variant in `scout-macos-shell` | **CANONICAL inspector grammar** (different axis — the inspector pattern across all surfaces, not a comms screen). Written in the locked "Instrument" language. Already partially ported into the app (see §3). This is the study Arach is viewing. |
| **scout-comms-inspector** | `draft`, primary of its own family | **EXPLORATORY proposal**, least settled. It's a deliberation doc (variants/pros-cons/open-questions), and it links to two studies that **do not exist** (`/studies/inspector-system`, `/studies/inspector-grammar`) for its grammar — those are phantom references; the real inspector grammar is **scout-inspectors**. Keep its *decisions* (primary action = "Open", Ask as its own block, always-visible rail), discard its dead links. |
| **scout-comms-channels** | `draft`, mis-filed under `scout-comms-inspector` family | **EXPLORATORY sibling** (group/channels surface in the sprite-identity language). Real, but its sprite system collides with a shipped reality (initials today) and its left-accent-rule treatment is contraindicated by a recorded design ban. Lowest priority. |

**One-line:** scout-comms + scout-inspectors are the two you build to. scout-comms-inspector is a proposal to mine for decisions. scout-comms-channels is a someday-sibling.

---

## 2. Surface map — where the work happens

There are **two live implementations**, both wired to real broker data (no mocks):

- **Web client** — `packages/web/client/screens/chat/*` (comms) and `screens/agents/*` (agents). Three-slot architecture: `left.tsx` (rail) / `content.tsx` (dispatcher) / `right.tsx` (inspector).
- **macOS app** — `apps/macos/Sources/Scout/ScoutCommsView.swift` (list/rows/thread rows) + `ScoutRootView.swift` (shell, header, composer, all inspectors), data via `ScoutCommsStore`/`ScoutCommsClient`.

Important asymmetry to know before assigning work:

- **macOS is AHEAD of web on scout-comms fidelity**: it already ships recency time-groups (`groupedChannels`/`RecencyBucket`), the list-row pending-ask chip (`pendingChip`), the pinned-ask band (`ScoutPinnedAskBand`), and long-turn collapse. **Web groups by project, not time, has no row ask-chip, and its pinned-ask is dead-disabled.**
- **Web is AHEAD of macOS on the inspector grammar**: `agents/right.tsx` already ported the scout-inspectors "Instrument kit" (`Section`/`StatRow`/`PillList`/`EmptyLine`). macOS and the web *chat* inspector have not.

| Study | Web target | macOS target |
|---|---|---|
| scout-comms (thread/list) | `chat/left.tsx`, `chat/ConversationScreen.tsx`, `chat/conversation-model.ts` | `ScoutCommsView.swift` (`ScoutConversationRow`, `ScoutMessageRow`), `ScoutRootView.swift` (`chatHeader`) |
| scout-inspectors (grammar) | `chat/right.tsx` (adopt kit from `agents/right.tsx`) | `ScoutChannelInspector`, `ScoutAgentInspector` in `ScoutRootView.swift` |
| scout-comms-inspector (decisions) | `chat/right.tsx` Ask block | `ScoutChannelInspector` (`ScoutRootView.swift` ~5425) |
| scout-comms-channels | `chat/ChannelsScreen.tsx` | `ScoutConversationRow` facepile; `ScoutMemberStrip` (dead, ~`ScoutCommsView.swift:1045`) |

---

## 3. Shipped vs Studio-only

**Already shipped (do NOT rebuild):**
- Real data plumbing everywhere; the `unreadCount`/`ask`/`ScoutAskState` data contract is fully present on `ScoutChannel` (`ScoutAppCore/ScoutCommsModels.swift`).
- macOS: recency groups, filters, unread emphasis, row pending-ask chip, pinned-ask band, long-turn collapse, in-flight turn preview, rich agent inspector (sparkline/context gauge/files-changed/sessions/runtime/skills — exceeds the study), agent tree, hover card.
- Web: full chat list + thread + composer (slash/mention autocomplete, dictation), channels with member roster, working-turn live card, and the **agents inspector already in the scout-inspectors grammar** (`agents/right.tsx:333` comment: _"signed-off vocabulary … to be lifted into a shared inspector kit as the other inspectors adopt it"_).

**Studio-only / not yet shipped (the real gaps):**
1. **Resolved ask reply-context backlink** — missing in BOTH platforms. The `[ask:<flightId>]` tag stays raw in the body; the study's headline feature (clickable "reply to · title · from · working/done") is unbuilt.
2. **Web pinned-ask is dead code** — `ConversationScreen.tsx:679-683`, both branches `return null`. macOS already ships the band; web parity is missing.
3. **Chat inspector hasn't adopted the signed-off grammar** — web `chat/right.tsx` still uses legacy `ctx-panel-*` CSS; macOS `ScoutChannelInspector` is three plain cards. Neither uses the scout-inspectors `Section`/KV kit that `agents/right.tsx` proved out.
4. **Channel inspector lacks Conversation/Project/Ask blocks** (scout-comms-inspector decisions) — macOS `ScoutChannelInspector` has scope/handle/members only.
5. **Web comms list groups by project, not time** — no recency buckets, no row ask-chip (macOS has both).
6. Lower-value: thread-header sub-line + Observe/Message actions (macOS `chatHeader` is handle-only); channel facepile (`ScoutMemberStrip` is dead code); sprite identity for channels.

---

## 4. Next changes for Codex — ranked (value × low-risk)

### #1 — Resolved ask reply-context backlink (both platforms)
Highest user-visible value: it's the headline of the canonical scout-comms study and the single biggest *shared* gap. When agents answer each other's asks, the `[ask:<id>]` tag is currently opaque; resolving it to a clickable backlink with live status is a real comprehension win. Data is already available (flights API / `ScoutChannelAsk`), so risk is contained.
- **Web:** parse `[ask:<flightId>]` in `conversation-model.ts`, resolve against the flights data already fetched in `ConversationScreen.tsx` (`GET /api/flights?conversationId=…`), render the backlink chip in `ConversationScreen` turn rendering. Match the study's `replyCtx` treatment (accent on hover only).
- **macOS:** extend `ScoutMessageRow.custodyLabel` (`ScoutCommsView.swift` ~1220) from plain text to the resolved-ask backlink using `store.activeTurn`/flights + `ScoutChannelAsk`.
- _Verify first:_ confirm flight metadata includes the ask title/state at the message's `cId`.

### #2 — Re-enable the web pinned-ask band (web; quick parity win)
Lowest-risk meaningful change. macOS already ships `ScoutPinnedAskBand`; the web equivalent (`PinnedAskCard` in `chat/ConversationStatus.tsx`) exists but `pinnedAsk` is hard-disabled at `ConversationScreen.tsx:679-683`. Wire the memo to return the real pending `FleetAsk` (from `useFleetActiveAsks()` / the flights fetch) instead of `null`, and render `PinnedAskCard`. Pairs naturally with #1.

### #3 — Lift the scout-inspectors kit into a shared module + adopt in chat inspector
This is the study Arach is viewing, and the path is already signed off in code. The kit lives inline in `agents/right.tsx` (`Section`/`StatRow`/`PillList`/`EmptyLine`, `--scout-chrome-*` tokens). 
- Extract those into a shared module (e.g. `packages/web/client/scout/inspector/kit.tsx`), re-import in `agents/right.tsx` (no behavior change), then **rebuild `chat/right.tsx` (`ConversationInspector`) on the kit**, replacing the legacy `ctx-panel-*` cards. Use the scout-comms-inspector *decisions* for the chat-specific blocks (Identity → "Open" action → Conversation KV → Project → Ask).
- Low-medium risk: it's a port of signed-off code, not new design. Do the extract as a pure refactor first (verify agents inspector unchanged), then adopt in chat.

### #4 — macOS channel inspector: add Conversation / Project / Ask blocks
`ScoutChannelInspector` (`ScoutRootView.swift` ~5425) currently shows scope/handle/members. Add the scout-comms-inspector blocks: Conversation (Last / Unread / Channel KV via `ScoutInspectorKVRow`), Project (Repo/Branch/Path), and a dedicated **Ask** block (state chip + from + text) — the study argues Ask belongs in the inspector, not just the list chip. Data already on `ScoutChannel`. Low risk, self-contained.

### #5 — Web comms list: recency time-groups + row ask-chip (match macOS + scout-comms)
Bring `chat/left.tsx` to parity with the canonical study (and with macOS): group by Now/Today/Earlier using `lastMessageAt`, and add the quiet pending-only ask chip on the row name. Low risk; macOS `groupedChannels`/`pendingChip` is the reference implementation to mirror.

**Suggested today-slice:** #1 + #2 together (the ask story, both deliver visible value), then #3 as a clean refactor-then-adopt. #4/#5 are good follow-ons but optional for today.

---

## 5. Exact edit targets

**Web**
- `packages/web/client/screens/chat/conversation-model.ts` — parse/resolve `[ask:<flightId>]` (#1).
- `packages/web/client/screens/chat/ConversationScreen.tsx` — render backlink chip (#1); fix `pinnedAsk` memo at **lines 679-683** + render `PinnedAskCard` (#2).
- `packages/web/client/screens/chat/ConversationStatus.tsx` — `PinnedAskCard` (#2 consumer).
- `packages/web/client/screens/agents/right.tsx` — kit lives at **lines 333-336+** (`Section`/`StatRow`/`PillList`/`EmptyLine`); extract (#3).
- `packages/web/client/screens/chat/right.tsx` — `ConversationInspector`, rebuild on kit (#3).
- `packages/web/client/screens/chat/left.tsx` — recency groups + row ask-chip (#5).

**macOS**
- `apps/macos/Sources/Scout/ScoutCommsView.swift` — `ScoutMessageRow.custodyLabel` (~1220) backlink (#1); `ScoutConversationRow`/`ScoutMemberStrip` (~1045, dead) for later facepile work.
- `apps/macos/Sources/Scout/ScoutRootView.swift` — `chatHeader` (~1106) sub-line/actions (lower priority); `ScoutChannelInspector` (~5425) Conversation/Project/Ask blocks (#4); `ScoutInspectorKVRow` (~3476) is the block primitive.
- `apps/macos/Sources/ScoutAppCore/ScoutCommsModels.swift` — `ScoutChannel` / `ScoutChannelAsk` / `ScoutAskState` (data already present; reference, not edit).
- Reminder: `bun bin/openscout-menu.ts restart` after Swift edits, not just `swift build`.

---

## Could-not-verify / caveats
- Line numbers for macOS symbols are from agent inspection; confirm with a quick grep before editing (the files are large and churn).
- #1 assumes flight/ask metadata (title + state) is resolvable from the `[ask:<flightId>]` id at render time — verify the flights payload carries it before building the resolver.
- scout-comms-inspector's "always-visible vs pop vs toggle" question is unsettled in the study; the app already defaults to a persistent collapsible inspector, so treat "always-visible" as decided and skip that debate.
