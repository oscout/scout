# OpenScout portable voice core

This crate is the dependency-light Rust foundation for OpenScout's portable
live-voice lane. It owns deterministic behavior that should be identical on a
developer Mac and a hosted Linux worker:

- PCM16 downmixing, integer-rate normalization to 16 kHz, and fixed 512-sample
  model frames;
- candidate speech, confirmed speech, acoustic soft-end, and the normalized
  speech segment handed to semantic endpointing;
- monotonic `{turn, gen}` identity;
- the proposed/committed/suppressed effect ledger.

The crate deliberately does **not** choose WebRTC, Opus, ASR, or TTS
implementations, and the default build has no native dependencies. Providers
implement `VoiceActivityModel`; ONNX is a provider binding behind a feature
flag, never part of the wire contract or the core state machines. Smart Turn
consumes `SmartTurnInput` after acoustic soft-end.

The default segmenter bounds continuous speech at 30 seconds and emits a
`MaximumDuration` soft end. Deployments may choose a different
`VadConfig::max_speech_ms`, but it cannot be shorter than `min_speech_ms`;
utterance buffering is never intentionally unbounded.

## Features

| Feature | Adds | Default |
| --- | --- | --- |
| *(none)* | audio normalization, VAD state machine, turn clock, effect ledger — pure Rust | ✓ |
| `silero-onnx` | `silero::SileroVad` provider via ONNX Runtime (`ort`) | off |
| `replay` | `replay` module + `voice_replay` diagnostic binary | off |

```bash
cargo test -p openscout-voice-core                                  # default, pure Rust
cargo test -p openscout-voice-core --features replay
cargo test -p openscout-voice-core --features replay,silero-onnx
```

## Resampling

`Pcm16Normalizer` accepts 16/32/48 kHz PCM16 and emits clocked 512-sample
16 kHz frames across arbitrary packet and channel boundaries. Two decimation
strategies (`DecimationQuality`):

- **`WindowedSinc` (default, production):** linear-phase Kaiser windowed-sinc
  polyphase low-pass. Measured: passband flat to 7 kHz (±0.0 dB), −79 dB at
  the 8 kHz output Nyquist, ~−100 dB deep in the stopband; fixed 2.5 ms group
  delay (161 taps at 32 kHz, 241 at 48 kHz). A 12.5 kHz tone in a 48 kHz
  stream is rejected ≥75 dB (enforced by test).
- **`Box`:** the bring-up boxcar average, kept for conformance replay and
  comparison. Same tone survives only ~12.5 dB down — the tests measure both
  so the tradeoff stays visible.

Both are bit-deterministic and invariant to how the stream is chunked, and
neither changes the sample count contract (one output per factor inputs), so
the physical audio clock is preserved.

## Silero VAD provider (`silero-onnx`)

`silero::SileroVad` implements `VoiceActivityModel` with the real Silero VAD
v5 recurrent model: the 64-sample inter-frame context and the `[2, 1, 128]`
recurrent state live in the provider and are zeroed on `reset()`, which
`PortableVad` calls at session reset and cancellation boundaries.

**Artifact pinning.** The model is pinned to an immutable release tag and
checksum — `snakers4/silero-vad` `v5.1.2`, SHA-256
`2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f` — and the
checksum is verified before any bytes reach the ONNX parser. The runtime
never downloads anything and weights are not committed. Provision explicitly:

```bash
scripts/fetch-silero-vad.sh    # caches under ~/.cache/openscout/models/silero-vad/v5.1.2/
# or point OPENSCOUT_SILERO_VAD_ONNX at an existing copy (still checksum-verified)
```

**Native runtime.** `ort` (`=2.0.0-rc.13`, exact-pinned) links ONNX Runtime;
by default it fetches a prebuilt library at *build* time for the target, or
set `ORT_LIB_LOCATION` to use a locally built one. This is exactly why the
feature is off by default: the default workspace build must stay free of
native ONNX dependencies, and does (verified by `cargo build --workspace`).

Why ONNX Runtime and not pure-Rust `tract`: the official Silero v4 and v5
graphs contain nested `If` nodes whose branches disagree in output rank, which
tract's typed `If` cannot analyze (verified empirically against both
artifacts, tract 0.21–0.23). Rewriting the graph would forfeit the "runs the
pinned upstream artifact unmodified" property.

**Licensing.** Silero VAD weights and code: MIT (upstream `snakers4/silero-vad`).
ONNX Runtime: MIT. `ort`: MIT/Apache-2.0.

**Measured on an Apple Silicon Mac mini (release, single-threaded):** ~117 µs
per 32 ms frame (~270× realtime), ~59 ms session load, 2.3 MB artifact.
Inference is configured single-threaded and is byte-deterministic across runs
on one host; cross-platform bit-identity is *not* claimed (ONNX Runtime
kernels vary by target), which is one reason replay fixtures record
probabilities rather than model internals.

**Skippable smoke tests.** `tests/silero_smoke.rs` verifies checksum
fail-closed behavior unconditionally; tests needing the real model skip with
a printed notice when the artifact is not cached. No test touches the
network.

## Deterministic replay (`replay`)

The `replay` module and `voice_replay` binary feed WAV/raw PCM or recorded
per-frame probability fixtures through normalization + VAD and emit one
canonical JSON event per line — the assessment/Spec G §7 vocabulary
(`speech.candidate`, `speech.confirmed`, `turn.soft_ended`,
`speech.discarded`) with `{turn, gen}` stamps, not a competing protocol:

```bash
cargo run -p openscout-voice-core --features replay --bin voice_replay -- \
  --probs trace.json
cargo run -p openscout-voice-core --features replay,silero-onnx --bin voice_replay -- \
  --wav utterance.wav --model silero --packet-ms 20
```

Replays are pure functions of their inputs (no wall clock, threads, or
network); identical invocations produce byte-identical output, verified with
the real model in the loop.

The integration test replays the effect-bearing fixtures from
`docs/archive/design/spikes/voice-scenarios/` so JavaScript and Rust share JSON
conformance data instead of shared implementation code.

## Remaining before WebRTC/Opus service cutover

- WebRTC/Opus transport leg (werift-compatible signaling, TURN, paced 20 ms
  playout) in front of this crate's PCM boundary.
- Smart Turn v3.2 semantic endpointing provider consuming `SmartTurnInput`.
- Recorded-probability parity fixtures captured from the upstream Hugging
  Face pipeline, replayed through `voice_replay`, to demonstrate Silero
  behavioral parity with measured evidence (no parity claim is made yet).
- Service admission/lease wiring and canonical-trace comparison against the
  JavaScript leg per the assessment's measurement gates.
