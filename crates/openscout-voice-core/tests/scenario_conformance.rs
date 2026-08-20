use openscout_voice_core::{
    EffectLedger, EffectResultOutcome, EffectState, Reversibility, TurnClock, VoiceTurnStamp,
};
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Deserialize)]
struct Scenario {
    name: String,
    steps: Vec<Step>,
    expect: Expectations,
}

#[derive(Debug, Deserialize)]
struct Step {
    #[serde(rename = "do")]
    action: String,
    #[serde(default)]
    payload: Value,
    #[serde(default, rename = "copyFromEvent")]
    copy_from_event: Option<CopyFromEvent>,
}

#[derive(Debug, Deserialize)]
struct CopyFromEvent {
    event: String,
    fields: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
struct Expectations {
    #[serde(default, rename = "taskLaunches")]
    task_launches: Option<u64>,
    #[serde(default, rename = "taskLaunched")]
    task_launched: Option<u64>,
    #[serde(default, rename = "lateTaskLaunched")]
    late_task_launched: Option<u64>,
    #[serde(default, rename = "minStaleEffectSuppressed")]
    min_stale_effect_suppressed: Option<u64>,
    #[serde(default, rename = "irreversibleEffectsOnStaleGeneration")]
    irreversible_effects_on_stale_generation: Option<u64>,
}

#[derive(Clone, Debug)]
struct ObservedEvent {
    effect_id: String,
    stamp: VoiceTurnStamp,
}

#[derive(Debug, Default)]
struct Metrics {
    task_launches: u64,
    task_launched: u64,
    late_task_launched: u64,
    stale_effect_suppressed: u64,
    irreversible_effects_on_stale_generation: u64,
}

struct FixtureDriver {
    clock: TurnClock,
    ledger: EffectLedger,
    next_effect: u64,
    observed: BTreeMap<String, Vec<ObservedEvent>>,
    metrics: Metrics,
}

impl FixtureDriver {
    fn new() -> Self {
        Self {
            clock: TurnClock::new(),
            ledger: EffectLedger::new(),
            next_effect: 0,
            observed: BTreeMap::new(),
            metrics: Metrics::default(),
        }
    }

    fn run(mut self, scenario: &Scenario) -> Metrics {
        for step in &scenario.steps {
            if step.action != "dc" {
                continue;
            }
            let event_type = step
                .payload
                .get("type")
                .and_then(Value::as_str)
                .expect("dc fixture step must have a type");
            match event_type {
                "task.launch" => self.propose_launch(),
                "effect.commit" => self.commit_effect(step),
                "turn.commit" => self.accept_new_turn(),
                "task.launch.result" => self.record_launch_result(step),
                _ => {}
            }
        }
        self.metrics
    }

    fn propose_launch(&mut self) {
        self.next_effect += 1;
        let effect_id = format!(
            "rust:{}:{}:task-launch:{}",
            self.clock.current().turn,
            self.clock.current().gen,
            self.next_effect
        );
        let entry = self
            .ledger
            .propose(
                effect_id.clone(),
                "task.launch",
                Reversibility::Irreversible,
                self.clock.current(),
            )
            .unwrap();
        self.observe(
            "dc:task.launch.proposed",
            ObservedEvent {
                effect_id,
                stamp: entry.stamp,
            },
        );
    }

    fn commit_effect(&mut self, step: &Step) {
        let copied = self.copied_event(step);
        let outcome = self
            .ledger
            .commit(&copied.effect_id, copied.stamp, self.clock.current())
            .expect("fixture must reference a known effect");
        if outcome.transitioned && outcome.entry.state == EffectState::Suppressed {
            self.metrics.stale_effect_suppressed += 1;
        }
        if !outcome.transitioned || outcome.entry.state != EffectState::Committed {
            return;
        }

        self.metrics.task_launches += 1;
        if outcome.entry.stamp != self.clock.current() {
            self.metrics.irreversible_effects_on_stale_generation += 1;
        }
        self.observe(
            "dc:task.launch",
            ObservedEvent {
                effect_id: outcome.entry.effect_id,
                stamp: outcome.entry.stamp,
            },
        );
    }

    fn accept_new_turn(&mut self) {
        let current = self.clock.accept_turn().unwrap();
        self.metrics.stale_effect_suppressed +=
            self.ledger.suppress_stale(current, "new_turn").len() as u64;
    }

    fn record_launch_result(&mut self, step: &Step) {
        let copied = self.copied_event(step);
        if let EffectResultOutcome::Accepted { late, .. } =
            self.ledger
                .record_result(&copied.effect_id, copied.stamp, self.clock.current())
        {
            self.metrics.task_launched += 1;
            if late {
                self.metrics.late_task_launched += 1;
            }
        }
    }

    fn copied_event(&self, step: &Step) -> ObservedEvent {
        let copy = step
            .copy_from_event
            .as_ref()
            .expect("effect fixture step must copy identity from an observed event");
        assert_eq!(copy.fields, ["effectId", "turn", "gen"]);
        self.observed
            .get(&copy.event)
            .and_then(|events| events.last())
            .cloned()
            .expect("copied event must have been observed")
    }

    fn observe(&mut self, event: &str, observed: ObservedEvent) {
        self.observed
            .entry(event.to_owned())
            .or_default()
            .push(observed);
    }
}

#[test]
fn shared_effect_scenarios_match_the_rust_ledger() {
    for name in ["stale-launch", "task-launch-commit"] {
        let scenario = read_scenario(name);
        assert_eq!(scenario.name, name);
        let metrics = FixtureDriver::new().run(&scenario);

        if let Some(expected) = scenario.expect.task_launches {
            assert_eq!(metrics.task_launches, expected, "{name}: task launches");
        }
        if let Some(expected) = scenario.expect.task_launched {
            assert_eq!(
                metrics.task_launched, expected,
                "{name}: task launched results"
            );
        }
        if let Some(expected) = scenario.expect.late_task_launched {
            assert_eq!(
                metrics.late_task_launched, expected,
                "{name}: late task launched results"
            );
        }
        if let Some(expected) = scenario.expect.min_stale_effect_suppressed {
            assert!(
                metrics.stale_effect_suppressed >= expected,
                "{name}: expected at least {expected} stale suppression, got {}",
                metrics.stale_effect_suppressed
            );
        }
        if let Some(expected) = scenario.expect.irreversible_effects_on_stale_generation {
            assert_eq!(
                metrics.irreversible_effects_on_stale_generation, expected,
                "{name}: stale irreversible effects"
            );
        }
    }
}

#[test]
fn the_complete_shared_corpus_remains_valid_json_with_unique_names() {
    let directory = scenario_directory();
    let mut names = Vec::new();
    for entry in fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }
        let value: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        names.push(
            value
                .get("name")
                .and_then(Value::as_str)
                .expect("scenario name")
                .to_owned(),
        );
    }
    names.sort();
    names.dedup();
    assert_eq!(names.len(), 11);
}

fn read_scenario(name: &str) -> Scenario {
    let path = scenario_directory().join(format!("{name}.json"));
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

fn scenario_directory() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/archive/design/spikes/voice-scenarios")
}
