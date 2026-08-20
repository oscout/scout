//! Silero provider smoke tests (`--features silero-onnx`).
//!
//! Checksum and shape guards run unconditionally. Tests that need the real
//! model skip explicitly when the pinned artifact is not cached locally
//! (`scripts/fetch-silero-vad.sh`), so CI without the artifact stays green
//! and deterministic unit coverage never depends on the network.
#![cfg(feature = "silero-onnx")]

use openscout_voice_core::silero::{locate_pinned_artifact, SileroVad, SileroVadError};
use openscout_voice_core::{
    PortableVad, VadConfig, VoiceActivityModel, PIPELINE_SAMPLE_RATE_HZ, VAD_FRAME_SAMPLES,
};
use std::path::PathBuf;

fn cached_artifact() -> Option<PathBuf> {
    match locate_pinned_artifact() {
        Ok(path) => Some(path),
        Err(error) => {
            eprintln!("SKIP silero smoke test: {error}");
            None
        }
    }
}

fn frame(fill: impl Fn(usize) -> f32) -> [f32; VAD_FRAME_SAMPLES] {
    let mut samples = [0.0; VAD_FRAME_SAMPLES];
    for (index, sample) in samples.iter_mut().enumerate() {
        *sample = fill(index);
    }
    samples
}

fn tone_frame(chunk: usize) -> [f32; VAD_FRAME_SAMPLES] {
    frame(|index| {
        let t = (chunk * VAD_FRAME_SAMPLES + index) as f32 / PIPELINE_SAMPLE_RATE_HZ as f32;
        0.4 * (2.0 * std::f32::consts::PI * 220.0 * t).sin()
    })
}

fn probabilities(
    model: &mut SileroVad,
    frames: usize,
    source: impl Fn(usize) -> [f32; 512],
) -> Vec<f32> {
    (0..frames)
        .map(|chunk| {
            model
                .speech_probability(&source(chunk), PIPELINE_SAMPLE_RATE_HZ)
                .expect("inference")
        })
        .collect()
}

#[test]
fn corrupted_artifacts_fail_closed_on_checksum() {
    let path = std::env::temp_dir().join("openscout-silero-corrupt-test.onnx");
    std::fs::write(&path, b"not an onnx model").unwrap();
    let error = SileroVad::from_verified_file(&path).unwrap_err();
    std::fs::remove_file(&path).ok();
    assert!(
        matches!(error, SileroVadError::ChecksumMismatch { .. }),
        "expected checksum rejection, got {error}"
    );
}

#[test]
fn unreadable_artifacts_error_explicitly_instead_of_loading_nothing() {
    let error = SileroVad::from_verified_file("/nonexistent/silero.onnx").unwrap_err();
    assert!(matches!(error, SileroVadError::ArtifactUnreadable { .. }));
}

#[test]
fn silence_stays_far_below_the_speech_threshold() {
    let Some(path) = cached_artifact() else {
        return;
    };
    let mut model = SileroVad::from_verified_file(path).unwrap();
    let probs = probabilities(&mut model, 8, |_| frame(|_| 0.0));
    assert!(
        probs.iter().all(|p| *p < 0.1),
        "silence probabilities reached {probs:?}"
    );
}

#[test]
fn inference_is_deterministic_and_reset_restores_the_initial_state() {
    let Some(path) = cached_artifact() else {
        return;
    };
    let mut model = SileroVad::from_verified_file(path).unwrap();

    let first = probabilities(&mut model, 6, tone_frame);
    model.reset();
    let second = probabilities(&mut model, 6, tone_frame);
    assert_eq!(first, second, "reset did not restore the initial state");
}

#[test]
fn recurrent_state_and_context_change_the_next_probability() {
    let Some(path) = cached_artifact() else {
        return;
    };
    let mut model = SileroVad::from_verified_file(path).unwrap();

    // Same frame, different history: a fresh model vs one that has already
    // consumed five loud frames must disagree if state/context are carried.
    let fresh = probabilities(&mut model, 1, tone_frame)[0];
    model.reset();
    probabilities(&mut model, 5, |chunk| tone_frame(chunk + 1));
    let carried = probabilities(&mut model, 1, tone_frame)[0];
    assert_ne!(
        fresh, carried,
        "prior audio did not influence inference; recurrent state is not carried"
    );
}

#[test]
fn portable_vad_with_the_real_model_emits_no_events_for_silence() {
    let Some(path) = cached_artifact() else {
        return;
    };
    let model = SileroVad::from_verified_file(path).unwrap();
    let mut vad = PortableVad::new(48_000, 1, VadConfig::default(), model).unwrap();

    for _ in 0..30 {
        let events = vad.push_interleaved(&[0i16; 1536]).unwrap();
        assert!(events.is_empty(), "silence produced {events:?}");
    }
    assert!(vad.finish().unwrap().is_none());
}
