use serde::{Deserialize, Serialize};
use std::fmt;

/// Largest integer that round-trips through JavaScript's JSON number type.
pub const MAX_WIRE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Debug, Default, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct VoiceTurnStamp {
    pub turn: u64,
    pub gen: u64,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub enum StampError {
    TurnOutOfRange(u64),
    GenerationOutOfRange(u64),
    Exhausted(&'static str),
}

impl fmt::Display for StampError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TurnOutOfRange(value) => write!(
                formatter,
                "voice turn {value} exceeds the JSON safe-integer boundary"
            ),
            Self::GenerationOutOfRange(value) => write!(
                formatter,
                "voice generation {value} exceeds the JSON safe-integer boundary"
            ),
            Self::Exhausted(field) => write!(formatter, "voice {field} counter is exhausted"),
        }
    }
}

impl std::error::Error for StampError {}

impl VoiceTurnStamp {
    pub fn new(turn: u64, gen: u64) -> Result<Self, StampError> {
        if turn > MAX_WIRE_INTEGER {
            return Err(StampError::TurnOutOfRange(turn));
        }
        if gen > MAX_WIRE_INTEGER {
            return Err(StampError::GenerationOutOfRange(gen));
        }
        Ok(Self { turn, gen })
    }

    pub fn validate(self) -> Result<Self, StampError> {
        Self::new(self.turn, self.gen)
    }
}

impl Serialize for VoiceTurnStamp {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        self.validate().map_err(serde::ser::Error::custom)?;
        #[derive(Serialize)]
        struct WireStamp {
            turn: u64,
            gen: u64,
        }

        WireStamp {
            turn: self.turn,
            gen: self.gen,
        }
        .serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for VoiceTurnStamp {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct WireStamp {
            turn: u64,
            gen: u64,
        }

        let wire = WireStamp::deserialize(deserializer)?;
        Self::new(wire.turn, wire.gen).map_err(serde::de::Error::custom)
    }
}

/// Single cancellation authority for one portable voice session.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct TurnClock {
    current: VoiceTurnStamp,
}

impl TurnClock {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn from_stamp(stamp: VoiceTurnStamp) -> Result<Self, StampError> {
        Ok(Self {
            current: stamp.validate()?,
        })
    }

    pub fn current(&self) -> VoiceTurnStamp {
        self.current
    }

    /// Preview the identity a candidate will receive if it becomes confirmed.
    pub fn next_turn_stamp(&self) -> Result<VoiceTurnStamp, StampError> {
        VoiceTurnStamp::new(
            next_counter(self.current.turn, "turn")?,
            next_counter(self.current.gen, "generation")?,
        )
    }

    /// Accept confirmed speech or a committed text turn.
    pub fn accept_turn(&mut self) -> Result<VoiceTurnStamp, StampError> {
        self.current = self.next_turn_stamp()?;
        Ok(self.current)
    }

    /// Invalidate response work without allocating a new user turn.
    pub fn cancel_generation(&mut self) -> Result<VoiceTurnStamp, StampError> {
        self.current.gen = next_counter(self.current.gen, "generation")?;
        Ok(self.current)
    }

    pub fn is_current(&self, stamp: VoiceTurnStamp) -> bool {
        self.current == stamp
    }
}

fn next_counter(value: u64, field: &'static str) -> Result<u64, StampError> {
    if value >= MAX_WIRE_INTEGER {
        return Err(StampError::Exhausted(field));
    }
    Ok(value + 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepting_a_turn_advances_both_turn_and_generation() {
        let mut clock = TurnClock::new();
        assert_eq!(
            clock.next_turn_stamp().unwrap(),
            VoiceTurnStamp { turn: 1, gen: 1 }
        );
        assert_eq!(
            clock.accept_turn().unwrap(),
            VoiceTurnStamp { turn: 1, gen: 1 }
        );
        assert_eq!(
            clock.cancel_generation().unwrap(),
            VoiceTurnStamp { turn: 1, gen: 2 }
        );
    }

    #[test]
    fn wire_stamp_rejects_numbers_javascript_cannot_represent_exactly() {
        let json = format!(r#"{{"turn":{},"gen":0}}"#, MAX_WIRE_INTEGER + 1);
        assert!(serde_json::from_str::<VoiceTurnStamp>(&json).is_err());
        assert!(serde_json::to_string(&VoiceTurnStamp {
            turn: MAX_WIRE_INTEGER + 1,
            gen: 0,
        })
        .is_err());
    }
}
