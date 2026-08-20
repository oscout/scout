//! Production Silero VAD provider behind the [`VoiceActivityModel`] boundary.
//!
//! Compiled only with the `silero-onnx` feature. ONNX Runtime is a provider
//! implementation detail here: nothing in the wire protocol, turn state, or
//! the rest of the crate knows this module exists.
//!
//! ## Pinned artifact
//!
//! The model is Silero VAD v5.1.2, fetched from an immutable tag — never a
//! moving branch — and verified against a pinned SHA-256 before any bytes
//! reach the ONNX parser. Nothing in this module downloads anything: artifact
//! provisioning is an explicit operator step (see
//! `scripts/fetch-silero-vad.sh`), and weights are never committed to the
//! repository.
//!
//! ## Streaming state
//!
//! The v5 graph is recurrent. Each 512-sample/16 kHz frame is fed as
//! 64 context samples from the previous frame + the 512 new samples, together
//! with a `[2, 1, 128]` recurrent state tensor from the previous call —
//! exactly what upstream's Python wrapper maintains. Both live here and are
//! zeroed by [`SileroVad::reset`], which [`crate::vad::PortableVad`] invokes
//! at session and cancellation boundaries.

use crate::audio::{PIPELINE_SAMPLE_RATE_HZ, VAD_FRAME_SAMPLES};
use crate::vad::VoiceActivityModel;
use ort::session::Session;
use ort::value::Tensor;
use sha2::{Digest, Sha256};
use std::fmt;
use std::path::{Path, PathBuf};

/// Upstream release tag the artifact is pinned to.
pub const SILERO_VAD_MODEL_VERSION: &str = "v5.1.2";
/// Immutable source URL for the pinned artifact (tag path, not a branch).
pub const SILERO_VAD_MODEL_SOURCE: &str =
    "https://raw.githubusercontent.com/snakers4/silero-vad/v5.1.2/src/silero_vad/data/silero_vad.onnx";
/// SHA-256 of the pinned artifact; verified before the model is loaded.
pub const SILERO_VAD_MODEL_SHA256: &str =
    "2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f";
/// Upstream license of the model weights (snakers4/silero-vad).
pub const SILERO_VAD_MODEL_LICENSE: &str = "MIT";

/// Environment variable naming an explicit artifact path; takes precedence
/// over the cache location.
pub const SILERO_VAD_PATH_ENV: &str = "OPENSCOUT_SILERO_VAD_ONNX";

const CONTEXT_SAMPLES: usize = 64;
const STATE_LEN: usize = 2 * 128;
const MODEL_INPUT_SAMPLES: usize = CONTEXT_SAMPLES + VAD_FRAME_SAMPLES;

#[derive(Debug)]
pub enum SileroVadError {
    ArtifactMissing {
        tried: Vec<PathBuf>,
    },
    ArtifactUnreadable {
        path: PathBuf,
        error: std::io::Error,
    },
    ChecksumMismatch {
        path: PathBuf,
        expected: &'static str,
        actual: String,
    },
    Runtime(ort::Error),
    UnsupportedSampleRate(u32),
    UnexpectedOutput(&'static str),
}

impl fmt::Display for SileroVadError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ArtifactMissing { tried } => write!(
                formatter,
                "Silero VAD artifact not found (tried {tried:?}); fetch {SILERO_VAD_MODEL_SOURCE} \
                 with scripts/fetch-silero-vad.sh or set {SILERO_VAD_PATH_ENV}"
            ),
            Self::ArtifactUnreadable { path, error } => {
                write!(
                    formatter,
                    "cannot read Silero VAD artifact {path:?}: {error}"
                )
            }
            Self::ChecksumMismatch {
                path,
                expected,
                actual,
            } => write!(
                formatter,
                "Silero VAD artifact {path:?} does not match pinned {SILERO_VAD_MODEL_VERSION} \
                 sha256 (expected {expected}, got {actual})"
            ),
            Self::Runtime(error) => write!(formatter, "ONNX runtime failed: {error}"),
            Self::UnsupportedSampleRate(rate) => write!(
                formatter,
                "Silero provider is pinned to {PIPELINE_SAMPLE_RATE_HZ} Hz frames, got {rate} Hz"
            ),
            Self::UnexpectedOutput(what) => {
                write!(formatter, "Silero model returned unexpected output: {what}")
            }
        }
    }
}

impl std::error::Error for SileroVadError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Runtime(error) => Some(error),
            Self::ArtifactUnreadable { error, .. } => Some(error),
            _ => None,
        }
    }
}

impl From<ort::Error> for SileroVadError {
    fn from(error: ort::Error) -> Self {
        Self::Runtime(error)
    }
}

impl From<ort::Error<ort::session::builder::SessionBuilder>> for SileroVadError {
    fn from(error: ort::Error<ort::session::builder::SessionBuilder>) -> Self {
        Self::Runtime(error.into())
    }
}

/// Streaming Silero VAD session implementing [`VoiceActivityModel`].
pub struct SileroVad {
    session: Session,
    state: Vec<f32>,
    context: [f32; CONTEXT_SAMPLES],
}

impl fmt::Debug for SileroVad {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SileroVad")
            .field("model", &SILERO_VAD_MODEL_VERSION)
            .finish_non_exhaustive()
    }
}

impl SileroVad {
    /// Load the pinned artifact from the explicit env override or the local
    /// model cache. Never downloads.
    pub fn from_pinned_artifact() -> Result<Self, SileroVadError> {
        Self::from_verified_file(locate_pinned_artifact()?)
    }

    /// Load a specific file, still enforcing the pinned checksum.
    pub fn from_verified_file(path: impl AsRef<Path>) -> Result<Self, SileroVadError> {
        let path = path.as_ref();
        let bytes = std::fs::read(path).map_err(|error| SileroVadError::ArtifactUnreadable {
            path: path.to_path_buf(),
            error,
        })?;
        let actual = hex_digest(&bytes);
        if actual != SILERO_VAD_MODEL_SHA256 {
            return Err(SileroVadError::ChecksumMismatch {
                path: path.to_path_buf(),
                expected: SILERO_VAD_MODEL_SHA256,
                actual,
            });
        }

        // Single-threaded execution keeps per-frame inference deterministic
        // and cheap; one 576-sample frame is far below parallelism payoff.
        let session = Session::builder()?
            .with_intra_threads(1)?
            .with_inter_threads(1)?
            .commit_from_memory(&bytes)?;
        Ok(Self {
            session,
            state: vec![0.0; STATE_LEN],
            context: [0.0; CONTEXT_SAMPLES],
        })
    }
}

impl VoiceActivityModel for SileroVad {
    type Error = SileroVadError;

    fn reset(&mut self) {
        self.state.fill(0.0);
        self.context = [0.0; CONTEXT_SAMPLES];
    }

    fn speech_probability(
        &mut self,
        samples: &[f32; VAD_FRAME_SAMPLES],
        sample_rate_hz: u32,
    ) -> Result<f32, Self::Error> {
        if sample_rate_hz != PIPELINE_SAMPLE_RATE_HZ {
            return Err(SileroVadError::UnsupportedSampleRate(sample_rate_hz));
        }

        let mut input = Vec::with_capacity(MODEL_INPUT_SAMPLES);
        input.extend_from_slice(&self.context);
        input.extend_from_slice(samples);
        let input_t = Tensor::from_array(([1usize, MODEL_INPUT_SAMPLES], input))?;
        let state_t = Tensor::from_array(([2usize, 1, 128], self.state.clone()))?;
        let sr_t = Tensor::from_array(([] as [usize; 0], vec![i64::from(sample_rate_hz)]))?;

        let outputs = self.session.run(ort::inputs![
            "input" => input_t,
            "state" => state_t,
            "sr" => sr_t,
        ])?;
        let (_, probability) = outputs["output"].try_extract_tensor::<f32>()?;
        let (_, next_state) = outputs["stateN"].try_extract_tensor::<f32>()?;
        let &[probability] = probability else {
            return Err(SileroVadError::UnexpectedOutput("probability shape"));
        };
        if next_state.len() != STATE_LEN {
            return Err(SileroVadError::UnexpectedOutput("state shape"));
        }
        if !probability.is_finite() {
            return Err(SileroVadError::UnexpectedOutput("non-finite probability"));
        }

        // Commit recurrent state only after a fully validated run.
        self.state.copy_from_slice(next_state);
        self.context
            .copy_from_slice(&samples[VAD_FRAME_SAMPLES - CONTEXT_SAMPLES..]);
        Ok(probability.clamp(0.0, 1.0))
    }
}

/// Resolve the pinned artifact path: `$OPENSCOUT_SILERO_VAD_ONNX` if set
/// (an explicit-but-missing path is a configuration error, not a reason to
/// fall back silently), otherwise the user model cache
/// (`$XDG_CACHE_HOME`/`~/.cache`).
pub fn locate_pinned_artifact() -> Result<PathBuf, SileroVadError> {
    if let Some(explicit) = std::env::var_os(SILERO_VAD_PATH_ENV) {
        let path = PathBuf::from(explicit);
        if path.is_file() {
            return Ok(path);
        }
        return Err(SileroVadError::ArtifactMissing { tried: vec![path] });
    }
    let mut tried = Vec::new();
    if let Some(cached) = cache_path() {
        if cached.is_file() {
            return Ok(cached);
        }
        tried.push(cached);
    }
    Err(SileroVadError::ArtifactMissing { tried })
}

/// Conventional cache location for the pinned artifact.
pub fn cache_path() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".cache")))?;
    Some(
        base.join("openscout/models/silero-vad")
            .join(SILERO_VAD_MODEL_VERSION)
            .join("silero_vad.onnx"),
    )
}

fn hex_digest(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write;
        write!(hex, "{byte:02x}").expect("writing to a String cannot fail");
    }
    hex
}
