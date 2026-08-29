# Vox Ranger TTS Timing Adoption - 2026-05-13

## Current state

Ranger brief playback already has the right speech boundary: one brief becomes one
concatenated narration string in `runBrief()` and one `/api/voice/speak` request.
Do not split brief cards back into separate TTS calls.

The local Vox draft at `/Users/arach/dev/vox/docs/vox-003-spoken-output-and-runtime-events.md`
describes optional one-shot timing through an `alignment` field, but OpenScout
should not implement that name as its public client concept. Wait until Vox
exposes a local contract named `speechTiming` or `timings`; this note uses
`speechTiming`.

Timing data is optional and best-effort. Missing timing data must not block audio
playback. OpenScout remains responsible for playback sequencing and UI cue
advancement.

## Request shape

OpenScout should continue to synthesize one coherent utterance:

```json
{
  "method": "synthesize.generate",
  "params": {
    "clientId": "openscout-web",
    "originAppId": "openscout.ranger",
    "utteranceId": "ranger-brief:<briefId-or-runId>",
    "text": "Full concatenated Ranger narration.",
    "modelId": "avspeech:system",
    "voiceId": "default",
    "format": "wav",
    "speed": 1,
    "speechTiming": {
      "enabled": true,
      "modelId": "parakeet:v3",
      "strict": false,
      "cues": [
        {
          "id": "step:<stepId>",
          "textStart": 0,
          "textEnd": 118
        },
        {
          "id": "recommendation",
          "textStart": 120,
          "textEnd": 214
        }
      ]
    }
  }
}
```

Notes:

- `textStart` and `textEnd` are offsets into the exact synthesized `text` string,
  after `toSpokenScoutText()` normalization if that remains in the client path.
- Cue IDs should be stable Ranger product IDs: `step:<step.id>` for step cards and
  `recommendation` for the final recommendation card.
- Cue payloads are metadata over one utterance, not synthesis boundaries.
- `speechTiming.modelId` selects the ASR/alignment model if Vox needs one. It is
  not a second TTS model.
- `strict` should default to `false`; timing failure should still return audio.

The matching OpenScout `/api/voice/speak` body should mirror only the fields the
browser owns:

```json
{
  "text": "Full concatenated Ranger narration.",
  "speed": 1,
  "speechTiming": {
    "enabled": true,
    "cues": [
      { "id": "step:<stepId>", "textStart": 0, "textEnd": 118 }
    ]
  }
}
```

The server should add `clientId`, `originAppId`, model defaults, voice defaults,
and any Vox-specific timing model default.

## Response shape

When Vox supports the field, OpenScout should pass through timing data without
requiring it:

```json
{
  "contentType": "audio/wav",
  "audioBase64": "<base64 wav bytes>",
  "modelId": "avspeech:system",
  "voiceId": "default",
  "audioBytes": 48244,
  "metrics": {
    "traceId": "ab12cd34",
    "synthesisMs": 121,
    "totalMs": 142,
    "audioDurationMs": 820
  },
  "traceId": "ab12cd34",
  "speechTiming": {
    "source": "asr",
    "modelId": "parakeet:v3",
    "elapsedMs": 180,
    "words": [
      {
        "text": "Full",
        "startMs": 0,
        "endMs": 180,
        "confidence": 0.99,
        "sourceTextStart": 0,
        "sourceTextEnd": 4
      }
    ],
    "cues": [
      {
        "id": "step:<stepId>",
        "startMs": 0,
        "endMs": 420,
        "confidence": 0.92,
        "source": "asr"
      }
    ]
  }
}
```

OpenScout should accept absent `speechTiming`, absent `words`, or partial cue
coverage. Cue confidence is advisory. If timing is missing, keep the existing
duration-estimate behavior.

## Minimal adoption points

- `packages/web/client/scout/ranger/RangerPanel.tsx:634`:
  extend `prepareBriefSpeech()` to accept cue metadata for a prepared brief.
- `packages/web/client/scout/ranger/RangerPanel.tsx:701`:
  build the concatenated narration and cue text ranges together in `runBrief()`.
  Prefer a small helper that appends each segment and records ranges against the
  exact final string.
- `packages/web/client/scout/ranger/RangerPanel.tsx:665`:
  update `playBriefSpeech()` to drive card advancement from actual playback time
  when `speechTiming.cues` is present. Keep the current estimated waits as the
  fallback.
- `packages/web/client/lib/vox.ts:39`:
  add typed optional timing fields to `VoxSpeakResult` and request options once
  Vox exposes the local contract.
- `packages/web/client/lib/vox.ts:184`:
  include `speechTiming` in the `/api/voice/speak` request body only after the
  server and Vox request type support it.
- `packages/web/server/create-openscout-web-server.ts:3041`:
  parse and validate optional `speechTiming` from the browser request.
- `packages/web/server/vox.ts:35`:
  add optional timing input to `synthesizeVoxSpeech()` and pass it through as
  `speechTiming` on `synthesize.generate`.
- `packages/web/server/vox.ts:20`:
  include optional `speechTiming` on `VoxSpeechResult` and forward it unchanged.

## Readiness checklist

OpenScout is implementation-ready when Vox locally exposes all of these:

- `synthesize.generate` accepts `speechTiming` or `timings`.
- The response returns word timings with `startMs`, `endMs`, `confidence`,
  `sourceTextStart`, and `sourceTextEnd`.
- The response returns cue timings with `id`, `startMs`, `endMs`, `confidence`,
  and `source`.
- Timing generation is best-effort by default and does not fail synthesis.
- Timing metrics are separate from synthesis metrics or clearly tagged inside the
  returned `metrics` payload.

Until then, keep the current request shape and do not implement against the
draft-only `alignment` field.
