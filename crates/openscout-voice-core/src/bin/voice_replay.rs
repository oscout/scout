//! Deterministic replay/diagnostic CLI for the portable voice edge.
//!
//! Feeds a WAV file, raw PCM16, or a recorded per-frame probability fixture
//! through normalization + VAD and prints one canonical JSON event per line,
//! followed by a summary line. Same input, same flags → byte-identical
//! output.
//!
//! ```text
//! cargo run -p openscout-voice-core --features replay --bin voice_replay -- \
//!     --wav utterance.wav [--model energy|silero] [--energy-threshold 0.02] \
//!     [--quality sinc|box] [--packet-ms 20] [--vad-threshold 0.6] \
//!     [--min-silence-ms 64] [--min-speech-ms 384] [--speech-pad-ms 500]
//! cargo run ... -- --raw capture.pcm --rate 48000 --channels 1
//! cargo run ... -- --probs trace.json
//! ```
//!
//! `--model silero` needs the binary built with `--features replay,silero-onnx`
//! and the pinned artifact cached locally (`scripts/fetch-silero-vad.sh`).

use openscout_voice_core::replay::{
    parse_probability_fixture, parse_wav, replay_interleaved, replay_probabilities, EnergyModel,
};
use openscout_voice_core::{DecimationQuality, PortableVad, VadConfig};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::process::ExitCode;

struct Options {
    wav: Option<String>,
    raw: Option<String>,
    probs: Option<String>,
    rate: u32,
    channels: usize,
    model: String,
    energy_threshold: f32,
    quality: DecimationQuality,
    packet_ms: u32,
    config: VadConfig,
}

fn parse_options(mut arguments: std::env::Args) -> Result<Options, String> {
    let mut options = Options {
        wav: None,
        raw: None,
        probs: None,
        rate: 48_000,
        channels: 1,
        model: "energy".to_owned(),
        energy_threshold: 0.02,
        quality: DecimationQuality::WindowedSinc,
        packet_ms: 20,
        config: VadConfig::default(),
    };
    arguments.next();
    while let Some(flag) = arguments.next() {
        let mut value = |name: &str| {
            arguments
                .next()
                .ok_or_else(|| format!("{name} requires a value"))
        };
        match flag.as_str() {
            "--wav" => options.wav = Some(value("--wav")?),
            "--raw" => options.raw = Some(value("--raw")?),
            "--probs" => options.probs = Some(value("--probs")?),
            "--rate" => options.rate = parse(&value("--rate")?)?,
            "--channels" => options.channels = parse(&value("--channels")?)?,
            "--model" => options.model = value("--model")?,
            "--energy-threshold" => {
                options.energy_threshold = parse(&value("--energy-threshold")?)?
            }
            "--quality" => {
                options.quality = match value("--quality")?.as_str() {
                    "sinc" => DecimationQuality::WindowedSinc,
                    "box" => DecimationQuality::Box,
                    other => return Err(format!("unknown quality {other:?} (sinc|box)")),
                }
            }
            "--packet-ms" => options.packet_ms = parse(&value("--packet-ms")?)?,
            "--vad-threshold" => options.config.threshold = parse(&value("--vad-threshold")?)?,
            "--min-silence-ms" => {
                options.config.min_silence_ms = parse(&value("--min-silence-ms")?)?
            }
            "--min-speech-ms" => options.config.min_speech_ms = parse(&value("--min-speech-ms")?)?,
            "--speech-pad-ms" => options.config.speech_pad_ms = parse(&value("--speech-pad-ms")?)?,
            other => return Err(format!("unknown flag {other:?}")),
        }
    }
    let sources =
        options.wav.is_some() as u8 + options.raw.is_some() as u8 + options.probs.is_some() as u8;
    if sources != 1 {
        return Err("exactly one of --wav, --raw, or --probs is required".to_owned());
    }
    Ok(options)
}

fn parse<T: std::str::FromStr>(text: &str) -> Result<T, String>
where
    T::Err: std::fmt::Display,
{
    text.parse()
        .map_err(|error| format!("invalid value {text:?}: {error}"))
}

fn run(options: Options) -> Result<Vec<Value>, String> {
    if let Some(path) = &options.probs {
        let text = std::fs::read_to_string(path).map_err(|error| format!("{path}: {error}"))?;
        let probabilities = parse_probability_fixture(&text).map_err(|error| error.to_string())?;
        return replay_probabilities(probabilities, options.config)
            .map_err(|error| error.to_string());
    }

    let (samples, rate, channels) = if let Some(path) = &options.wav {
        let bytes = std::fs::read(path).map_err(|error| format!("{path}: {error}"))?;
        let audio = parse_wav(&bytes).map_err(|error| error.to_string())?;
        (audio.samples, audio.sample_rate_hz, audio.channels)
    } else {
        let path = options.raw.as_ref().expect("one source is guaranteed");
        let bytes = std::fs::read(path).map_err(|error| format!("{path}: {error}"))?;
        if bytes.len() % 2 != 0 {
            return Err(format!("{path}: odd byte count for 16-bit PCM"));
        }
        let samples = bytes
            .chunks_exact(2)
            .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        (samples, options.rate, options.channels)
    };

    let packet_samples =
        (rate as usize * channels * options.packet_ms.max(1) as usize / 1_000).max(1);
    match options.model.as_str() {
        "energy" => {
            let mut vad = PortableVad::with_quality(
                rate,
                channels,
                options.quality,
                options.config,
                EnergyModel::new(options.energy_threshold),
            )
            .map_err(|error| error.to_string())?;
            replay_interleaved(&mut vad, &samples, packet_samples)
                .map_err(|error| error.to_string())
        }
        #[cfg(feature = "silero-onnx")]
        "silero" => {
            let model = openscout_voice_core::silero::SileroVad::from_pinned_artifact()
                .map_err(|error| error.to_string())?;
            let mut vad =
                PortableVad::with_quality(rate, channels, options.quality, options.config, model)
                    .map_err(|error| error.to_string())?;
            replay_interleaved(&mut vad, &samples, packet_samples)
                .map_err(|error| error.to_string())
        }
        #[cfg(not(feature = "silero-onnx"))]
        "silero" => Err("this build lacks the silero-onnx feature".to_owned()),
        other => Err(format!("unknown model {other:?} (energy|silero)")),
    }
}

fn main() -> ExitCode {
    let options = match parse_options(std::env::args()) {
        Ok(options) => options,
        Err(error) => {
            eprintln!("voice_replay: {error}");
            return ExitCode::from(2);
        }
    };
    match run(options) {
        Ok(events) => {
            let mut counts: BTreeMap<String, u64> = BTreeMap::new();
            for event in &events {
                println!("{event}");
                let kind = event["event"].as_str().unwrap_or("unknown").to_owned();
                *counts.entry(kind).or_default() += 1;
            }
            println!("{}", json!({ "event": "replay.summary", "counts": counts }));
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("voice_replay: {error}");
            ExitCode::FAILURE
        }
    }
}
