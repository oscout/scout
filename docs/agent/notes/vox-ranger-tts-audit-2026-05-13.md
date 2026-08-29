# Vox / Ranger TTS Audit — 2026-05-13

Prompted by: operator review of diagnostics showing many `synthesize.generate` rows from `openscout-web`.

---

## 1. Ranger brief TTS path — one brief = one call ✅

`runBrief()` (`RangerPanel.tsx:686`) builds the full narration as a single concatenated string:

```
briefNarration = segments.map(s => s.narration).join("\n\n")  // line 704
```

Then calls `prepareBriefSpeech(briefNarration)` once (line 710), which issues one
`POST /api/voice/speak` → one `synthesize.generate` RPC. The step-by-step UI walk
happens after that single synthesis, using timing estimates (`segment.durationMs`) to
advance UI slides while audio plays.

**Was never one-per-step.** The "many rows" in Vox diagnostics were likely distinct
events (multiple replies + reminder announcements) occurring in close succession, not
one brief split into sub-calls.

---

## 2. Remaining code paths that split one spoken turn into multiple calls

None found for briefs or replies. Each call site maps to exactly one `synthesize.generate`:

| Caller | File:line | Produces |
|--------|-----------|---------|
| `runSpeech()` | RangerPanel.tsx:231 | 1 call per reply |
| `speakRangerText()` | RangerPanel.tsx:254 | 1 call per reminder announcement |
| `prepareBriefSpeech()` | RangerPanel.tsx:636 | 1 call per brief |

If `runSpeech` fires for a new reply while a brief is playing, `stopSpeech()` aborts
the brief fetch and starts a new single call. That is correct behavior.

---

## 3. Playback arbiter — single-speaker reference pattern ✅

`speechRef.current` (`RangerPanel.tsx:212`) holds the active `VoxSpeakHandle`.

- `runSpeech()` always calls `stopSpeech()` first (line 230) before assigning a new handle.
- `playBriefSpeech()` calls `speechRef.current?.stop()` at line 668 before assigning.
- `stopSpeech()` aborts both the prepare fetch (`speechPrepareAbortRef`) and the playback handle.

Only one surface can be audible per `RangerPanel` instance. No mutex needed — the
ref pattern is sufficient.

**Gap (minor):** If two `runBrief()` calls race (different `runId`), the first call's
`prepared` fetch may complete after its `briefRunRef` guard fires (line 712), wasting
one completed synthesis that is never played. The audio is silently discarded and
`speechPrepareAbortRef` clears normally. This is low-priority (briefs are not
re-triggered rapidly), but could be fixed by aborting `speechPrepareAbortRef` on brief
supersession at the `briefRunRef !== runId` guard.

---

## 4. Cancellation — browser abort propagates through the full chain ✅

```
stopSpeech()
  → speechPrepareAbortRef.abort()     # cancels the /api/voice/speak fetch
  → speechRef.current.stop()          # aborts the playback AbortController
      → audio.pause() + audio.currentTime = 0
```

`prepareVoxSpeech()` (`lib/vox.ts:193`) passes the signal to `fetch()`.
Browser abort on the fetch causes the server's `c.req.raw.signal` to fire.

---

## 5. Server-side abort → Vox RPC propagation ✅

`/api/voice/speak` handler (`create-openscout-web-server.ts:3059`) already passes
`c.req.raw.signal` to `synthesizeVoxSpeech()`, which forwards it to `callVoxRpc()`.

`callVoxRpc()` (`vox.ts:167–169`) registers an `onAbort` listener that closes the
WebSocket immediately:

```ts
const onAbort = () => {
  cleanup();  // closes WebSocket, clears timeout
  reject(abortError(`Vox ${method} aborted.`));
};
options.signal?.addEventListener("abort", onAbort, { once: true });
```

**The chain is already correct end-to-end.** When the user stops Ranger speech, the
browser aborts the fetch → the server receives the signal → the Vox WebSocket closes →
Vox stops generating. No lingering server-side work.

---

## 6. Polling / probing audit

### Vox probe — event-driven, not hot ✅

`probeVoice()` is called:
- Once on mount (line 522)
- On `window.focus` (line 523)
- On `document.visibilitychange` to `"visible"` (line 524–526)
- Once after `launchVox()` with a 2400ms `setTimeout` (line 541)

No `setInterval`. Already appropriate. When Vox `runtime.subscribe` / `/events` lands,
the focus/visibility triggers can be removed in favor of a subscription.

### Reminder polling — 15s interval, reasonable ✅

`RangerPanel.tsx:359`: `window.setInterval(() => loadRangerReminders(), 15_000)`

This polls the local OpenScout server, not Vox. Acceptable frequency; no reduction needed.

### sessionStatus hot polling — not present in Ranger ✅

No `setInterval` or polling loop for Vox session status was found in `RangerPanel.tsx`
or `lib/vox.ts`. The operator concern may refer to an earlier version or a different
surface. MeshScreen does poll `/api/mesh` every 10s (`MeshScreen.tsx:354`) but that is
unrelated to Vox TTS.

**When Vox `runtime.subscribe` / `/events` ships:**
- The focus/visibility probe triggers in `RangerPanel.tsx:521–532` become removable.
- Any future Vox session-state polling should be replaced with a subscription instead
  of added as a new interval.

---

## Patch plan

### P0 — No immediate patches required

The three issues from the operator checklist that required fixes are already handled
correctly in the current code:
- Cancellation chain (§4, §5)
- Playback arbiter (§3)
- Single call per turn (§1, §2)

### P1 — Minor: abort brief prepare on supersession (low priority)

In `runBrief()`, after the `briefRunRef.current !== runId` guard fires (line 712),
abort `speechPrepareAbortRef` if it is still set for the superseded brief:

```ts
// After line 712 check:
if (briefRunRef.current !== runId) {
  speechPrepareAbortRef.current?.abort();
  speechPrepareAbortRef.current = null;
  return;
}
```

This eliminates a completed-but-unused synthesis call when briefs overlap.

### P2 — Future: replace probe with Vox runtime.subscribe

Once Vox exposes `runtime.subscribe` or `/events`, replace the focus/visibility
listeners in `RangerPanel.tsx:521–532` with a subscription. No code change needed
until that API exists.

### P3 — Future: expose traceId to client logs

`synthesizeVoxSpeech()` already extracts `traceId` from the Vox response (vox.ts:60).
The server returns it in the JSON response. `prepareVoxSpeech()` in `lib/vox.ts`
could log or attach it to the `VoxSpeakResult` for easier correlation with Vox
diagnostics.

---

## File index

| File | Relevant lines |
|------|---------------|
| `packages/web/client/scout/ranger/RangerPanel.tsx` | 212–226 (refs/arbiter), 228–250 (runSpeech), 629–648 (prepareBriefSpeech), 650–684 (playBriefSpeech), 686–759 (runBrief), 509–533 (probeVoice), 354–364 (reminder poll) |
| `packages/web/server/vox.ts` | 35–71 (synthesizeVoxSpeech), 143–210 (callVoxRpc + abort) |
| `packages/web/server/create-openscout-web-server.ts` | 3041–3065 (/api/voice/speak handler) |
| `packages/web/client/lib/vox.ts` | 182–208 (prepareVoxSpeech), 210–255 (playPreparedVoxSpeech) |
