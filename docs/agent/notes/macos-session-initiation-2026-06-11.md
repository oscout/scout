# Spec: New-conversation initiation for Scout macOS

**Date:** 2026-06-11
**Status:** spec — UX + functionality, ready to be broken into implementation work
**Scope:** `apps/macos` (Scout target; HUD entry point as a later phase)

## Background

The network layer is already done. `SessionInitiationSpec` in
`Sources/Scout/ScoutSessionService.swift` fully mirrors `POST /api/sessions`:
target (agentId/projectPath), execution (harness/model/session/targetSessionId),
agent (persistence/name/displayName), seed (instructions/fromMessageId/
fromConversationId). The composer (`ScoutSessionComposer`) and three entry
points exist in `ScoutRootView`:

| Entry point | Today |
|---|---|
| `startNewConversation()` | project target, best-guess `defaultProjectPath`, no picker |
| `startConversationFromMessage(_:agent:)` | seeds instructions + fromMessageId/CId |
| `startSessionWithAgent(_:mode:)` | agent target, fresh / continue-full-context |

The gap is the UI: the draft (`ScoutSessionDraft`) cannot express most of what
the spec can send. No project picker, no harness/model choice, no named durable
agents, target fixed by entry point, no global keyboard entry, no visible
in-flight state after submit. The web composer exposes new / from-message /
same-agent fresh|continue; macOS should reach parity and then use its native
advantages (repo store, keyboard, HUD).

## Naming

The user-facing noun is **conversation**, everywhere. Per the broker ontology
(`docs/agent/broker.agent.md`): a conversation is the durable record the user
creates and returns to; a session is the harness execution attached underneath.
The existing code already says it (`startNewConversation()`, card title "New
conversation") — keep it. "Session" appears in UX only at the execution layer:
the Options disclosure, continue-mode help text, and diagnostics. API names
(`POST /api/sessions`, `SessionInitiationSpec`) are unchanged; this is display
language only.

## Principles

1. **Entry point pre-configures; composer can override.** Every field the entry
   point guessed (project, agent, mode) is visible and changeable in the card.
2. **Two actions to a new conversation.** One to open (⌘N or a click), one to submit
   (⌘↩). Everything else is optional refinement.
3. **Progressive disclosure.** The default card is three things: target,
   message, go. Harness/model/identity live behind one "Options" disclosure.
4. **Never dead-end.** Failure states name the fix (broker down → the restart
   action; no agents → setup pane), and success is visible immediately.

## Initiation modalities

| Modality | Target | Execution | Seed | Spec fields |
|---|---|---|---|---|
| New conversation in a project | project | fresh (`session: new`) | instructions | `projectPath`, `seed.instructions` |
| New conversation with existing agent | agent | fresh | instructions | `agentId`, `session: new` |
| Continue agent with full context | agent | `targetSessionId`, `session: existing` | instructions | gated by `canContinue` |
| Branch from a message | agent or project | fresh | message body + provenance | `seed.fromMessageId`, `seed.fromConversationId` |
| New named durable agent | project | fresh | instructions | `agent.persistence`, `agent.name`, `agent.displayName` |
| Context fork (reserved) | agent | fresh + branch point | `seed.branchFrom` | not in v1; do not occupy its UX slot |

## Entry points (UX)

| Surface | Gesture | Draft preset |
|---|---|---|
| Anywhere | **⌘N** + File ▸ New Conversation (real menu item via `ScoutCommands`) | project target, last-used project |
| Conversation list | `+` button (exists) | same as ⌘N |
| Agent row / inspector | context menu + inspector buttons: "New conversation" / "Continue conversation" (exists) | agent target, mode preset |
| Message row | context menu "Branch from this message" (exists as "start conversation from message") | seeded draft, quoted-message chip |
| Comms empty state | primary CTA "Start a conversation" when roster is empty but broker is healthy | project target |
| Repos view | row action "Start a conversation here" | project target = that worktree root |
| HUD (phase 2) | `n` in agents tab | agent target, compact card |

All entry points funnel into the one composer. No surface grows its own
initiation form (same rule as the one-data-layer invariant in
`docs/agent/macos.agent.md`).

## The composer card

Current card stays the foundation (dimmed backdrop, Esc/“click out” to close,
dictation splice, mode picker). Target shape:

```plaintext
┌──────────────────────────────────────────────────┐
│ New conversation                                 │
│                                                  │
│ Target   (•) Project  ( ) Agent                  │
│ ┌──────────────────────────────────────────────┐ │
│ │ ▾ openscout   ~/dev/openscout                │ │   ← picker, not free text
│ └──────────────────────────────────────────────┘ │
│                                                  │
│ ┌──────────────────────────────────────────────┐ │
│ │ What should the new agent start on?          │ │   ← instructions, mic at right
│ │                                              │ │
│ └──────────────────────────────────────────────┘ │
│                                                  │
│ ▸ Options                                        │   ← collapsed by default
│                                                  │
│                       Cancel        Start  ⌘↩    │
└──────────────────────────────────────────────────┘
```

### Target row

- Segmented Project | Agent. Switching is allowed regardless of entry point;
  the entry point only sets the initial segment and value.
- **Project picker**: menu fed by `ScoutRepoStore` (projects + worktree roots),
  most-recently-used first, plus "Other…" → `NSOpenPanel` directory chooser.
  Persist last-used path in `@AppStorage`. Replaces today's invisible
  `defaultProjectPath` guess — the guess becomes the preselection.
- **Agent picker**: menu of the roster (`ScoutCommsStore.agents`) with the
  status dot, grouped by project. Preselected when entry point supplied one.
- When target = agent, a second row shows mode: `Fresh start` |
  `Continue (full context)` — today's `modePicker` with relabeled options, with
  Continue disabled + explanatory help when `canContinue` is false ("No
  resumable harness session for this agent" — the one place the word session
  belongs, because that is what it is).

### Seed chip (branch-from-message)

When `fromMessageId` is set, show a quoted chip above the instructions field:
source agent name, first ~2 lines of the message, and an ✕ to detach (clears
`fromMessageId`/`fromConversationId`, keeps any edited text). Today the body is
silently copied into instructions; the chip makes provenance visible and gives
the API its seed fields even when the user rewrites the prompt.

### Options disclosure (collapsed by default)

| Control | Maps to | Notes |
|---|---|---|
| Harness | `execution.harness` | menu: Default (broker picks) / claude / codex / … — source the list from the agents roster's observed harnesses for v1; capability endpoint later |
| Model | `execution.model` | optional free-text with recent values; empty = harness default |
| Identity (project target only) | `agent.persistence` + `name`/`displayName` | toggle "Keep this agent" → reveals name field; off = ephemeral default |

Defaults submit as today: nothing set, broker decides. The disclosure never
needs to be opened for the core modalities.

### Submit & in-flight UX

- ⌘↩ submits (↩ inserts newline in the editor); Esc cancels; all controls
  reachable by Tab — the card is keyboard-complete.
- On accept, keep today's handoff (`handleSessionStarted`: jump to Comms,
  select conversation/agent) and add a **pending state**: if the resulting
  channel isn't in the next poll yet, insert a provisional row in the
  conversation list ("Starting…", spinner glyph — geometric mark, no emoji)
  keyed on the returned `conversationId`/`flightId`, reconciled or replaced by
  the store's next publish. The user must see the thing they made within 1s.
- If the flight fails after accept (wake failure), the provisional row turns
  into an error row with the broker's diagnostic and a "Retry" affordance that
  reopens the composer with the same draft.

### Errors

- Inline error text stays (exists). Map the two big classes to remediation:
  connection refused → "Scout web server isn't running" + a Start action
  (helper already knows how); 4xx with broker diagnostic → render the broker's
  message verbatim (the broker coaches; don't paraphrase).

## Functionality notes

- **Draft gains fields**: `harness`, `model`, `persistence: Bool`, `agentName`,
  `displayName`, `recentProjects` source. `Target.project` gains an associated
  path-picker state. Spec-building moves fully into `ScoutSessionDraft`
  (`func spec() -> SessionInitiationSpec`) so it's unit-testable — this is a
  natural first test target for the package.
- **Mode → execution mapping** (unchanged semantics, now explicit):
  fresh → `session: .new`; continue → `session: .existing` +
  `targetSessionId = agent.harnessSessionId`. Never send `targetSessionId`
  with `.new` (broker treats mismatches as errors — see
  `runtime-sessions.agent.md` attachment rules).
- **⌘N command** goes through the existing `ScoutAppCommand` notification bus;
  gate it like other commands when a modal is up (`modalPresented` already
  includes `sessionDraft != nil`).
- **Recents**: last-used project path, last-used harness per project —
  `@AppStorage`, no new persistence layer.

## Phases

| Phase | Contents |
|---|---|
| **P1 (parity + the big wins)** | target row with project/agent pickers, ⌘N + menu item, seed chip, pending/error rows after submit, draft→spec extraction with tests |
| **P2** | Options disclosure (harness/model/identity), Repos-view entry point, empty-state CTA, error remediation actions |
| **P3** | HUD compact composer, command-palette entry, `seed.branchFrom` fork UX when the backend lands |

## Open questions

1. Harness list source: roster-derived is cheap but only shows harnesses
   already in use; is there/should there be a capabilities endpoint?
2. Should "Continue (full context)" appear for project targets when the broker
   could resolve a latest session (`session: .any`), or stay agent-only?
3. Named durable agents: does v1 of the web composer expose identity? Keep
   macOS at parity or let it lead here?
