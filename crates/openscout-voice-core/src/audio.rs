use crate::resample::{DecimationQuality, Decimator};
use std::fmt;

pub const PIPELINE_SAMPLE_RATE_HZ: u32 = 16_000;
pub const VAD_FRAME_SAMPLES: usize = 512;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VadFrame {
    start_sample: u64,
    samples: [i16; VAD_FRAME_SAMPLES],
}

impl VadFrame {
    pub fn new(start_sample: u64, samples: [i16; VAD_FRAME_SAMPLES]) -> Self {
        Self {
            start_sample,
            samples,
        }
    }

    pub fn start_sample(&self) -> u64 {
        self.start_sample
    }

    pub fn end_sample(&self) -> u64 {
        self.start_sample + VAD_FRAME_SAMPLES as u64
    }

    pub fn samples(&self) -> &[i16; VAD_FRAME_SAMPLES] {
        &self.samples
    }

    pub fn normalized(&self) -> [f32; VAD_FRAME_SAMPLES] {
        let mut normalized = [0.0; VAD_FRAME_SAMPLES];
        for (target, sample) in normalized.iter_mut().zip(self.samples) {
            *target = sample as f32 / 32_768.0;
        }
        normalized
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AudioNormalizationError {
    InvalidChannelCount,
    UnsupportedSampleRate(u32),
}

impl fmt::Display for AudioNormalizationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidChannelCount => {
                write!(formatter, "PCM input must have at least one channel")
            }
            Self::UnsupportedSampleRate(rate) => write!(
                formatter,
                "PCM input rate {rate} Hz is unsupported; expected 16, 32, or 48 kHz"
            ),
        }
    }
}

impl std::error::Error for AudioNormalizationError {}

/// Stateful PCM16 normalizer for the portable voice media edge.
///
/// Interleaved channels are averaged to mono. Input rates that are integer
/// multiples of 16 kHz are low-pass decimated (windowed-sinc by default, the
/// bring-up box filter on request), then accumulated into exact 512-sample
/// frames. Packet and channel boundaries may split arbitrarily across calls
/// without losing samples.
#[derive(Clone, Debug)]
pub struct Pcm16Normalizer {
    source_sample_rate_hz: u32,
    channels: usize,
    quality: DecimationQuality,
    channel_sum: i64,
    channel_samples: usize,
    decimator: Decimator,
    frame: [i16; VAD_FRAME_SAMPLES],
    frame_samples: usize,
    next_pipeline_sample: u64,
    pending_byte: Option<u8>,
}

impl Pcm16Normalizer {
    pub fn new(
        source_sample_rate_hz: u32,
        channels: usize,
    ) -> Result<Self, AudioNormalizationError> {
        Self::with_quality(
            source_sample_rate_hz,
            channels,
            DecimationQuality::default(),
        )
    }

    pub fn with_quality(
        source_sample_rate_hz: u32,
        channels: usize,
        quality: DecimationQuality,
    ) -> Result<Self, AudioNormalizationError> {
        if channels == 0 {
            return Err(AudioNormalizationError::InvalidChannelCount);
        }
        if source_sample_rate_hz < PIPELINE_SAMPLE_RATE_HZ
            || !source_sample_rate_hz.is_multiple_of(PIPELINE_SAMPLE_RATE_HZ)
        {
            return Err(AudioNormalizationError::UnsupportedSampleRate(
                source_sample_rate_hz,
            ));
        }
        let factor = (source_sample_rate_hz / PIPELINE_SAMPLE_RATE_HZ) as usize;
        if !(1..=3).contains(&factor) {
            return Err(AudioNormalizationError::UnsupportedSampleRate(
                source_sample_rate_hz,
            ));
        }
        Ok(Self {
            source_sample_rate_hz,
            channels,
            quality,
            channel_sum: 0,
            channel_samples: 0,
            decimator: Decimator::new(factor, quality),
            frame: [0; VAD_FRAME_SAMPLES],
            frame_samples: 0,
            next_pipeline_sample: 0,
            pending_byte: None,
        })
    }

    pub fn source_sample_rate_hz(&self) -> u32 {
        self.source_sample_rate_hz
    }

    pub fn channels(&self) -> usize {
        self.channels
    }

    pub fn quality(&self) -> DecimationQuality {
        self.quality
    }

    pub fn push_interleaved(&mut self, samples: &[i16]) -> Vec<VadFrame> {
        let mut frames = Vec::new();
        for sample in samples {
            self.channel_sum += i64::from(*sample);
            self.channel_samples += 1;
            if self.channel_samples != self.channels {
                continue;
            }

            let mono = (self.channel_sum / self.channels as i64) as i16;
            self.channel_sum = 0;
            self.channel_samples = 0;
            self.push_mono_sample(mono, &mut frames);
        }
        frames
    }

    pub fn push_le_bytes(&mut self, bytes: &[u8]) -> Vec<VadFrame> {
        let mut samples =
            Vec::with_capacity((bytes.len() + usize::from(self.pending_byte.is_some())) / 2);
        let mut index = 0;

        if let Some(low) = self.pending_byte.take() {
            if let Some(high) = bytes.first() {
                samples.push(i16::from_le_bytes([low, *high]));
                index = 1;
            } else {
                self.pending_byte = Some(low);
                return Vec::new();
            }
        }

        while index + 1 < bytes.len() {
            samples.push(i16::from_le_bytes([bytes[index], bytes[index + 1]]));
            index += 2;
        }
        if index < bytes.len() {
            self.pending_byte = Some(bytes[index]);
        }
        self.push_interleaved(&samples)
    }

    pub fn pending_pipeline_samples(&self) -> usize {
        self.frame_samples
    }

    pub fn pipeline_position(&self) -> u64 {
        self.next_pipeline_sample
    }

    /// Drop incomplete channel, rate-conversion, byte, and VAD-frame state
    /// without rewinding the session audio clock.
    pub fn discard_partial(&mut self) {
        self.channel_sum = 0;
        self.channel_samples = 0;
        self.decimator.discard_partial();
        self.frame = [0; VAD_FRAME_SAMPLES];
        self.frame_samples = 0;
        self.pending_byte = None;
    }

    pub fn reset(&mut self) {
        self.channel_sum = 0;
        self.channel_samples = 0;
        self.decimator.reset();
        self.frame = [0; VAD_FRAME_SAMPLES];
        self.frame_samples = 0;
        self.next_pipeline_sample = 0;
        self.pending_byte = None;
    }

    fn push_mono_sample(&mut self, sample: i16, frames: &mut Vec<VadFrame>) {
        let Some(normalized) = self.decimator.push(sample) else {
            return;
        };
        self.frame[self.frame_samples] = normalized;
        self.frame_samples += 1;
        self.next_pipeline_sample += 1;

        if self.frame_samples == VAD_FRAME_SAMPLES {
            let start_sample = self.next_pipeline_sample - VAD_FRAME_SAMPLES as u64;
            let complete = std::mem::replace(&mut self.frame, [0; VAD_FRAME_SAMPLES]);
            self.frame_samples = 0;
            frames.push(VadFrame::new(start_sample, complete));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_split_48k_packets_into_one_clocked_16k_frame() {
        let mut normalizer =
            Pcm16Normalizer::with_quality(48_000, 1, DecimationQuality::Box).unwrap();
        let source: Vec<i16> = (0..(VAD_FRAME_SAMPLES * 3))
            .map(|index| (index % 900) as i16)
            .collect();

        assert!(normalizer.push_interleaved(&source[..959]).is_empty());
        let frames = normalizer.push_interleaved(&source[959..]);

        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].start_sample(), 0);
        assert_eq!(frames[0].end_sample(), 512);
        for (index, sample) in frames[0].samples().iter().enumerate() {
            let source_index = index * 3;
            let expected = (i64::from(source[source_index])
                + i64::from(source[source_index + 1])
                + i64::from(source[source_index + 2]))
                / 3;
            assert_eq!(i64::from(*sample), expected);
        }
        assert_eq!(normalizer.pending_pipeline_samples(), 0);
    }

    #[test]
    fn downmixes_stereo_even_when_a_call_splits_between_channels() {
        let mut normalizer = Pcm16Normalizer::new(16_000, 2).unwrap();
        let mut source = Vec::with_capacity(VAD_FRAME_SAMPLES * 2);
        for _ in 0..VAD_FRAME_SAMPLES {
            source.extend_from_slice(&[1_000, -500]);
        }

        assert!(normalizer.push_interleaved(&source[..1]).is_empty());
        let frames = normalizer.push_interleaved(&source[1..]);

        assert_eq!(frames.len(), 1);
        assert!(frames[0].samples().iter().all(|sample| *sample == 250));
    }

    #[test]
    fn preserves_an_odd_pcm_byte_across_calls() {
        let mut normalizer = Pcm16Normalizer::new(16_000, 1).unwrap();
        let samples = vec![123_i16; VAD_FRAME_SAMPLES];
        let bytes: Vec<u8> = samples
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect();

        assert!(normalizer.push_le_bytes(&bytes[..511]).is_empty());
        let frames = normalizer.push_le_bytes(&bytes[511..]);

        assert_eq!(frames.len(), 1);
        assert!(frames[0].samples().iter().all(|sample| *sample == 123));
    }

    #[test]
    fn discarding_a_partial_frame_preserves_the_physical_audio_clock() {
        let mut normalizer = Pcm16Normalizer::new(16_000, 1).unwrap();
        assert!(normalizer.push_interleaved(&[1; 100]).is_empty());
        assert_eq!(normalizer.pipeline_position(), 100);

        normalizer.discard_partial();
        let frames = normalizer.push_interleaved(&[2; VAD_FRAME_SAMPLES]);

        assert_eq!(frames[0].start_sample(), 100);
    }

    #[test]
    fn windowed_sinc_48k_frames_are_invariant_to_packet_boundaries() {
        let source: Vec<i16> = (0..VAD_FRAME_SAMPLES * 9)
            .map(|index| {
                let phase = 2.0 * std::f64::consts::PI * 440.0 * index as f64 / 48_000.0;
                (12_000.0 * phase.sin()) as i16
            })
            .collect();

        let mut whole = Pcm16Normalizer::new(48_000, 1).unwrap();
        let expected = whole.push_interleaved(&source);
        assert_eq!(expected.len(), 3);

        for chunk_size in [1usize, 7, 160, 959] {
            let mut chunked = Pcm16Normalizer::new(48_000, 1).unwrap();
            let mut observed = Vec::new();
            for chunk in source.chunks(chunk_size) {
                observed.extend(chunked.push_interleaved(chunk));
            }
            assert_eq!(observed, expected, "chunk size {chunk_size} diverged");
        }
    }

    #[test]
    fn windowed_sinc_stereo_32k_keeps_the_frame_clock() {
        let mut normalizer = Pcm16Normalizer::new(32_000, 2).unwrap();
        let mut source = Vec::new();
        for index in 0..VAD_FRAME_SAMPLES * 2 {
            let phase = 2.0 * std::f64::consts::PI * 300.0 * index as f64 / 32_000.0;
            let value = (9_000.0 * phase.sin()) as i16;
            source.extend_from_slice(&[value, value]);
        }

        let frames = normalizer.push_interleaved(&source);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].start_sample(), 0);
        assert_eq!(normalizer.pipeline_position(), VAD_FRAME_SAMPLES as u64);
    }
}
