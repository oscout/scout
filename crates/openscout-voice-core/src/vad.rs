use crate::audio::{
    AudioNormalizationError, Pcm16Normalizer, VadFrame, PIPELINE_SAMPLE_RATE_HZ, VAD_FRAME_SAMPLES,
};
use crate::resample::DecimationQuality;
use crate::turn::{StampError, TurnClock, VoiceTurnStamp};
use std::collections::VecDeque;
use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VadConfig {
    pub threshold: f32,
    pub min_silence_ms: u32,
    pub min_speech_ms: u32,
    pub max_speech_ms: u32,
    pub speech_pad_ms: u32,
}

impl Default for VadConfig {
    fn default() -> Self {
        // Pinned Hugging Face speech-to-speech defaults at 0687eb1e.
        Self {
            threshold: 0.6,
            min_silence_ms: 64,
            min_speech_ms: 384,
            max_speech_ms: 30_000,
            speech_pad_ms: 500,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum VadConfigError {
    InvalidThreshold,
    ZeroMinimumSilence,
    ZeroMinimumSpeech,
    MaximumSpeechTooShort,
}

impl fmt::Display for VadConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidThreshold => write!(
                formatter,
                "VAD threshold must be finite and between 0.15 and 1.0"
            ),
            Self::ZeroMinimumSilence => {
                write!(formatter, "VAD minimum silence must be greater than zero")
            }
            Self::ZeroMinimumSpeech => {
                write!(formatter, "VAD minimum speech must be greater than zero")
            }
            Self::MaximumSpeechTooShort => write!(
                formatter,
                "VAD maximum speech must be at least the minimum speech duration"
            ),
        }
    }
}

impl std::error::Error for VadConfigError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SoftEndReason {
    AcousticSilence,
    MaximumDuration,
    StreamEnded,
}

/// Provider-neutral payload handed from acoustic VAD to Smart Turn.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SmartTurnInput {
    pcm16: Vec<i16>,
    audio_start_sample: u64,
    audio_end_sample: u64,
    active_speech_samples: u64,
    reason: SoftEndReason,
}

impl SmartTurnInput {
    pub fn pcm16(&self) -> &[i16] {
        &self.pcm16
    }

    pub fn normalized_audio(&self) -> Vec<f32> {
        self.pcm16
            .iter()
            .map(|sample| *sample as f32 / 32_768.0)
            .collect()
    }

    pub fn sample_rate_hz(&self) -> u32 {
        PIPELINE_SAMPLE_RATE_HZ
    }

    pub fn audio_start_sample(&self) -> u64 {
        self.audio_start_sample
    }

    pub fn audio_end_sample(&self) -> u64 {
        self.audio_end_sample
    }

    pub fn active_speech_samples(&self) -> u64 {
        self.active_speech_samples
    }

    pub fn active_speech_ms(&self) -> u64 {
        samples_to_ms(self.active_speech_samples)
    }

    pub fn reason(&self) -> SoftEndReason {
        self.reason
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AcousticEvent {
    CandidateStarted {
        audio_start_sample: u64,
    },
    SpeechConfirmed {
        audio_start_sample: u64,
        active_speech_samples: u64,
    },
    SoftEnded(SmartTurnInput),
    CandidateDiscarded {
        audio_start_sample: u64,
        audio_end_sample: u64,
        active_speech_samples: u64,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub enum VadSegmenterError {
    InvalidProbability(f32),
    NonContiguousFrame { expected: u64, observed: u64 },
}

impl fmt::Display for VadSegmenterError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidProbability(value) => {
                write!(
                    formatter,
                    "VAD probability must be finite in [0, 1], got {value}"
                )
            }
            Self::NonContiguousFrame { expected, observed } => write!(
                formatter,
                "VAD frame clock is discontinuous: expected sample {expected}, got {observed}"
            ),
        }
    }
}

impl std::error::Error for VadSegmenterError {}

/// Streaming Silero-compatible hysteresis and utterance buffering.
///
/// The model supplies one probability per 512-sample frame. Crossing the
/// positive threshold starts a *candidate*. Confirmation is deliberately
/// deferred until enough active speech accumulates. Acoustic silence produces
/// a soft-ended `SmartTurnInput`; it does not itself authorize response output.
#[derive(Clone, Debug)]
pub struct VadSegmenter {
    config: VadConfig,
    pre_speech: VecDeque<i16>,
    segment: Vec<i16>,
    triggered: bool,
    confirmed: bool,
    active_speech_samples: u64,
    candidate_start_sample: u64,
    silence_started_at: Option<u64>,
    next_sample: u64,
}

impl VadSegmenter {
    pub fn new(config: VadConfig) -> Result<Self, VadConfigError> {
        validate_config(config)?;
        Ok(Self {
            config,
            pre_speech: VecDeque::new(),
            segment: Vec::new(),
            triggered: false,
            confirmed: false,
            active_speech_samples: 0,
            candidate_start_sample: 0,
            silence_started_at: None,
            next_sample: 0,
        })
    }

    pub fn config(&self) -> VadConfig {
        self.config
    }

    pub fn is_candidate(&self) -> bool {
        self.triggered && !self.confirmed
    }

    pub fn is_confirmed(&self) -> bool {
        self.triggered && self.confirmed
    }

    pub fn observe(
        &mut self,
        frame: &VadFrame,
        probability: f32,
    ) -> Result<Vec<AcousticEvent>, VadSegmenterError> {
        if !probability.is_finite() || !(0.0..=1.0).contains(&probability) {
            return Err(VadSegmenterError::InvalidProbability(probability));
        }
        if frame.start_sample() != self.next_sample {
            return Err(VadSegmenterError::NonContiguousFrame {
                expected: self.next_sample,
                observed: frame.start_sample(),
            });
        }
        self.next_sample = frame.end_sample();

        if !self.triggered {
            if probability >= self.config.threshold {
                return Ok(self.start_candidate(frame));
            }
            self.remember_pre_speech(frame.samples());
            return Ok(Vec::new());
        }

        self.segment.extend_from_slice(frame.samples());
        let negative_threshold = self.config.threshold - 0.15;
        if probability >= negative_threshold {
            self.active_speech_samples += VAD_FRAME_SAMPLES as u64;
            self.silence_started_at = None;
            if self.active_speech_samples >= samples_for_ms(self.config.max_speech_ms) {
                let mut events = self.maybe_confirm();
                events.push(self.finish_candidate(SoftEndReason::MaximumDuration));
                return Ok(events);
            }
            return Ok(self.maybe_confirm());
        }

        let silence_started_at = *self.silence_started_at.get_or_insert(frame.end_sample());
        let observed_silence = frame.end_sample().saturating_sub(silence_started_at);
        if observed_silence < samples_for_ms(self.config.min_silence_ms) {
            return Ok(Vec::new());
        }

        Ok(vec![self.finish_candidate(SoftEndReason::AcousticSilence)])
    }

    pub fn finish(&mut self) -> Option<AcousticEvent> {
        self.triggered
            .then(|| self.finish_candidate(SoftEndReason::StreamEnded))
    }

    pub fn reset(&mut self) {
        self.pre_speech.clear();
        self.segment.clear();
        self.triggered = false;
        self.confirmed = false;
        self.active_speech_samples = 0;
        self.candidate_start_sample = 0;
        self.silence_started_at = None;
        self.next_sample = 0;
    }

    /// Drop an in-flight acoustic candidate without rewinding the session's
    /// audio clock. Used when the response generation is explicitly cancelled.
    pub fn abort_candidate_at(&mut self, next_sample: u64) {
        self.pre_speech.clear();
        self.segment.clear();
        self.triggered = false;
        self.confirmed = false;
        self.active_speech_samples = 0;
        self.candidate_start_sample = 0;
        self.silence_started_at = None;
        self.next_sample = next_sample;
    }

    fn start_candidate(&mut self, frame: &VadFrame) -> Vec<AcousticEvent> {
        self.triggered = true;
        self.confirmed = false;
        self.silence_started_at = None;
        self.active_speech_samples = VAD_FRAME_SAMPLES as u64;
        self.candidate_start_sample = frame
            .start_sample()
            .saturating_sub(self.pre_speech.len() as u64);
        self.segment = self.pre_speech.drain(..).collect();
        self.segment.extend_from_slice(frame.samples());

        let mut events = vec![AcousticEvent::CandidateStarted {
            audio_start_sample: self.candidate_start_sample,
        }];
        events.extend(self.maybe_confirm());
        events
    }

    fn maybe_confirm(&mut self) -> Vec<AcousticEvent> {
        if self.confirmed || self.active_speech_samples < samples_for_ms(self.config.min_speech_ms)
        {
            return Vec::new();
        }
        self.confirmed = true;
        vec![AcousticEvent::SpeechConfirmed {
            audio_start_sample: self.candidate_start_sample,
            active_speech_samples: self.active_speech_samples,
        }]
    }

    fn finish_candidate(&mut self, reason: SoftEndReason) -> AcousticEvent {
        let start = self.candidate_start_sample;
        let end = self.next_sample;
        let active = self.active_speech_samples;
        let was_confirmed = self.confirmed;
        let pcm16 = std::mem::take(&mut self.segment);

        self.triggered = false;
        self.confirmed = false;
        self.active_speech_samples = 0;
        self.candidate_start_sample = 0;
        self.silence_started_at = None;

        if was_confirmed {
            AcousticEvent::SoftEnded(SmartTurnInput {
                pcm16,
                audio_start_sample: start,
                audio_end_sample: end,
                active_speech_samples: active,
                reason,
            })
        } else {
            AcousticEvent::CandidateDiscarded {
                audio_start_sample: start,
                audio_end_sample: end,
                active_speech_samples: active,
            }
        }
    }

    fn remember_pre_speech(&mut self, samples: &[i16]) {
        self.pre_speech.extend(samples.iter().copied());
        let keep = samples_for_ms(self.config.speech_pad_ms) as usize;
        while self.pre_speech.len() > keep {
            self.pre_speech.pop_front();
        }
    }
}

pub trait VoiceActivityModel {
    type Error;

    fn reset(&mut self);

    fn speech_probability(
        &mut self,
        samples: &[f32; VAD_FRAME_SAMPLES],
        sample_rate_hz: u32,
    ) -> Result<f32, Self::Error>;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PortableVoiceEvent {
    CandidateSpeech {
        stamp: VoiceTurnStamp,
        audio_start_ms: u64,
    },
    SpeechConfirmed {
        stamp: VoiceTurnStamp,
        audio_start_ms: u64,
        active_speech_ms: u64,
    },
    TurnSoftEnded {
        stamp: VoiceTurnStamp,
        input: SmartTurnInput,
    },
    CandidateDiscarded {
        stamp: VoiceTurnStamp,
        audio_start_ms: u64,
        audio_end_ms: u64,
        active_speech_ms: u64,
    },
}

#[derive(Debug)]
pub enum PortableVadError<ModelError> {
    Audio(AudioNormalizationError),
    Config(VadConfigError),
    Segmenter(VadSegmenterError),
    Model(ModelError),
    Stamp(StampError),
}

impl<ModelError: fmt::Display> fmt::Display for PortableVadError<ModelError> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Audio(error) => error.fmt(formatter),
            Self::Config(error) => error.fmt(formatter),
            Self::Segmenter(error) => error.fmt(formatter),
            Self::Model(error) => write!(formatter, "VAD model failed: {error}"),
            Self::Stamp(error) => error.fmt(formatter),
        }
    }
}

impl<ModelError> std::error::Error for PortableVadError<ModelError> where
    ModelError: std::error::Error + 'static
{
}

impl<ModelError> From<AudioNormalizationError> for PortableVadError<ModelError> {
    fn from(error: AudioNormalizationError) -> Self {
        Self::Audio(error)
    }
}

impl<ModelError> From<VadConfigError> for PortableVadError<ModelError> {
    fn from(error: VadConfigError) -> Self {
        Self::Config(error)
    }
}

impl<ModelError> From<VadSegmenterError> for PortableVadError<ModelError> {
    fn from(error: VadSegmenterError) -> Self {
        Self::Segmenter(error)
    }
}

impl<ModelError> From<StampError> for PortableVadError<ModelError> {
    fn from(error: StampError) -> Self {
        Self::Stamp(error)
    }
}

/// End-to-end Rust acoustic edge: PCM packets -> provider probability ->
/// stamped candidate/confirmed/soft-end events.
pub struct PortableVad<Model: VoiceActivityModel> {
    normalizer: Pcm16Normalizer,
    segmenter: VadSegmenter,
    model: Model,
    turns: TurnClock,
    candidate_stamp: Option<VoiceTurnStamp>,
    active_stamp: Option<VoiceTurnStamp>,
}

impl<Model: VoiceActivityModel> PortableVad<Model> {
    pub fn new(
        source_sample_rate_hz: u32,
        channels: usize,
        config: VadConfig,
        model: Model,
    ) -> Result<Self, PortableVadError<Model::Error>> {
        Self::with_quality(
            source_sample_rate_hz,
            channels,
            DecimationQuality::default(),
            config,
            model,
        )
    }

    pub fn with_quality(
        source_sample_rate_hz: u32,
        channels: usize,
        quality: DecimationQuality,
        config: VadConfig,
        model: Model,
    ) -> Result<Self, PortableVadError<Model::Error>> {
        Ok(Self {
            normalizer: Pcm16Normalizer::with_quality(source_sample_rate_hz, channels, quality)?,
            segmenter: VadSegmenter::new(config)?,
            model,
            turns: TurnClock::new(),
            candidate_stamp: None,
            active_stamp: None,
        })
    }

    pub fn current_stamp(&self) -> VoiceTurnStamp {
        self.turns.current()
    }

    pub fn push_interleaved(
        &mut self,
        samples: &[i16],
    ) -> Result<Vec<PortableVoiceEvent>, PortableVadError<Model::Error>> {
        let frames = self.normalizer.push_interleaved(samples);
        self.process_frames(frames)
    }

    pub fn push_le_bytes(
        &mut self,
        bytes: &[u8],
    ) -> Result<Vec<PortableVoiceEvent>, PortableVadError<Model::Error>> {
        let frames = self.normalizer.push_le_bytes(bytes);
        self.process_frames(frames)
    }

    fn process_frames(
        &mut self,
        frames: Vec<VadFrame>,
    ) -> Result<Vec<PortableVoiceEvent>, PortableVadError<Model::Error>> {
        let mut events = Vec::new();
        for frame in frames {
            let normalized = frame.normalized();
            let probability = self
                .model
                .speech_probability(&normalized, PIPELINE_SAMPLE_RATE_HZ)
                .map_err(PortableVadError::Model)?;
            for event in self.segmenter.observe(&frame, probability)? {
                events.push(self.stamp_event(event)?);
            }
        }
        Ok(events)
    }

    pub fn accept_text_turn(&mut self) -> Result<VoiceTurnStamp, PortableVadError<Model::Error>> {
        if self.segmenter.is_candidate() || self.segmenter.is_confirmed() {
            self.normalizer.discard_partial();
            self.segmenter
                .abort_candidate_at(self.normalizer.pipeline_position());
            self.model.reset();
            self.candidate_stamp = None;
            self.active_stamp = None;
        }
        Ok(self.turns.accept_turn()?)
    }

    pub fn cancel_generation(&mut self) -> Result<VoiceTurnStamp, PortableVadError<Model::Error>> {
        self.normalizer.discard_partial();
        self.segmenter
            .abort_candidate_at(self.normalizer.pipeline_position());
        self.model.reset();
        self.candidate_stamp = None;
        self.active_stamp = None;
        Ok(self.turns.cancel_generation()?)
    }

    pub fn finish(&mut self) -> Result<Option<PortableVoiceEvent>, PortableVadError<Model::Error>> {
        self.segmenter
            .finish()
            .map(|event| self.stamp_event(event))
            .transpose()
    }

    pub fn reset_session(&mut self) {
        self.normalizer.reset();
        self.segmenter.reset();
        self.model.reset();
        self.turns = TurnClock::new();
        self.candidate_stamp = None;
        self.active_stamp = None;
    }

    pub fn model_mut(&mut self) -> &mut Model {
        &mut self.model
    }

    fn stamp_event(
        &mut self,
        event: AcousticEvent,
    ) -> Result<PortableVoiceEvent, PortableVadError<Model::Error>> {
        match event {
            AcousticEvent::CandidateStarted { audio_start_sample } => {
                let stamp = self.turns.next_turn_stamp()?;
                self.candidate_stamp = Some(stamp);
                Ok(PortableVoiceEvent::CandidateSpeech {
                    stamp,
                    audio_start_ms: samples_to_ms(audio_start_sample),
                })
            }
            AcousticEvent::SpeechConfirmed {
                audio_start_sample,
                active_speech_samples,
            } => {
                let stamp = self.turns.accept_turn()?;
                debug_assert_eq!(self.candidate_stamp, Some(stamp));
                self.active_stamp = Some(stamp);
                Ok(PortableVoiceEvent::SpeechConfirmed {
                    stamp,
                    audio_start_ms: samples_to_ms(audio_start_sample),
                    active_speech_ms: samples_to_ms(active_speech_samples),
                })
            }
            AcousticEvent::SoftEnded(input) => {
                let stamp = self
                    .active_stamp
                    .take()
                    .unwrap_or_else(|| self.turns.current());
                self.candidate_stamp = None;
                Ok(PortableVoiceEvent::TurnSoftEnded { stamp, input })
            }
            AcousticEvent::CandidateDiscarded {
                audio_start_sample,
                audio_end_sample,
                active_speech_samples,
            } => {
                let stamp = self.candidate_stamp.take().unwrap_or(self.turns.current());
                Ok(PortableVoiceEvent::CandidateDiscarded {
                    stamp,
                    audio_start_ms: samples_to_ms(audio_start_sample),
                    audio_end_ms: samples_to_ms(audio_end_sample),
                    active_speech_ms: samples_to_ms(active_speech_samples),
                })
            }
        }
    }
}

fn validate_config(config: VadConfig) -> Result<(), VadConfigError> {
    if !config.threshold.is_finite() || !(0.15..=1.0).contains(&config.threshold) {
        return Err(VadConfigError::InvalidThreshold);
    }
    if config.min_silence_ms == 0 {
        return Err(VadConfigError::ZeroMinimumSilence);
    }
    if config.min_speech_ms == 0 {
        return Err(VadConfigError::ZeroMinimumSpeech);
    }
    if config.max_speech_ms < config.min_speech_ms {
        return Err(VadConfigError::MaximumSpeechTooShort);
    }
    Ok(())
}

fn samples_for_ms(milliseconds: u32) -> u64 {
    u64::from(PIPELINE_SAMPLE_RATE_HZ) * u64::from(milliseconds) / 1_000
}

fn samples_to_ms(samples: u64) -> u64 {
    samples * 1_000 / u64::from(PIPELINE_SAMPLE_RATE_HZ)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::convert::Infallible;

    struct AmplitudeModel;

    impl VoiceActivityModel for AmplitudeModel {
        type Error = Infallible;

        fn reset(&mut self) {}

        fn speech_probability(
            &mut self,
            samples: &[f32; VAD_FRAME_SAMPLES],
            sample_rate_hz: u32,
        ) -> Result<f32, Self::Error> {
            assert_eq!(sample_rate_hz, PIPELINE_SAMPLE_RATE_HZ);
            Ok(if samples.iter().any(|sample| sample.abs() > 0.01) {
                0.9
            } else {
                0.0
            })
        }
    }

    /// One 512-sample pipeline frame per push: 16 kHz input is passthrough,
    /// so segmenter timing is exact and independent of filter warm-up.
    fn source_frame(value: i16) -> Vec<i16> {
        vec![value; VAD_FRAME_SAMPLES]
    }

    #[test]
    fn candidate_does_not_allocate_a_turn_until_384ms_is_confirmed() {
        let mut vad = PortableVad::new(16_000, 1, VadConfig::default(), AmplitudeModel).unwrap();

        let first = vad.push_interleaved(&source_frame(10_000)).unwrap();
        assert!(matches!(
            first.as_slice(),
            [PortableVoiceEvent::CandidateSpeech {
                stamp: VoiceTurnStamp { turn: 1, gen: 1 },
                ..
            }]
        ));
        assert_eq!(vad.current_stamp(), VoiceTurnStamp::default());

        for _ in 0..10 {
            assert!(vad
                .push_interleaved(&source_frame(10_000))
                .unwrap()
                .is_empty());
        }
        let confirmed = vad.push_interleaved(&source_frame(10_000)).unwrap();
        assert!(matches!(
            confirmed.as_slice(),
            [PortableVoiceEvent::SpeechConfirmed {
                stamp: VoiceTurnStamp { turn: 1, gen: 1 },
                active_speech_ms: 384,
                ..
            }]
        ));
        assert_eq!(vad.current_stamp(), VoiceTurnStamp { turn: 1, gen: 1 });
    }

    #[test]
    fn text_turn_replaces_an_unconfirmed_acoustic_candidate_without_double_advance() {
        let mut vad = PortableVad::new(16_000, 1, VadConfig::default(), AmplitudeModel).unwrap();

        let candidate = vad.push_interleaved(&source_frame(10_000)).unwrap();
        assert!(matches!(
            candidate.as_slice(),
            [PortableVoiceEvent::CandidateSpeech {
                stamp: VoiceTurnStamp { turn: 1, gen: 1 },
                ..
            }]
        ));

        assert_eq!(
            vad.accept_text_turn().unwrap(),
            VoiceTurnStamp { turn: 1, gen: 1 }
        );
        assert_eq!(vad.current_stamp(), VoiceTurnStamp { turn: 1, gen: 1 });

        let next = vad.push_interleaved(&source_frame(10_000)).unwrap();
        assert!(matches!(
            next.as_slice(),
            [PortableVoiceEvent::CandidateSpeech {
                stamp: VoiceTurnStamp { turn: 2, gen: 2 },
                ..
            }]
        ));
    }

    #[test]
    fn continuous_speech_soft_ends_at_the_configured_maximum() {
        let config = VadConfig {
            min_speech_ms: 64,
            max_speech_ms: 320,
            speech_pad_ms: 0,
            ..VadConfig::default()
        };
        let mut vad = PortableVad::new(16_000, 1, config, AmplitudeModel).unwrap();
        let mut events = Vec::new();

        for _ in 0..10 {
            events.extend(vad.push_interleaved(&source_frame(10_000)).unwrap());
        }

        let Some(PortableVoiceEvent::TurnSoftEnded { input, .. }) = events.last() else {
            panic!("expected bounded soft end, got {events:?}");
        };
        assert_eq!(input.reason(), SoftEndReason::MaximumDuration);
        assert_eq!(input.active_speech_ms(), 320);
        assert_eq!(input.pcm16().len(), 10 * VAD_FRAME_SAMPLES);
        assert!(!vad.segmenter.is_confirmed());
    }

    #[test]
    fn confirmed_speech_soft_ends_into_a_smart_turn_input() {
        let mut vad = PortableVad::new(16_000, 1, VadConfig::default(), AmplitudeModel).unwrap();
        for _ in 0..12 {
            vad.push_interleaved(&source_frame(10_000)).unwrap();
        }

        assert!(vad.push_interleaved(&source_frame(0)).unwrap().is_empty());
        assert!(vad.push_interleaved(&source_frame(0)).unwrap().is_empty());
        let ended = vad.push_interleaved(&source_frame(0)).unwrap();

        let [PortableVoiceEvent::TurnSoftEnded { stamp, input }] = ended.as_slice() else {
            panic!("expected one soft-ended turn, got {ended:?}");
        };
        assert_eq!(*stamp, VoiceTurnStamp { turn: 1, gen: 1 });
        assert_eq!(input.sample_rate_hz(), 16_000);
        assert_eq!(input.active_speech_ms(), 384);
        assert_eq!(input.reason(), SoftEndReason::AcousticSilence);
        assert_eq!(input.pcm16().len(), 15 * VAD_FRAME_SAMPLES);
    }

    /// Replays a scripted probability per frame and counts resets.
    struct ScriptedModel {
        probabilities: std::collections::VecDeque<f32>,
        resets: usize,
    }

    impl ScriptedModel {
        fn new(probabilities: impl IntoIterator<Item = f32>) -> Self {
            Self {
                probabilities: probabilities.into_iter().collect(),
                resets: 0,
            }
        }
    }

    impl VoiceActivityModel for ScriptedModel {
        type Error = Infallible;

        fn reset(&mut self) {
            self.resets += 1;
        }

        fn speech_probability(
            &mut self,
            _samples: &[f32; VAD_FRAME_SAMPLES],
            _sample_rate_hz: u32,
        ) -> Result<f32, Self::Error> {
            Ok(self.probabilities.pop_front().unwrap_or(0.0))
        }
    }

    #[test]
    fn hysteresis_keeps_a_candidate_alive_between_the_two_thresholds() {
        // 0.9 crosses the 0.6 trigger; 0.5 stays above the 0.45 negative
        // threshold, so active speech keeps accumulating to confirmation.
        let mut probabilities = vec![0.9f32];
        probabilities.extend(std::iter::repeat_n(0.5f32, 11));
        probabilities.extend([0.0, 0.0, 0.0]);
        let model = ScriptedModel::new(probabilities);
        let mut vad = PortableVad::new(16_000, 1, VadConfig::default(), model).unwrap();

        let mut events = Vec::new();
        for _ in 0..15 {
            events.extend(vad.push_interleaved(&source_frame(1_000)).unwrap());
        }

        assert!(matches!(
            events.as_slice(),
            [
                PortableVoiceEvent::CandidateSpeech { .. },
                PortableVoiceEvent::SpeechConfirmed {
                    active_speech_ms: 384,
                    ..
                },
                PortableVoiceEvent::TurnSoftEnded { .. },
            ]
        ));
    }

    #[test]
    fn soft_ended_segments_carry_the_pre_roll_audio() {
        // Three quiet frames (value 7) precede the trigger; the 500 ms pad
        // must include them in both the start clock and the PCM segment.
        let mut probabilities = vec![0.0f32; 3];
        probabilities.extend(std::iter::repeat_n(0.9f32, 14));
        probabilities.extend([0.0, 0.0, 0.0]);
        let model = ScriptedModel::new(probabilities);
        let mut vad = PortableVad::new(16_000, 1, VadConfig::default(), model).unwrap();

        let mut events = Vec::new();
        for _ in 0..3 {
            events.extend(vad.push_interleaved(&source_frame(7)).unwrap());
        }
        for _ in 0..17 {
            events.extend(vad.push_interleaved(&source_frame(100)).unwrap());
        }

        let Some(PortableVoiceEvent::TurnSoftEnded { input, .. }) = events.last() else {
            panic!("expected a soft end, got {events:?}");
        };
        assert_eq!(samples_to_ms(input.audio_start_sample()), 0);
        assert_eq!(input.active_speech_ms(), 14 * 32);
        assert_eq!(&input.pcm16()[..3 * VAD_FRAME_SAMPLES], &[7; 3 * 512][..]);
        assert_eq!(input.pcm16()[3 * VAD_FRAME_SAMPLES], 100);
    }

    #[test]
    fn cancellation_resets_the_model_and_keeps_the_frame_clock_contiguous() {
        let model = ScriptedModel::new(vec![0.9f32; 40]);
        let mut vad = PortableVad::new(16_000, 1, VadConfig::default(), model).unwrap();

        // Mid-candidate with a partial frame pending.
        vad.push_interleaved(&source_frame(1_000)).unwrap();
        vad.push_interleaved(&[1_000; 100]).unwrap();

        let stamp = vad.cancel_generation().unwrap();
        assert_eq!(stamp, VoiceTurnStamp { turn: 0, gen: 1 });
        assert_eq!(vad.model_mut().resets, 1);

        // The next full frame must not trip the contiguity guard, and a new
        // candidate must carry the post-cancellation generation.
        let events = vad.push_interleaved(&source_frame(1_000)).unwrap();
        assert!(matches!(
            events.as_slice(),
            [PortableVoiceEvent::CandidateSpeech {
                stamp: VoiceTurnStamp { turn: 1, gen: 2 },
                ..
            }]
        ));

        vad.reset_session();
        assert_eq!(vad.model_mut().resets, 2);
        assert_eq!(vad.current_stamp(), VoiceTurnStamp::default());
    }

    #[test]
    fn events_are_invariant_to_source_packet_boundaries() {
        // 48 kHz stereo through the production decimator: identical audio
        // split at arbitrary packet sizes must yield identical events.
        let mut source = Vec::new();
        for index in 0..VAD_FRAME_SAMPLES * 36 {
            let value = if (VAD_FRAME_SAMPLES * 6..VAD_FRAME_SAMPLES * 30).contains(&index) {
                let phase = 2.0 * std::f64::consts::PI * 440.0 * index as f64 / 48_000.0;
                (10_000.0 * phase.sin()) as i16
            } else {
                0
            };
            source.extend_from_slice(&[value, value]);
        }

        let run = |packet_samples: usize| {
            let mut vad =
                PortableVad::new(48_000, 2, VadConfig::default(), AmplitudeModel).unwrap();
            let mut events = Vec::new();
            for packet in source.chunks(packet_samples) {
                events.extend(vad.push_interleaved(packet).unwrap());
            }
            events.extend(vad.finish().unwrap());
            events
        };

        let expected = run(source.len());
        assert!(!expected.is_empty());
        for packet_samples in [1usize, 3, 7, 137, 960, 1_919] {
            assert_eq!(run(packet_samples), expected, "packet {packet_samples}");
        }
    }

    #[test]
    fn short_noise_is_discarded_without_advancing_the_turn_clock() {
        let mut vad = PortableVad::new(16_000, 1, VadConfig::default(), AmplitudeModel).unwrap();
        vad.push_interleaved(&source_frame(10_000)).unwrap();
        vad.push_interleaved(&source_frame(10_000)).unwrap();
        vad.push_interleaved(&source_frame(0)).unwrap();
        vad.push_interleaved(&source_frame(0)).unwrap();
        let discarded = vad.push_interleaved(&source_frame(0)).unwrap();

        assert!(matches!(
            discarded.as_slice(),
            [PortableVoiceEvent::CandidateDiscarded {
                stamp: VoiceTurnStamp { turn: 1, gen: 1 },
                active_speech_ms: 64,
                ..
            }]
        ));
        assert_eq!(vad.current_stamp(), VoiceTurnStamp::default());
    }
}
