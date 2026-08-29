# #shared membership persistence — pre-implementation findings

Status: **blocked on a design call.** Implementation not started, by request.

The ask said: *"If you find a second consumer I missed, say so before
proceeding — that would change the shape of this."* I found one, and it is
load-bearing. Details below.

## Your distribution claim: confirmed

Re-ran against `~/.openscout/control-plane/control-plane.sqlite`:

    local  | direct  | 345   (you saw 344 — drift)
    shared | direct  | 9     <- cross-node DMs, real members
    local  | channel | 4
    local  | system  | 1
    shared | channel | 1     <- #shared

`conversation_members` total 8,048 (you saw 8,045). #shared holds 7,323 —
**91.0%**. #shared message count: 3. Your read of `share_mode` is right, and
keying off it would break the 9 cross-node DMs exactly as you said.

## The blocker: `conversation_members` IS the broadcast fan-out list

Step 3 (`listConversationMemberIds` returns empty for open conversations)
was verified against one consumer. There is a second, and it is the delivery
path itself.

`packages/web/server/core/broker/service.ts:2577-2580`:

    const defaultScopeTargets = explicitTargetAttempted
      ? []
      : conversation.participantIds.filter((participantId) =>
          isSteerableParticipant(broker.snapshot, participantId, senderId)
        );

`targetIds` — who actually gets woken — is built from `defaultScopeTargets`
when no explicit target was given.

`scout broadcast` is precisely that case. `apps/desktop/src/cli/commands/broadcast.ts:46-53`
calls `sendScoutMessage({ body, channel: "shared", ... })` with no
`targetParticipantIds` and no selectors, so `explicitTargetAttempted === false`
and fan-out falls through to `conversation.participantIds`.

`participantIds` is hydrated from the same table by the second consumer of
`listConversationMemberIds` I found at `packages/runtime/src/sqlite-store.ts:4054`
(`getConversation`), and in the broker snapshot by the full-table scan at
`sqlite-store.ts:1581`.

**So: empty the rows and `scout broadcast` wakes nobody.** That is the direct
inverse of the hard constraint. The 7,323 rows are not inert bookkeeping —
they are the mechanism by which broadcast reaches the fleet.

Two further `participantIds` consumers that would also go dark, same root cause:
- `create-openscout-web-server.ts:2954-2977` `resolveSendSelectorTargetAgentIds`
  filters `queryAgents()` to the member set — `@agent` inside #shared stops resolving.
- `broker/service.ts:525-533` `scopedAliasTargetsForConversation` — same, for scoped aliases.

`findByParticipants` (`conversations/api.ts:130`) is **safe**: it early-returns on
the empty set and requires an exact count match, so a 0-member #shared can never
collide. `messages.ts:198` is display labels only. `resolveCounterpartIdForMessage`
is safe exactly as you verified.

## The stored list is already stale — a latent bug your framing exposes

    #shared members that are real agents : 7,321
    total agents known                   : 7,544

**223 agents are registered but not in #shared.** They receive no broadcast
until something re-upserts the conversation. The membership list is a snapshot
of "every agent that existed at last write," and it drifts. Broadcast is
already silently incomplete today.

## Corrected shape (same goal, one inversion)

Your diagnosis is right and the open/closed concept is the right name. The one
change: for an open conversation the member list must be **derived at read, not
merely absent**. "Everyone" is a live query, not an empty set.

1. Add explicit open/closed membership to `conversations`. Broadcast is open. (unchanged)
2. Skip the DELETE+INSERT for open conversations. (unchanged — this is the whole win)
3. **Revised.** `listConversationMemberIds` returns empty for open conversations
   (storage truth), but the fan-out and selector paths resolve an open
   conversation's members live from `snapshot.agents` — which is already exactly
   what `conversationDefinition()` uses to build `sharedParticipants` today
   (`broker/service.ts:1890`), and is in scope at the fan-out site as
   `broker.snapshot`. Behaviour is preserved, and the 223-agent staleness is
   fixed as a side effect.
4. One-time migration deleting the existing #shared rows. (unchanged)
5. `/api/comms` sends a participant count for open conversations. (unchanged —
   and it gets easier, since the count is `Object.keys(snapshot.agents).length`)

Net effect on your acceptance criteria is unchanged, except that criterion 1
("messages land for everyone") now actually holds, where the literal spec would
have failed it.

## On the pattern you asked me to name

`conversation_members` has no lifecycle column, so it cannot express "this
membership ended." But #shared shows a second, distinct failure: the table is
also being used to *store a derivable set*. "Everyone" has no business being
materialised at all — it is recomputable from `agents` at any instant, and
storing it guarantees staleness on top of the accumulation.

So the missing slot/occupant split has a sibling worth naming: **derived vs.
stored membership.** A row should exist only where the fact cannot be
recomputed. That is the cheap general version — a rule about what earns a row,
not a lifecycle column. I am flagging it, not building it, per your ask.

Related: `agents` itself holds 7,544 rows on a fleet nowhere near that size —
the same accumulation, one table over. Out of scope here; worth its own ask.
