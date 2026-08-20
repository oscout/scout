//! Portable, provider-neutral live voice primitives for OpenScout.
//!
//! Media transport and model execution stay outside this crate. The crate owns
//! the clocked PCM boundary, acoustic turn state, cross-language turn stamp,
//! and irreversible-effect commitment rules.

pub mod audio;
pub mod effect;
#[cfg(feature = "replay")]
pub mod replay;
pub mod resample;
#[cfg(feature = "silero-onnx")]
pub mod silero;
pub mod turn;
pub mod vad;

pub use audio::{
    AudioNormalizationError, Pcm16Normalizer, VadFrame, PIPELINE_SAMPLE_RATE_HZ, VAD_FRAME_SAMPLES,
};
pub use effect::{
    EffectCommitOutcome, EffectEntry, EffectLedger, EffectLedgerError, EffectResultOutcome,
    EffectState, Reversibility,
};
pub use resample::DecimationQuality;
pub use turn::{StampError, TurnClock, VoiceTurnStamp, MAX_WIRE_INTEGER};
pub use vad::{
    AcousticEvent, PortableVad, PortableVadError, PortableVoiceEvent, SmartTurnInput,
    SoftEndReason, VadConfig, VadConfigError, VadSegmenter, VadSegmenterError, VoiceActivityModel,
};
