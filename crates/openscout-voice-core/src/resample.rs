//! Streaming decimators for the 48/32 → 16 kHz media edge.
//!
//! Two implementations share one contract: exactly one output sample per
//! `factor` input samples, state carried across arbitrary packet boundaries,
//! and no dependence on wall-clock or allocation order, so replaying a stream
//! is bit-identical regardless of how it was chunked.

/// Decimation strategy for integer-rate PCM downsampling.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum DecimationQuality {
    /// Bring-up compatibility path: boxcar average of each factor-sized
    /// block. Cheap and exact for conformance replay, but folds everything
    /// above the output Nyquist back into the audible band (a 12 kHz tone in
    /// a 48 kHz stream survives decimation only ~12.5 dB down).
    Box,
    /// Production path: linear-phase Kaiser windowed-sinc low-pass, applied
    /// polyphase so only emitted samples are computed. Designed for ≥80 dB
    /// stopband attenuation above 8 kHz with a 7–8 kHz transition band.
    #[default]
    WindowedSinc,
}

/// One output per `factor` inputs, regardless of strategy.
#[derive(Clone, Debug)]
pub(crate) enum Decimator {
    Passthrough,
    Box(BoxDecimator),
    Fir(FirDecimator),
}

impl Decimator {
    pub(crate) fn new(factor: usize, quality: DecimationQuality) -> Self {
        assert!(factor >= 1, "decimation factor must be positive");
        if factor == 1 {
            return Self::Passthrough;
        }
        match quality {
            DecimationQuality::Box => Self::Box(BoxDecimator::new(factor)),
            DecimationQuality::WindowedSinc => Self::Fir(FirDecimator::new(factor)),
        }
    }

    /// Feed one input sample; returns the decimated sample when one is due.
    pub(crate) fn push(&mut self, sample: i16) -> Option<i16> {
        match self {
            Self::Passthrough => Some(sample),
            Self::Box(decimator) => decimator.push(sample),
            Self::Fir(decimator) => decimator.push(sample),
        }
    }

    /// Drop partial-block progress without touching learned filter history.
    /// The FIR history is a window over already-consumed audio, not partial
    /// progress, so discarding it would glitch the next emitted samples.
    pub(crate) fn discard_partial(&mut self) {
        match self {
            Self::Passthrough => {}
            Self::Box(decimator) => decimator.discard_partial(),
            Self::Fir(decimator) => decimator.discard_partial(),
        }
    }

    pub(crate) fn reset(&mut self) {
        match self {
            Self::Passthrough => {}
            Self::Box(decimator) => decimator.reset(),
            Self::Fir(decimator) => decimator.reset(),
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct BoxDecimator {
    factor: usize,
    sum: i64,
    pending: usize,
}

impl BoxDecimator {
    fn new(factor: usize) -> Self {
        Self {
            factor,
            sum: 0,
            pending: 0,
        }
    }

    fn push(&mut self, sample: i16) -> Option<i16> {
        self.sum += i64::from(sample);
        self.pending += 1;
        if self.pending != self.factor {
            return None;
        }
        let average = (self.sum / self.factor as i64) as i16;
        self.sum = 0;
        self.pending = 0;
        Some(average)
    }

    fn discard_partial(&mut self) {
        self.sum = 0;
        self.pending = 0;
    }

    fn reset(&mut self) {
        self.discard_partial();
    }
}

/// Linear-phase FIR low-pass + decimation with a ring-buffer history.
///
/// The filter introduces a fixed group delay of `(taps - 1) / 2` input
/// samples (≈2.5 ms at 48 kHz); sample *count* is unaffected, so the
/// pipeline's physical audio clock still advances one output sample per
/// `factor` inputs.
#[derive(Clone, Debug)]
pub(crate) struct FirDecimator {
    factor: usize,
    taps: Vec<f64>,
    history: Vec<f64>,
    next_slot: usize,
    pending: usize,
}

impl FirDecimator {
    fn new(factor: usize) -> Self {
        let taps = kaiser_lowpass_taps(factor);
        let history = vec![0.0; taps.len()];
        Self {
            factor,
            taps,
            history,
            next_slot: 0,
            pending: 0,
        }
    }

    fn push(&mut self, sample: i16) -> Option<i16> {
        self.history[self.next_slot] = f64::from(sample);
        self.next_slot = (self.next_slot + 1) % self.history.len();
        self.pending += 1;
        if self.pending != self.factor {
            return None;
        }
        self.pending = 0;

        // history[next_slot - 1] is the newest sample; convolve backwards.
        let len = self.history.len();
        let newest = (self.next_slot + len - 1) % len;
        let mut accumulator = 0.0;
        for (tap_index, tap) in self.taps.iter().enumerate() {
            let slot = (newest + len - tap_index) % len;
            accumulator += tap * self.history[slot];
        }
        Some(quantize(accumulator))
    }

    fn discard_partial(&mut self) {
        self.pending = 0;
    }

    fn reset(&mut self) {
        self.history.fill(0.0);
        self.next_slot = 0;
        self.pending = 0;
    }
}

fn quantize(value: f64) -> i16 {
    value
        .round()
        .clamp(f64::from(i16::MIN), f64::from(i16::MAX)) as i16
}

/// Kaiser-designed low-pass for decimating `16 kHz * factor` input down to
/// the 16 kHz pipeline rate: passband edge 7 kHz, stopband edge 8 kHz
/// (the output Nyquist), 80 dB stopband attenuation, unity DC gain.
/// Everything is f64 arithmetic on constants, so tap values are identical
/// on every platform and run.
fn kaiser_lowpass_taps(factor: usize) -> Vec<f64> {
    const ATTENUATION_DB: f64 = 80.0;
    const PASSBAND_EDGE_HZ: f64 = 7_000.0;
    const STOPBAND_EDGE_HZ: f64 = 8_000.0;

    let input_rate_hz = 16_000.0 * factor as f64;
    let transition = (STOPBAND_EDGE_HZ - PASSBAND_EDGE_HZ) / input_rate_hz;
    let mut tap_count = ((ATTENUATION_DB - 7.95)
        / (2.285 * 2.0 * std::f64::consts::PI * transition))
        .ceil() as usize;
    if tap_count.is_multiple_of(2) {
        tap_count += 1;
    }

    let beta = 0.1102 * (ATTENUATION_DB - 8.7);
    let cutoff = (PASSBAND_EDGE_HZ + STOPBAND_EDGE_HZ) / 2.0 / input_rate_hz;
    let middle = (tap_count - 1) as f64 / 2.0;
    let denominator = bessel_i0(beta);

    let mut taps: Vec<f64> = (0..tap_count)
        .map(|index| {
            let offset = index as f64 - middle;
            let sinc = if offset == 0.0 {
                2.0 * cutoff
            } else {
                (2.0 * std::f64::consts::PI * cutoff * offset).sin()
                    / (std::f64::consts::PI * offset)
            };
            let window_arg = 1.0 - (offset / middle).powi(2);
            sinc * bessel_i0(beta * window_arg.max(0.0).sqrt()) / denominator
        })
        .collect();

    let gain: f64 = taps.iter().sum();
    for tap in &mut taps {
        *tap /= gain;
    }
    taps
}

/// Zeroth-order modified Bessel function of the first kind (series form).
fn bessel_i0(x: f64) -> f64 {
    let mut term = 1.0;
    let mut sum = 1.0;
    let half_x = x / 2.0;
    for k in 1..64 {
        term *= (half_x / k as f64).powi(2);
        sum += term;
        if term < sum * 1e-18 {
            break;
        }
    }
    sum
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decimate_all(decimator: &mut Decimator, input: &[i16]) -> Vec<i16> {
        input
            .iter()
            .filter_map(|sample| decimator.push(*sample))
            .collect()
    }

    fn sine(rate_hz: f64, frequency_hz: f64, amplitude: f64, samples: usize) -> Vec<i16> {
        (0..samples)
            .map(|index| {
                let phase = 2.0 * std::f64::consts::PI * frequency_hz * index as f64 / rate_hz;
                (amplitude * phase.sin()).round() as i16
            })
            .collect()
    }

    fn rms(samples: &[i16]) -> f64 {
        let energy: f64 = samples
            .iter()
            .map(|sample| f64::from(*sample).powi(2))
            .sum();
        (energy / samples.len() as f64).sqrt()
    }

    /// Skip the filter warm-up before measuring steady-state content.
    fn steady(samples: &[i16]) -> &[i16] {
        &samples[512..]
    }

    #[test]
    fn windowed_sinc_rejects_aliasing_the_box_filter_lets_through() {
        let amplitude = 16_000.0;
        // 12.5 kHz at 48 kHz input folds to 3.5 kHz after decimation to 16 kHz.
        let input = sine(48_000.0, 12_500.0, amplitude, 48_000);

        let mut fir = Decimator::new(3, DecimationQuality::WindowedSinc);
        let mut boxcar = Decimator::new(3, DecimationQuality::Box);
        let fir_alias = rms(steady(&decimate_all(&mut fir, &input)));
        let box_alias = rms(steady(&decimate_all(&mut boxcar, &input)));

        let input_rms = amplitude / 2.0_f64.sqrt();
        let fir_rejection_db = 20.0 * (input_rms / fir_alias.max(1e-9)).log10();
        let box_rejection_db = 20.0 * (input_rms / box_alias.max(1e-9)).log10();
        assert!(
            fir_rejection_db >= 75.0,
            "windowed-sinc alias rejection was only {fir_rejection_db:.1} dB"
        );
        assert!(
            box_rejection_db < 20.0,
            "box filter unexpectedly rejects {box_rejection_db:.1} dB; comparison is stale"
        );
    }

    #[test]
    fn windowed_sinc_preserves_the_passband_within_a_tenth_of_a_decibel() {
        for factor in [2usize, 3] {
            let rate = 16_000.0 * factor as f64;
            let amplitude = 16_000.0;
            let input = sine(rate, 1_000.0, amplitude, rate as usize);
            let mut fir = Decimator::new(factor, DecimationQuality::WindowedSinc);
            let output_rms = rms(steady(&decimate_all(&mut fir, &input)));
            let expected_rms = amplitude / 2.0_f64.sqrt();
            let deviation_db = 20.0 * (output_rms / expected_rms).log10().abs();
            assert!(
                deviation_db < 0.1,
                "factor {factor}: passband deviation {deviation_db:.3} dB"
            );
        }
    }

    #[test]
    fn windowed_sinc_output_is_invariant_to_packet_boundaries() {
        let input = sine(48_000.0, 700.0, 12_000.0, 9_600);
        let mut whole = Decimator::new(3, DecimationQuality::WindowedSinc);
        let expected = decimate_all(&mut whole, &input);

        for chunk_size in [1usize, 2, 3, 7, 480, 959] {
            let mut chunked = Decimator::new(3, DecimationQuality::WindowedSinc);
            let mut observed = Vec::new();
            for chunk in input.chunks(chunk_size) {
                observed.extend(decimate_all(&mut chunked, chunk));
            }
            assert_eq!(observed, expected, "chunk size {chunk_size} diverged");
        }
    }

    #[test]
    fn every_strategy_emits_exactly_one_sample_per_factor_inputs() {
        for quality in [DecimationQuality::Box, DecimationQuality::WindowedSinc] {
            for factor in [1usize, 2, 3] {
                let mut decimator = Decimator::new(factor, quality);
                let emitted = decimate_all(&mut decimator, &vec![100; factor * 100]);
                assert_eq!(emitted.len(), 100, "{quality:?} factor {factor}");
            }
        }
    }

    #[test]
    fn filter_taps_are_normalized_and_symmetric() {
        for factor in [2usize, 3] {
            let taps = kaiser_lowpass_taps(factor);
            assert_eq!(taps.len() % 2, 1);
            let gain: f64 = taps.iter().sum();
            assert!((gain - 1.0).abs() < 1e-12);
            for (left, right) in taps.iter().zip(taps.iter().rev()) {
                assert!((left - right).abs() < 1e-15, "asymmetric taps");
            }
        }
    }
}
