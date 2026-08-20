use crate::turn::{StampError, VoiceTurnStamp};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Reversibility {
    Reversible,
    Compensatable,
    Irreversible,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EffectState {
    Proposed,
    Committed,
    Suppressed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectEntry {
    pub effect_id: String,
    pub kind: String,
    pub reversibility: Reversibility,
    pub stamp: VoiceTurnStamp,
    pub state: EffectState,
    pub reason: Option<String>,
    #[serde(skip)]
    result_recorded: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EffectCommitOutcome {
    pub entry: EffectEntry,
    pub transitioned: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EffectResultOutcome {
    Accepted { entry: EffectEntry, late: bool },
    Duplicate { entry: EffectEntry, late: bool },
    Rejected { entry: Option<EffectEntry> },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EffectLedgerError {
    EmptyEffectId,
    EmptyKind,
    DuplicateEffectId(String),
    InvalidStamp(StampError),
}

impl fmt::Display for EffectLedgerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyEffectId => write!(formatter, "voice effect id is required"),
            Self::EmptyKind => write!(formatter, "voice effect kind is required"),
            Self::DuplicateEffectId(effect_id) => {
                write!(formatter, "voice effect already exists: {effect_id}")
            }
            Self::InvalidStamp(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for EffectLedgerError {}

#[derive(Clone, Debug, Default)]
pub struct EffectLedger {
    entries: BTreeMap<String, EffectEntry>,
}

impl EffectLedger {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn propose(
        &mut self,
        effect_id: impl Into<String>,
        kind: impl Into<String>,
        reversibility: Reversibility,
        stamp: VoiceTurnStamp,
    ) -> Result<EffectEntry, EffectLedgerError> {
        let effect_id = effect_id.into();
        let kind = kind.into();
        if effect_id.is_empty() {
            return Err(EffectLedgerError::EmptyEffectId);
        }
        if kind.is_empty() {
            return Err(EffectLedgerError::EmptyKind);
        }
        if self.entries.contains_key(&effect_id) {
            return Err(EffectLedgerError::DuplicateEffectId(effect_id));
        }
        stamp.validate().map_err(EffectLedgerError::InvalidStamp)?;
        let entry = EffectEntry {
            effect_id: effect_id.clone(),
            kind,
            reversibility,
            stamp,
            state: EffectState::Proposed,
            reason: None,
            result_recorded: false,
        };
        self.entries.insert(effect_id, entry.clone());
        Ok(entry)
    }

    pub fn get(&self, effect_id: &str) -> Option<&EffectEntry> {
        self.entries.get(effect_id)
    }

    pub fn commit(
        &mut self,
        effect_id: &str,
        observed_stamp: VoiceTurnStamp,
        current_stamp: VoiceTurnStamp,
    ) -> Option<EffectCommitOutcome> {
        let entry = self.entries.get_mut(effect_id)?;
        if entry.state != EffectState::Proposed {
            return Some(EffectCommitOutcome {
                entry: entry.clone(),
                transitioned: false,
            });
        }

        if entry.stamp == observed_stamp && entry.stamp == current_stamp {
            entry.state = EffectState::Committed;
        } else {
            entry.state = EffectState::Suppressed;
            entry.reason = Some("stale_generation".to_owned());
        }
        Some(EffectCommitOutcome {
            entry: entry.clone(),
            transitioned: true,
        })
    }

    pub fn suppress(&mut self, effect_id: &str, reason: impl Into<String>) -> Option<EffectEntry> {
        let entry = self.entries.get_mut(effect_id)?;
        if entry.state == EffectState::Proposed {
            entry.state = EffectState::Suppressed;
            entry.reason = Some(reason.into());
        }
        Some(entry.clone())
    }

    pub fn suppress_stale(
        &mut self,
        current_stamp: VoiceTurnStamp,
        reason: &str,
    ) -> Vec<EffectEntry> {
        let mut changed = Vec::new();
        for entry in self.entries.values_mut() {
            if entry.state == EffectState::Proposed && entry.stamp != current_stamp {
                entry.state = EffectState::Suppressed;
                entry.reason = Some(reason.to_owned());
                changed.push(entry.clone());
            }
        }
        changed
    }

    /// Validate a client-reported result against the effect's immutable stamp.
    ///
    /// A result for an already committed effect remains truthful after a newer
    /// turn arrives and is marked `late`; generation cancellation never claims
    /// to undo external work. Duplicate results are idempotent.
    pub fn record_result(
        &mut self,
        effect_id: &str,
        observed_stamp: VoiceTurnStamp,
        current_stamp: VoiceTurnStamp,
    ) -> EffectResultOutcome {
        let Some(entry) = self.entries.get_mut(effect_id) else {
            return EffectResultOutcome::Rejected { entry: None };
        };
        if entry.state != EffectState::Committed || entry.stamp != observed_stamp {
            if entry.state == EffectState::Proposed {
                entry.state = EffectState::Suppressed;
                entry.reason = Some("stale_or_uncommitted_result".to_owned());
            }
            return EffectResultOutcome::Rejected {
                entry: Some(entry.clone()),
            };
        }

        let late = entry.stamp != current_stamp;
        if entry.result_recorded {
            return EffectResultOutcome::Duplicate {
                entry: entry.clone(),
                late,
            };
        }
        entry.result_recorded = true;
        EffectResultOutcome::Accepted {
            entry: entry.clone(),
            late,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stamp(turn: u64, gen: u64) -> VoiceTurnStamp {
        VoiceTurnStamp::new(turn, gen).unwrap()
    }

    #[test]
    fn duplicate_commit_does_not_reexecute_an_irreversible_effect() {
        let mut ledger = EffectLedger::new();
        ledger
            .propose(
                "rtc:1",
                "task.launch",
                Reversibility::Irreversible,
                stamp(2, 3),
            )
            .unwrap();

        let first = ledger.commit("rtc:1", stamp(2, 3), stamp(2, 3)).unwrap();
        let duplicate = ledger.commit("rtc:1", stamp(2, 3), stamp(2, 3)).unwrap();

        assert!(first.transitioned);
        assert_eq!(first.entry.state, EffectState::Committed);
        assert!(!duplicate.transitioned);
    }

    #[test]
    fn stale_commits_fail_closed_into_suppression() {
        let mut ledger = EffectLedger::new();
        ledger
            .propose(
                "rtc:1",
                "task.launch",
                Reversibility::Irreversible,
                stamp(2, 3),
            )
            .unwrap();

        // A newer generation is current by the time the commit arrives.
        let outcome = ledger.commit("rtc:1", stamp(2, 3), stamp(2, 4)).unwrap();
        assert!(outcome.transitioned);
        assert_eq!(outcome.entry.state, EffectState::Suppressed);
        assert_eq!(outcome.entry.reason.as_deref(), Some("stale_generation"));

        // Suppression is terminal: no later commit can resurrect the effect.
        let retry = ledger.commit("rtc:1", stamp(2, 3), stamp(2, 3)).unwrap();
        assert!(!retry.transitioned);
        assert_eq!(retry.entry.state, EffectState::Suppressed);
    }

    #[test]
    fn committed_result_is_accepted_honestly_after_a_newer_turn() {
        let mut ledger = EffectLedger::new();
        ledger
            .propose(
                "rtc:1",
                "task.launch",
                Reversibility::Irreversible,
                stamp(2, 3),
            )
            .unwrap();
        ledger.commit("rtc:1", stamp(2, 3), stamp(2, 3));

        assert!(matches!(
            ledger.record_result("rtc:1", stamp(2, 3), stamp(3, 4)),
            EffectResultOutcome::Accepted { late: true, .. }
        ));
        assert!(matches!(
            ledger.record_result("rtc:1", stamp(2, 3), stamp(3, 4)),
            EffectResultOutcome::Duplicate { late: true, .. }
        ));
    }
}
