//! Deterministic replay of recorded audio or probability fixtures through
//! normalization + VAD, emitting canonical stamped JSON events.
//!
//! This is the Rust counterpart of the JavaScript scenario tooling in
//! `docs/archive/design/spikes/`: the same `{turn, gen}` stamp discipline and the
//! Spec G §7 / assessment vocabulary (`speech.candidate`, `speech.confirmed`,
//! `turn.soft_ended`, `speech.discarded`) rather than a competing protocol.
//! Replays are pure functions of their inputs: no wall clock, no threads, no
//! network.

use crate::audio::{PIPELINE_SAMPLE_RATE_HZ, VAD_FRAME_SAMPLES};
use crate::resample::DecimationQuality;
use crate::vad::{
    PortableVad, PortableVadError, PortableVoiceEvent, SoftEndReason, VadConfig, VoiceActivityModel,
};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::fmt;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReplayError {
    MalformedWav(String),
    MalformedFixture(String),
}

impl fmt::Display for ReplayError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MalformedWav(reason) => write!(formatter, "malformed WAV input: {reason}"),
            Self::MalformedFixture(reason) => {
                write!(formatter, "malformed probability fixture: {reason}")
            }
        }
    }
}

impl std::error::Error for ReplayError {}

/// PCM16 audio decoded from a RIFF/WAVE container.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WavAudio {
    pub sample_rate_hz: u32,
    pub channels: usize,
    pub samples: Vec<i16>,
}

/// Minimal RIFF parser for canonical PCM16 WAV files. Unknown chunks are
/// skipped; compressed or non-16-bit formats are rejected explicitly.
pub fn parse_wav(bytes: &[u8]) -> Result<WavAudio, ReplayError> {
    fn err(reason: impl Into<String>) -> ReplayError {
        ReplayError::MalformedWav(reason.into())
    }

    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(err("missing RIFF/WAVE header"));
    }

    let mut format: Option<(u32, usize)> = None;
    let mut cursor = 12usize;
    while cursor + 8 <= bytes.len() {
        let chunk_id = &bytes[cursor..cursor + 4];
        let chunk_len =
            u32::from_le_bytes(bytes[cursor + 4..cursor + 8].try_into().unwrap()) as usize;
        let body_start = cursor + 8;
        let body_end = body_start
            .checked_add(chunk_len)
            .filter(|end| *end <= bytes.len())
            .ok_or_else(|| err("chunk overruns file"))?;
        let body = &bytes[body_start..body_end];

        match chunk_id {
            b"fmt " => {
                if body.len() < 16 {
                    return Err(err("fmt chunk too short"));
                }
                let audio_format = u16::from_le_bytes(body[0..2].try_into().unwrap());
                let channels = u16::from_le_bytes(body[2..4].try_into().unwrap());
                let sample_rate = u32::from_le_bytes(body[4..8].try_into().unwrap());
                let bits = u16::from_le_bytes(body[14..16].try_into().unwrap());
                if audio_format != 1 {
                    return Err(err(format!("audio format {audio_format} is not PCM")));
                }
                if bits != 16 {
                    return Err(err(format!("{bits}-bit PCM is not supported, expected 16")));
                }
                if channels == 0 {
                    return Err(err("zero channels"));
                }
                format = Some((sample_rate, channels as usize));
            }
            b"data" => {
                let (sample_rate_hz, channels) =
                    format.ok_or_else(|| err("data chunk before fmt chunk"))?;
                let samples = body
                    .chunks_exact(2)
                    .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
                    .collect();
                return Ok(WavAudio {
                    sample_rate_hz,
                    channels,
                    samples,
                });
            }
            _ => {}
        }
        // RIFF chunks are word-aligned; odd-length bodies carry a pad byte.
        cursor = body_end + (chunk_len % 2);
    }
    Err(err("no data chunk"))
}

/// Deterministic RMS-threshold stand-in model for model-free diagnostics.
/// This is a replay tool, not a speech detector: it exists so PCM replays
/// work without any ONNX provider, with behavior that is trivial to reason
/// about.
#[derive(Clone, Debug)]
pub struct EnergyModel {
    threshold: f32,
}

impl EnergyModel {
    pub fn new(threshold: f32) -> Self {
        Self {
            threshold: threshold.max(0.0),
        }
    }
}

impl VoiceActivityModel for EnergyModel {
    type Error = std::convert::Infallible;

    fn reset(&mut self) {}

    fn speech_probability(
        &mut self,
        samples: &[f32; VAD_FRAME_SAMPLES],
        _sample_rate_hz: u32,
    ) -> Result<f32, Self::Error> {
        let energy: f32 = samples.iter().map(|sample| sample * sample).sum();
        let rms = (energy / VAD_FRAME_SAMPLES as f32).sqrt();
        Ok(if rms >= self.threshold { 1.0 } else { 0.0 })
    }
}

/// Replays a recorded per-frame probability trace; frames beyond the fixture
/// read as silence.
#[derive(Clone, Debug, Default)]
pub struct FixtureProbabilityModel {
    probabilities: VecDeque<f32>,
}

impl FixtureProbabilityModel {
    pub fn new(probabilities: impl IntoIterator<Item = f32>) -> Self {
        Self {
            probabilities: probabilities.into_iter().collect(),
        }
    }
}

impl VoiceActivityModel for FixtureProbabilityModel {
    type Error = std::convert::Infallible;

    fn reset(&mut self) {}

    fn speech_probability(
        &mut self,
        _samples: &[f32; VAD_FRAME_SAMPLES],
        _sample_rate_hz: u32,
    ) -> Result<f32, Self::Error> {
        Ok(self.probabilities.pop_front().unwrap_or(0.0))
    }
}

/// Parse a probability fixture: either a bare JSON array of numbers or an
/// object with a `probabilities` array.
pub fn parse_probability_fixture(text: &str) -> Result<Vec<f32>, ReplayError> {
    fn err(reason: impl Into<String>) -> ReplayError {
        ReplayError::MalformedFixture(reason.into())
    }

    let value: Value = serde_json::from_str(text).map_err(|error| err(error.to_string()))?;
    let array = match &value {
        Value::Array(items) => items,
        Value::Object(map) => map
            .get("probabilities")
            .and_then(Value::as_array)
            .ok_or_else(|| err("expected a `probabilities` array"))?,
        _ => return Err(err("expected an array or {\"probabilities\": [...]}")),
    };
    array
        .iter()
        .map(|item| {
            let number = item
                .as_f64()
                .ok_or_else(|| err(format!("non-numeric probability {item}")))?;
            if !(0.0..=1.0).contains(&number) {
                return Err(err(format!("probability {number} outside [0, 1]")));
            }
            Ok(number as f32)
        })
        .collect()
}

/// Canonical JSON form of one stamped acoustic event.
pub fn wire_event(event: &PortableVoiceEvent) -> Value {
    match event {
        PortableVoiceEvent::CandidateSpeech {
            stamp,
            audio_start_ms,
        } => json!({
            "event": "speech.candidate",
            "turn": stamp.turn,
            "gen": stamp.gen,
            "audioStartMs": audio_start_ms,
        }),
        PortableVoiceEvent::SpeechConfirmed {
            stamp,
            audio_start_ms,
            active_speech_ms,
        } => json!({
            "event": "speech.confirmed",
            "turn": stamp.turn,
            "gen": stamp.gen,
            "audioStartMs": audio_start_ms,
            "activeSpeechMs": active_speech_ms,
        }),
        PortableVoiceEvent::TurnSoftEnded { stamp, input } => json!({
            "event": "turn.soft_ended",
            "turn": stamp.turn,
            "gen": stamp.gen,
            "audioStartMs": samples_to_ms(input.audio_start_sample()),
            "audioEndMs": samples_to_ms(input.audio_end_sample()),
            "activeSpeechMs": input.active_speech_ms(),
            "reason": match input.reason() {
                SoftEndReason::AcousticSilence => "acoustic_silence",
                SoftEndReason::MaximumDuration => "maximum_duration",
                SoftEndReason::StreamEnded => "stream_ended",
            },
            "sampleRateHz": input.sample_rate_hz(),
            "pcmSamples": input.pcm16().len(),
        }),
        PortableVoiceEvent::CandidateDiscarded {
            stamp,
            audio_start_ms,
            audio_end_ms,
            active_speech_ms,
        } => json!({
            "event": "speech.discarded",
            "turn": stamp.turn,
            "gen": stamp.gen,
            "audioStartMs": audio_start_ms,
            "audioEndMs": audio_end_ms,
            "activeSpeechMs": active_speech_ms,
        }),
    }
}

/// Push interleaved PCM through a portable VAD in fixed-size packets and
/// return the canonical events, including the end-of-stream flush.
pub fn replay_interleaved<Model: VoiceActivityModel>(
    vad: &mut PortableVad<Model>,
    samples: &[i16],
    packet_samples: usize,
) -> Result<Vec<Value>, PortableVadError<Model::Error>> {
    let packet_samples = packet_samples.max(1);
    let mut events = Vec::new();
    for packet in samples.chunks(packet_samples) {
        for event in vad.push_interleaved(packet)? {
            events.push(wire_event(&event));
        }
    }
    if let Some(event) = vad.finish()? {
        events.push(wire_event(&event));
    }
    Ok(events)
}

/// Replay a recorded probability trace with synthetic silence PCM: timing and
/// stamping behave exactly as live, while the audio content is irrelevant.
pub fn replay_probabilities(
    probabilities: Vec<f32>,
    config: VadConfig,
) -> Result<Vec<Value>, PortableVadError<std::convert::Infallible>> {
    let frames = probabilities.len();
    let mut vad = PortableVad::with_quality(
        PIPELINE_SAMPLE_RATE_HZ,
        1,
        DecimationQuality::Box,
        config,
        FixtureProbabilityModel::new(probabilities),
    )?;
    let silence = vec![0i16; frames * VAD_FRAME_SAMPLES];
    replay_interleaved(&mut vad, &silence, VAD_FRAME_SAMPLES)
}

fn samples_to_ms(samples: u64) -> u64 {
    samples * 1_000 / u64::from(PIPELINE_SAMPLE_RATE_HZ)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wav_bytes(sample_rate_hz: u32, channels: u16, samples: &[i16]) -> Vec<u8> {
        let data_len = (samples.len() * 2) as u32;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + data_len).to_le_bytes());
        bytes.extend_from_slice(b"WAVE");
        bytes.extend_from_slice(b"fmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&channels.to_le_bytes());
        bytes.extend_from_slice(&sample_rate_hz.to_le_bytes());
        bytes.extend_from_slice(&(sample_rate_hz * u32::from(channels) * 2).to_le_bytes());
        bytes.extend_from_slice(&(channels * 2).to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&data_len.to_le_bytes());
        for sample in samples {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        bytes
    }

    #[test]
    fn wav_round_trips_pcm16() {
        let samples: Vec<i16> = (0..1000).map(|index| (index * 7 % 2048) as i16).collect();
        let parsed = parse_wav(&wav_bytes(48_000, 2, &samples)).unwrap();
        assert_eq!(parsed.sample_rate_hz, 48_000);
        assert_eq!(parsed.channels, 2);
        assert_eq!(parsed.samples, samples);
    }

    #[test]
    fn wav_rejects_compressed_formats() {
        let mut bytes = wav_bytes(16_000, 1, &[0; 4]);
        bytes[20] = 3; // IEEE float format tag
        assert!(matches!(
            parse_wav(&bytes),
            Err(ReplayError::MalformedWav(_))
        ));
    }

    #[test]
    fn probability_fixture_accepts_both_shapes_and_validates_range() {
        assert_eq!(
            parse_probability_fixture("[0.25, 1.0]").unwrap(),
            vec![0.25, 1.0]
        );
        assert_eq!(
            parse_probability_fixture(r#"{"probabilities": [0.5]}"#).unwrap(),
            vec![0.5]
        );
        assert!(parse_probability_fixture("[1.5]").is_err());
        assert!(parse_probability_fixture(r#"{"frames": []}"#).is_err());
    }

    #[test]
    fn probability_replay_emits_the_canonical_event_sequence() {
        // 12 speech frames (384 ms) then trailing silence: candidate at frame
        // 1, confirmation at frame 12, acoustic soft end after 64 ms silence.
        let mut probabilities = vec![0.9f32; 12];
        probabilities.extend([0.0, 0.0, 0.0]);
        let events = replay_probabilities(probabilities, VadConfig::default()).unwrap();

        let kinds: Vec<&str> = events
            .iter()
            .map(|event| event["event"].as_str().unwrap())
            .collect();
        assert_eq!(
            kinds,
            ["speech.candidate", "speech.confirmed", "turn.soft_ended"]
        );
        assert_eq!(events[0]["turn"], 1);
        assert_eq!(events[0]["gen"], 1);
        assert_eq!(events[1]["activeSpeechMs"], 384);
        assert_eq!(events[2]["reason"], "acoustic_silence");
        assert_eq!(events[2]["audioEndMs"], 15 * 32);
    }

    #[test]
    fn maximum_duration_has_a_canonical_wire_reason() {
        let config = VadConfig {
            min_speech_ms: 64,
            max_speech_ms: 320,
            speech_pad_ms: 0,
            ..VadConfig::default()
        };
        let events = replay_probabilities(vec![0.9; 10], config).unwrap();

        assert_eq!(events.last().unwrap()["event"], "turn.soft_ended");
        assert_eq!(events.last().unwrap()["reason"], "maximum_duration");
    }

    #[test]
    fn canonical_json_shape_is_stable() {
        let events = replay_probabilities(vec![0.9; 2], VadConfig::default()).unwrap();
        // Ends mid-candidate: the stream flush discards the unconfirmed turn.
        assert_eq!(
            serde_json::to_string(&events[1]).unwrap(),
            r#"{"activeSpeechMs":64,"audioEndMs":64,"audioStartMs":0,"event":"speech.discarded","gen":1,"turn":1}"#
        );
    }

    #[test]
    fn energy_replay_of_a_synthetic_wav_matches_the_probability_view() {
        // 700 ms of tone then 200 ms of silence at 48 kHz mono.
        let mut samples: Vec<i16> = (0..(48_000 * 7 / 10))
            .map(|index| {
                let phase = 2.0 * std::f64::consts::PI * 300.0 * index as f64 / 48_000.0;
                (12_000.0 * phase.sin()) as i16
            })
            .collect();
        samples.extend(std::iter::repeat_n(0i16, 48_000 / 5));
        let wav = parse_wav(&wav_bytes(48_000, 1, &samples)).unwrap();

        let mut vad = PortableVad::new(
            wav.sample_rate_hz,
            wav.channels,
            VadConfig::default(),
            EnergyModel::new(0.02),
        )
        .unwrap();
        let events = replay_interleaved(&mut vad, &wav.samples, 960).unwrap();

        let kinds: Vec<&str> = events
            .iter()
            .map(|event| event["event"].as_str().unwrap())
            .collect();
        assert_eq!(
            kinds,
            ["speech.candidate", "speech.confirmed", "turn.soft_ended"]
        );
    }
}
