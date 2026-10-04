use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use crate::ask::AskRequest;
use crate::classify::{classify, Class};
use crate::feed::{Snapshot, TailEvent};

const KEEP: usize = 4000;
const MAX_TWIN_COLUMNS: usize = 3;

/// Number of deck columns Twin can actually show at this terminal width.
///
/// With a non-empty fleet, two columns remain useful as explicit assignment
/// slots on an ordinary terminal even when only one session is available. An
/// empty fleet exposes one focus target because the global empty state has no
/// visible deck columns. The third column requires both width and fleet size.
pub fn twin_visible_columns(width: u16, fleet_size: usize) -> usize {
    if fleet_size == 0 || width < 70 {
        1
    } else if width >= 150 && fleet_size >= 3 {
        3
    } else {
        2
    }
}

/// A tail event plus everything the renderer needs, derived once at ingest.
#[derive(Clone, Debug)]
pub struct Row {
    pub event: TailEvent,
    pub cls: Class,
    pub tool: Option<String>,
    pub target: Option<String>,
    pub text: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Take {
    Now = 1,
    Horizon = 2,
    Twin = 3,
    Mesh = 4,
    Quota = 5,
    Harvest = 6,
    Grid = 7,
}

impl Take {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "1" | "now" | "hero" => Some(Take::Now),
            "2" | "horizon" | "time" | "timeline" => Some(Take::Horizon),
            "3" | "twin" | "split" | "two" => Some(Take::Twin),
            "4" | "mesh" | "hosts" | "nodes" => Some(Take::Mesh),
            "5" | "quota" | "fuel" | "plans" | "providers" => Some(Take::Quota),
            "6" | "harvest" | "diff" | "churn" | "yield" | "orchard" => Some(Take::Harvest),
            "7" | "grid" | "slots" | "modules" | "multi" => Some(Take::Grid),
            _ => None,
        }
    }

    /// Now → Horizon → Mesh → Harvest → Quota → Now. Twin and Grid stay off Tab.
    pub fn next_spine(&self) -> Self {
        match self {
            Take::Now => Take::Horizon,
            Take::Horizon => Take::Mesh,
            Take::Mesh => Take::Harvest,
            Take::Harvest => Take::Quota,
            Take::Quota | Take::Twin | Take::Grid => Take::Now,
        }
    }

    pub fn prev_spine(&self) -> Self {
        match self {
            Take::Now | Take::Twin | Take::Grid => Take::Quota,
            Take::Horizon => Take::Now,
            Take::Mesh => Take::Horizon,
            Take::Harvest => Take::Mesh,
            Take::Quota => Take::Harvest,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Composition {
    Focus = 1,
    Watch = 2,
    Review = 3,
    Quad = 4,
}

impl Composition {
    pub fn title(&self) -> &'static str {
        match self {
            Composition::Focus => "1 Focus (one conversation in hand)",
            Composition::Watch => "2 Watch (the composed fleet)",
            Composition::Review => "3 Review (recorded diffs while away)",
            Composition::Quad => "4 Quad (all four quadrant takes)",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "1" | "focus" => Some(Composition::Focus),
            "2" | "watch" => Some(Composition::Watch),
            "3" | "review" => Some(Composition::Review),
            "4" | "quad" | "quadrant" | "tiling" => Some(Composition::Quad),
            _ => None,
        }
    }

    pub fn next(&self) -> Self {
        match self {
            Composition::Focus => Composition::Watch,
            Composition::Watch => Composition::Review,
            Composition::Review => Composition::Quad,
            Composition::Quad => Composition::Focus,
        }
    }

    pub fn modules(&self) -> &'static [ModuleKind] {
        match self {
            Composition::Focus => &[
                ModuleKind::Current,
                ModuleKind::Threads,
                ModuleKind::Motion,
                ModuleKind::Usage,
            ],
            Composition::Watch => &[
                ModuleKind::Threads,
                ModuleKind::Motion,
                ModuleKind::Runtime,
                ModuleKind::Since,
                ModuleKind::Usage,
                ModuleKind::Current,
            ],
            Composition::Review => &[
                ModuleKind::Since,
                ModuleKind::Compare,
                ModuleKind::Harvest,
                ModuleKind::Usage,
            ],
            Composition::Quad => &[
                ModuleKind::Current,
                ModuleKind::Horizon,
                ModuleKind::Usage,
                ModuleKind::Harvest,
            ],
        }
    }

    /// How `draw_take_grid` tiles this composition. Keep this in lockstep with
    /// the slot rectangle order: Focus/Review fill a 2×2 down each column,
    /// Watch is a 3×2 left-to-right, Quad is a 2×2 left-to-right.
    pub fn slot_grid(&self) -> SlotGrid {
        match self {
            Composition::Focus | Composition::Review => SlotGrid {
                cols: 2,
                rows: 2,
                fill: SlotFill::ColumnMajor,
            },
            Composition::Watch => SlotGrid {
                cols: 3,
                rows: 2,
                fill: SlotFill::RowMajor,
            },
            Composition::Quad => SlotGrid {
                cols: 2,
                rows: 2,
                fill: SlotFill::RowMajor,
            },
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SlotFill {
    RowMajor,
    ColumnMajor,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SlotGrid {
    pub cols: usize,
    pub rows: usize,
    pub fill: SlotFill,
}

impl SlotGrid {
    pub fn index(&self, col: usize, row: usize) -> usize {
        match self.fill {
            SlotFill::RowMajor => row * self.cols + col,
            SlotFill::ColumnMajor => col * self.rows + row,
        }
    }

    pub fn coords(&self, index: usize) -> (usize, usize) {
        match self.fill {
            SlotFill::RowMajor => (index % self.cols, index / self.cols),
            SlotFill::ColumnMajor => (index / self.rows, index % self.rows),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ModuleKind {
    Current,
    Threads,
    Motion,
    Runtime,
    Usage,
    Since,
    Compare,
    Harvest,
    Horizon,
}

impl ModuleKind {
    pub fn label(&self) -> &'static str {
        match self {
            ModuleKind::Current => "current",
            ModuleKind::Threads => "conversations",
            ModuleKind::Motion => "motion",
            ModuleKind::Runtime => "machines",
            ModuleKind::Usage => "usage",
            ModuleKind::Since => "since away",
            ModuleKind::Compare => "compare",
            ModuleKind::Harvest => "harvest",
            ModuleKind::Horizon => "horizon",
        }
    }

    pub fn job(&self) -> &'static str {
        match self {
            ModuleKind::Current => "one conversation in hand",
            ModuleKind::Threads => "continuity across sessions",
            ModuleKind::Motion => "event amplitude · last 60s",
            ModuleKind::Runtime => "connected machines on the mesh",
            ModuleKind::Usage => "provider fuel windows",
            ModuleKind::Since => "recorded diffs while away",
            ModuleKind::Compare => "two conversations, one cursor",
            ModuleKind::Harvest => "orchard git churn living wall",
            ModuleKind::Horizon => "30m temporal cadence & activity tracks",
        }
    }
}

#[derive(Clone, Debug)]
pub struct SinceRecord {
    pub time: String,
    pub actor: String,
    pub change: String,
    pub path: String,
    /// How many consecutive writes this row stands for.
    pub repeats: usize,
    pub kind: &'static str,
}

/// A real connected machine: this host, a tailnet peer, or a scout mesh node.
#[derive(Clone, Debug, Default)]
pub struct Machine {
    pub name: String,
    pub dns_name: String,
    pub ip: String,
    pub ips: Vec<String>,
    pub os: String,
    pub online: bool,
    pub is_self: bool,
    pub link: String,
    pub last_seen: String,
    pub tx_bytes: u64,
    pub rx_bytes: u64,
    pub exit_node: bool,
    pub tags: Vec<String>,
    pub scout: Option<ScoutNode>,
}

/// What the scout mesh registry knows about a machine that advertises a broker.
#[derive(Clone, Debug)]
pub struct ScoutNode {
    pub broker_url: String,
    pub web_url: String,
    pub scope: String,
    pub capabilities: Vec<String>,
    pub last_seen_ms: i64,
}

/// Operator intent for the Mesh take. The machines worker runs these through
/// `scout mesh`; the TUI does not invent a second presence protocol.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MeshAction {
    Ping { target: String, label: String },
    Join,
    Leave,
    Refresh,
}

/// A run of activity on a thread track, in percent of the 30-minute window.
#[derive(Clone, Debug)]
pub struct ThreadSegment {
    pub start: u8,
    pub width: u8,
}

#[derive(Clone, Debug)]
pub struct ConversationThread {
    pub handle: String,
    pub age: String,
    pub live: bool,
    pub segments: Vec<ThreadSegment>,
}

#[derive(Clone, Debug)]
pub struct Agent {
    pub id: String,
    pub handle: String,
    pub harness: String,
    pub project: String,
    pub host: String,
    pub age: String,
    pub live: bool,
    pub needs: bool,
    pub ask: Option<String>,
    pub doing: String,
    pub thought: String,
    pub ticks: Vec<f32>,
    pub last_ts: i64,
}

#[derive(Clone, Debug)]
pub struct QuotaWindow {
    pub label: String,
    pub used: u8,
    pub reset: String,
    pub spark: Vec<f32>,
    pub pace: String,
    pub confidence: String,
    pub source: String,
}

#[derive(Clone, Debug)]
pub struct Plan {
    pub id: String,
    pub name: String,
    pub plan: String,
    pub source: String,
    pub availability: String,
    pub confidence: String,
    pub burn_rate: String,
    pub primary_roles: Vec<String>,
    pub failover: String,
    pub windows: Vec<QuotaWindow>,
    pub status: Option<String>,
}

#[derive(Clone, Debug)]
pub struct HarvestFile {
    pub path: String,
    /// Absolute path, so churn can be joined against git's own accounting.
    pub abs: String,
    pub adds: usize,
    pub dels: usize,
    /// How many times the session actually touched the file.
    pub touches: usize,
    pub state: FileState,
    pub fresh: bool,
    pub age: String,
}

/// What git says about a touched file — never a guess from event counts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FileState {
    /// Tracked and changed against HEAD.
    Changed,
    /// Tracked, but identical to HEAD right now.
    Clean,
    /// In a repo, but git has never seen it.
    Untracked,
    /// Outside every repo the fleet is working in.
    Outside,
    /// No git answer yet.
    Unknown,
}

#[derive(Clone, Debug)]
pub struct HarvestTree {
    pub session_id: String,
    pub handle: String,
    pub source: String,
    pub project: String,
    pub last: String,
    pub turns: usize,
    pub fresh: bool,
    pub files: Vec<HarvestFile>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum DeckAssignment {
    /// Use the column's ordinal cursor until the operator chooses a session.
    Ordinal,
    /// Follow this session through recency reordering.
    Session(String),
    /// A previously pinned session disappeared from the retained event window.
    Unassigned,
}

pub struct App {
    pub take: Take,
    pub filtering: bool,
    pub fleet_view: bool,
    /// The calm list's opened session: its conversation, newest at the bottom.
    pub calm_detail: bool,
    /// Lines scrolled up from the bottom of the opened session.
    pub detail_scroll: usize,
    pub filter: String,
    pub animation_start: Instant,
    pub composition: Composition,
    pub focused_slot: usize,
    pub cursor: usize,
    selected_session_id: Option<String>,
    pub peer_cursor: usize,
    pub deck_cursor: [usize; 3],
    deck_assignments: [DeckAssignment; 3],
    pub deck_focus: usize,
    pub plan_index: usize,
    pub harvest_cursor: usize,
    pub mesh_cursor: usize,
    pub mesh_action: Option<MeshAction>,
    pub mesh_busy: bool,
    pub mesh_notice: Option<String>,
    pub composing: bool,
    pub draft: String,
    pub composer_notice: Option<String>,
    /// True when `composer_notice` is a successful ask receipt.
    pub composer_ok: bool,
    /// An ask waiting for the worker thread to pick it up.
    pub ask_request: Option<AskRequest>,
    /// The body of the ask the worker is posting right now, if any.
    ask_in_flight: Option<String>,
    pub help: bool,
    pub events: VecDeque<Row>,
    seen: HashMap<String, ()>,
    pub error: Option<String>,
    pub last_fetch: Option<Instant>,
    pub machines: Vec<Machine>,
    pub machines_error: Option<String>,
    pub scout_registry_ready: bool,
    pub plans: Vec<Plan>,
    pub plans_error: Option<String>,
    pub plans_ready: bool,
    pub git_churn: HashMap<String, (usize, usize)>,
    pub git_untracked: HashSet<String>,
    pub git_roots: Vec<String>,
    pub git_error: Option<String>,
    /// Click targets from the last frame. Rebuilt every draw.
    pub hits: Vec<Hit>,
    /// Left pane percent for Horizon / Mesh / Harvest / Quota.
    pub detail_split: u16,
    pub split_drag: bool,
    pub body_x: u16,
    pub body_w: u16,
    pub pointer: Pointer,
}

#[derive(Clone, Copy, Debug)]
pub enum HitKind {
    Take(Take),
    Agent(usize),
    Mesh(usize),
    Harvest(usize),
    Split,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Pointer {
    Default,
    Hand,
    EwResize,
}

impl Pointer {
    pub fn osc(self) -> &'static str {
        match self {
            Pointer::Default => "\x1b]22;default\x07",
            Pointer::Hand => "\x1b]22;pointer\x07",
            Pointer::EwResize => "\x1b]22;ew-resize\x07",
        }
    }
}

impl Take {
    pub fn splits_detail(self) -> bool {
        matches!(
            self,
            Take::Horizon | Take::Mesh | Take::Quota | Take::Harvest
        )
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Hit {
    pub x: u16,
    pub y: u16,
    pub w: u16,
    pub h: u16,
    pub kind: HitKind,
}

impl App {
    pub fn new(take: Take) -> Self {
        Self {
            take,
            composition: Composition::Watch,
            focused_slot: 0,
            cursor: 0,
            selected_session_id: None,
            peer_cursor: 1,
            deck_cursor: [0, 1, 2],
            deck_assignments: [
                DeckAssignment::Ordinal,
                DeckAssignment::Ordinal,
                DeckAssignment::Ordinal,
            ],
            deck_focus: 0,
            plan_index: 0,
            harvest_cursor: 0,
            mesh_cursor: 0,
            mesh_action: None,
            mesh_busy: false,
            mesh_notice: None,
            composing: false,
            draft: String::new(),
            composer_notice: None,
            composer_ok: false,
            ask_request: None,
            ask_in_flight: None,
            help: false,
            filtering: false,
            fleet_view: false,
            calm_detail: false,
            detail_scroll: 0,
            filter: String::new(),
            animation_start: Instant::now(),
            events: VecDeque::new(),
            seen: HashMap::new(),
            error: None,
            last_fetch: None,
            machines: Vec::new(),
            machines_error: None,
            scout_registry_ready: false,
            plans: Vec::new(),
            plans_error: None,
            plans_ready: false,
            git_churn: HashMap::new(),
            git_untracked: HashSet::new(),
            git_roots: Vec::new(),
            git_error: None,
            hits: Vec::new(),
            detail_split: load_detail_split().unwrap_or(58),
            split_drag: false,
            body_x: 0,
            body_w: 0,
            pointer: Pointer::Default,
        }
    }

    pub fn set_body(&mut self, x: u16, width: u16) {
        self.body_x = x;
        self.body_w = width;
    }

    pub fn nudge_split(&mut self, delta: i16) {
        let next = (self.detail_split as i16).saturating_add(delta);
        self.detail_split = next.clamp(28, 75) as u16;
        save_detail_split(self.detail_split);
    }

    pub fn set_split_from_col(&mut self, col: u16) {
        if self.body_w < 24 {
            return;
        }
        let local = u32::from(col.saturating_sub(self.body_x));
        let pct = (local * 100 / u32::from(self.body_w.max(1))) as u16;
        self.detail_split = pct.clamp(28, 75);
    }

    pub fn persist_split(&self) {
        save_detail_split(self.detail_split);
    }

    pub fn clear_hits(&mut self) {
        self.hits.clear();
    }

    pub fn push_hit(&mut self, x: u16, y: u16, w: u16, h: u16, kind: HitKind) {
        if w == 0 || h == 0 {
            return;
        }
        self.hits.push(Hit { x, y, w, h, kind });
    }

    pub fn hit_at(&self, col: u16, row: u16) -> Option<HitKind> {
        self.hits.iter().rev().find_map(|hit| {
            let x1 = hit.x;
            let y1 = hit.y;
            let x2 = hit.x.saturating_add(hit.w);
            let y2 = hit.y.saturating_add(hit.h);
            (col >= x1 && col < x2 && row >= y1 && row < y2).then_some(hit.kind)
        })
    }

    pub fn apply_hit(&mut self, kind: HitKind) {
        match kind {
            HitKind::Take(take) => self.take = take,
            HitKind::Agent(index) => {
                let agents = self.agents();
                if agents.get(index).is_some() {
                    self.cursor = index;
                    self.selected_session_id = agents.get(index).map(|agent| agent.id.clone());
                }
            }
            HitKind::Mesh(index) => {
                if index < self.machines.len() {
                    self.mesh_cursor = index;
                }
            }
            HitKind::Harvest(index) => {
                let trees = self.harvest_trees();
                if !trees.is_empty() {
                    self.harvest_cursor = index.min(trees.len() - 1);
                    if let Some(tree) = trees.get(self.harvest_cursor) {
                        self.select_session(&tree.session_id);
                    }
                }
            }
            HitKind::Split => {}
        }
    }

    pub fn set_machines(
        &mut self,
        machines: Vec<Machine>,
        error: Option<String>,
        registry_ready: bool,
        notice: Option<String>,
    ) {
        self.machines = machines;
        self.machines_error = error;
        self.scout_registry_ready = registry_ready;
        if !self.machines.is_empty() {
            self.mesh_cursor = self.mesh_cursor.min(self.machines.len() - 1);
        }
        if let Some(notice) = notice {
            self.mesh_notice = Some(notice);
            self.mesh_busy = false;
        }
    }

    pub fn take_mesh_action(&mut self) -> Option<MeshAction> {
        self.mesh_action.take()
    }

    pub fn queue_mesh_ping(&mut self) {
        if self.mesh_busy {
            return;
        }
        let Some(machine) = self.selected_machine() else {
            self.mesh_notice = Some("no machine selected".into());
            return;
        };
        let Some(target) = crate::machines::ping_target(&machine) else {
            self.mesh_notice = Some(format!("no address to ping on {}", machine.name));
            return;
        };
        self.queue_mesh_action(
            MeshAction::Ping {
                target,
                label: machine.name.clone(),
            },
            format!("pinging {}…", machine.name),
        );
    }

    pub fn queue_mesh_join(&mut self) {
        self.queue_mesh_action(MeshAction::Join, "announcing this machine…".into());
    }

    pub fn queue_mesh_leave(&mut self) {
        self.queue_mesh_action(MeshAction::Leave, "withdrawing this machine…".into());
    }

    pub fn queue_mesh_refresh(&mut self) {
        self.queue_mesh_action(MeshAction::Refresh, "refreshing mesh registry…".into());
    }

    fn queue_mesh_action(&mut self, action: MeshAction, pending: String) {
        if self.mesh_busy {
            return;
        }
        self.mesh_busy = true;
        self.mesh_notice = Some(pending);
        self.mesh_action = Some(action);
    }

    pub fn set_plans(&mut self, plans: Vec<Plan>, error: Option<String>, ready: bool) {
        if !plans.is_empty() || error.is_none() {
            self.plans = plans;
            self.plans_error = error;
        } else if self.plans.is_empty() {
            self.plans_error = error;
        }
        self.plans_ready = ready;
        if !self.plans.is_empty() {
            self.plan_index = self.plan_index.min(self.plans.len() - 1);
        }
    }

    pub fn set_git(
        &mut self,
        churn: HashMap<String, (usize, usize)>,
        untracked: HashSet<String>,
        roots: Vec<String>,
        error: Option<String>,
    ) {
        self.git_churn = churn;
        self.git_untracked = untracked;
        self.git_roots = roots;
        self.git_error = error;
        self.clamp_cursors();
    }

    /// The working directories the fleet is reporting from, newest session first.
    pub fn session_cwds(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for row in &self.events {
            if let Some(cwd) = row.event.cwd.as_ref() {
                if !cwd.trim().is_empty() && !out.contains(cwd) {
                    out.push(cwd.clone());
                }
            }
        }
        out.truncate(12);
        out
    }

    pub fn move_slot_focus(&mut self, delta: isize) {
        let mods = self.composition.modules();
        if mods.is_empty() {
            return;
        }
        let len = mods.len() as isize;
        let next = (self.focused_slot as isize + delta).rem_euclid(len);
        self.focused_slot = next as usize;
    }

    /// Move slot focus by visual neighbor, not module-list order.
    /// Edges clamp so a leftward key never leaps to the far column.
    pub fn move_grid_focus(&mut self, dx: isize, dy: isize) {
        let mods = self.composition.modules();
        if mods.is_empty() {
            return;
        }
        let grid = self.composition.slot_grid();
        let idx = self.focused_slot.min(mods.len() - 1);
        let (col, row) = grid.coords(idx);
        let next_col = (col as isize + dx).clamp(0, grid.cols as isize - 1) as usize;
        let next_row = (row as isize + dy).clamp(0, grid.rows as isize - 1) as usize;
        let next = grid.index(next_col, next_row);
        if next < mods.len() {
            self.focused_slot = next;
        }
    }

    pub fn next_composition(&mut self) {
        self.composition = self.composition.next();
        self.focused_slot = 0;
    }

    pub fn set_composition(&mut self, comp: Composition) {
        self.composition = comp;
        self.focused_slot = 0;
    }

    pub fn begin_compose(&mut self) {
        self.composing = true;
        self.composer_notice = None;
        self.composer_ok = false;
    }

    pub fn cancel_compose(&mut self) {
        self.composing = false;
        self.draft.clear();
        self.composer_notice = None;
        self.composer_ok = false;
    }

    pub fn can_compose(&self) -> bool {
        matches!(
            self.take,
            Take::Now | Take::Twin | Take::Horizon | Take::Harvest
        ) && self.selected_agent().is_some()
    }

    pub fn compose_blocked_reason(&self) -> String {
        if self.selected_agent().is_none() {
            "no session to ask".into()
        } else {
            "Draft lives in Now — press i there.".into()
        }
    }

    pub fn submit_compose(&mut self) {
        let draft = self.draft.trim().to_string();
        self.composer_ok = false;
        if draft.is_empty() {
            self.composing = false;
            self.composer_notice = Some("empty draft".into());
            return;
        }
        let Some(agent) = self.selected_agent() else {
            self.composing = false;
            self.composer_notice = Some("no session to ask".into());
            return;
        };
        self.composing = false;
        if self.ask_busy() {
            self.composer_notice = Some("an ask is still in flight; draft kept".into());
            return;
        }
        // The POST runs on the ask worker so a slow broker never freezes the
        // frame; `finish_ask` reports the receipt when it lands.
        self.composer_notice = Some(format!("asking {}…", agent.handle));
        self.ask_in_flight = Some(self.draft.clone());
        self.ask_request = Some(AskRequest {
            session_id: agent.id,
            handle: agent.handle,
            harness: agent.harness,
            body: draft,
        });
    }

    pub fn ask_busy(&self) -> bool {
        self.ask_in_flight.is_some()
    }

    pub fn take_ask_request(&mut self) -> Option<AskRequest> {
        self.ask_request.take()
    }

    pub fn finish_ask(&mut self, result: Result<String, String>) {
        let sent = self.ask_in_flight.take();
        match result {
            Ok(receipt) => {
                // Keep anything typed after the ask went out.
                if sent.as_deref() == Some(self.draft.as_str()) {
                    self.draft.clear();
                }
                self.composer_ok = true;
                self.composer_notice = Some(receipt);
            }
            Err(err) => {
                self.composer_ok = false;
                self.composer_notice = Some(err);
            }
        }
    }

    fn select_session(&mut self, session_id: &str) {
        let agents = self.agents();
        if let Some(index) = agents.iter().position(|agent| agent.id == session_id) {
            self.cursor = index;
            self.selected_session_id = Some(session_id.to_string());
        }
    }

    pub fn ingest(&mut self, snapshot: Snapshot) {
        self.last_fetch = Some(snapshot.fetched_at);
        if let Some(err) = snapshot.error {
            self.error = Some(err);
        } else {
            self.error = None;
        }

        for event in snapshot.events {
            self.ingest_event(event);
        }

        self.clamp_cursors();
    }

    pub fn ingest_event(&mut self, event: TailEvent) {
        let dedup_key = event_dedup_key(&event);
        if self.seen.contains_key(&dedup_key) {
            return;
        }
        self.seen.insert(dedup_key, ());

        let row = classify(event);
        self.events.push_front(row);
        while self.events.len() > KEEP {
            if let Some(evicted) = self.events.pop_back() {
                self.seen.remove(&event_dedup_key(&evicted.event));
            }
        }
        self.rebase_agent_cursors();
    }

    pub fn agents(&self) -> Vec<Agent> {
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        let mut groups: HashMap<String, Vec<&Row>> = HashMap::new();
        for r in &self.events {
            groups
                .entry(r.event.session_id.clone())
                .or_default()
                .push(r);
        }

        let mut agents: Vec<Agent> = groups
            .into_iter()
            .map(|(session_id, mut rows)| {
                rows.sort_by_key(|r| event_ts_ms(r.event.ts));
                let last_row = rows.last().unwrap();
                let last_event = &last_row.event;
                let last_ts = last_event.ts;
                let delta_ms = now_ms.saturating_sub(event_ts_ms(last_ts));

                let (short_name, project) = extract_session_parts(last_event);
                let harness = derive_harness(last_event);
                let host = derive_host(&session_id, last_event);
                let handle = format!("@{short_name}");

                // A session has a request only if its LATEST event says so and it is
                // recent — an old ask a human long since answered must not pin a
                // stale session to the top of every list.
                let live = delta_ms < 90_000;
                let needs = event_needs_you(last_event) && delta_ms < 10 * 60 * 1000;
                let age = format_age(last_ts);

                let ask = if needs {
                    Some(clean_summary(&last_event.summary))
                } else {
                    None
                };

                // What the session is doing is its latest event with words in
                // it; a bare "[attachment]" marker says nothing.
                let doing = rows
                    .iter()
                    .rev()
                    .map(|r| clean_summary(&r.event.summary))
                    .find(|summary| !is_stream_marker(summary))
                    .unwrap_or_else(|| clean_summary(&last_event.summary));

                // The latest thought with words in it. Bare stream markers like
                // "[assistant]" carry no thought, so they are skipped rather
                // than shown as one.
                let thought = rows
                    .iter()
                    .rev()
                    .find(|r| {
                        (matches!(r.cls, Class::Convo | Class::Plan) || r.event.kind == "assistant")
                            && !is_stream_marker(&r.text)
                    })
                    .map(|r| r.text.clone())
                    .unwrap_or_else(|| {
                        if live {
                            format!("Active in {project}. {doing}")
                        } else {
                            format!("Session idle. Last action: {doing}")
                        }
                    });

                // Calculate tick marks in the last 60 seconds (0.0 to 1.0)
                let window_start_ms = now_ms.saturating_sub(60_000);
                let ticks: Vec<f32> = rows
                    .iter()
                    .filter(|r| event_ts_ms(r.event.ts) >= window_start_ms)
                    .map(|r| {
                        let offset = event_ts_ms(r.event.ts).saturating_sub(window_start_ms);
                        (offset as f32 / 60_000.0).clamp(0.0, 1.0)
                    })
                    .collect();

                Agent {
                    id: session_id,
                    handle,
                    harness,
                    project,
                    host,
                    age,
                    live,
                    needs,
                    ask,
                    doing,
                    thought,
                    ticks,
                    last_ts,
                }
            })
            .collect();

        // Ordering: requests first, then live, then most recent activity.
        // Recency — never the alphabet — decides who sits near the top.
        agents.sort_by(|a, b| {
            if self.take == Take::Now {
                calm_group(a).cmp(&calm_group(b))
            } else {
                b.needs.cmp(&a.needs).then_with(|| b.live.cmp(&a.live))
            }
            .then_with(|| event_ts_ms(b.last_ts).cmp(&event_ts_ms(a.last_ts)))
            .then_with(|| a.id.cmp(&b.id))
        });

        if self.calm() {
            // Ended sessions with nothing said yet would be blank rows; the
            // list counts them in one line instead (see calm_silent_count).
            agents.retain(|a| a.live || a.needs || self.has_words(&a.id));
        }
        if self.take == Take::Now && !self.filter.is_empty() {
            let query = self.filter.to_lowercase();
            agents.retain(|a| {
                format!("{} {} {}", self.session_title(&a.id), a.harness, a.id)
                    .to_lowercase()
                    .contains(&query)
            });
        }
        agents
    }

    /// True while the calm list (or its opened session) owns the screen.
    pub fn calm(&self) -> bool {
        self.take == Take::Now && !self.fleet_view
    }

    fn session_rows<'a>(&'a self, id: &'a str) -> impl Iterator<Item = &'a Row> + 'a {
        self.events.iter().filter(move |r| r.event.session_id == id)
    }

    fn is_words(r: &Row) -> bool {
        match r.cls {
            Class::Human => !prompt_title(&r.event.summary).is_empty(),
            Class::Convo => {
                r.event.kind == "assistant" && !is_stream_marker(&r.text) && !is_thinking(&r.text)
            }
            _ => false,
        }
    }

    /// Someone typed or the agent said something in the retained window.
    pub fn has_words(&self, id: &str) -> bool {
        self.session_rows(id).any(Self::is_words)
    }

    /// Ended sessions the calm list leaves out because nothing was said yet.
    pub fn calm_silent_count(&self) -> usize {
        let shown: HashSet<String> = self.agents().into_iter().map(|a| a.id).collect();
        let mut said = HashSet::new();
        let mut all = HashSet::new();
        for r in &self.events {
            all.insert(r.event.session_id.as_str());
            if Self::is_words(r) {
                said.insert(r.event.session_id.as_str());
            }
        }
        all.iter()
            .filter(|id| !said.contains(*id) && !shown.contains(**id))
            .count()
    }

    /// The last thing the agent said, as one plain line.
    pub fn session_outcome(&self, id: &str) -> String {
        self.session_rows(id)
            .filter(|r| r.cls == Class::Convo && Self::is_words(r))
            .max_by_key(|r| event_ts_ms(r.event.ts))
            .map(|r| plain(&r.text))
            .unwrap_or_default()
    }

    /// Tool and plan steps, oldest first, as one plain line each.
    pub fn session_steps(&self, id: &str) -> Vec<String> {
        let mut steps: Vec<&Row> = self
            .session_rows(id)
            .filter(|r| matches!(r.cls, Class::Tool | Class::Plan))
            .collect();
        steps.sort_by_key(|r| event_ts_ms(r.event.ts));
        steps.iter().map(|r| step_line(&r.text)).collect()
    }

    // TODO: replace with a real session titler. Until then: the first prompt a
    // person typed, else the agent's first line, else the current step.
    pub fn session_title(&self, id: &str) -> String {
        let first = |cls: Class| {
            self.session_rows(id)
                .filter(|r| r.cls == cls)
                .map(|r| {
                    let text = if cls == Class::Human {
                        prompt_title(&r.event.summary)
                    } else if r.event.kind == "assistant" && !is_stream_marker(&r.text) {
                        first_sentence(&plain(&r.text))
                    } else {
                        String::new()
                    };
                    (event_ts_ms(r.event.ts), text)
                })
                .filter(|(_, text)| !text.is_empty())
                .min_by_key(|(ts, _)| *ts)
                .map(|(_, text)| text)
        };
        first(Class::Human)
            .or_else(|| first(Class::Convo))
            .or_else(|| self.session_steps(id).pop())
            .unwrap_or_else(|| {
                let harness = self
                    .session_rows(id)
                    .next()
                    .map(|r| r.event.source.clone())
                    .unwrap_or_else(|| "agent".into());
                format!("{harness} session")
            })
    }

    pub fn selected_agent(&self) -> Option<Agent> {
        let list = self.agents();
        if list.is_empty() {
            None
        } else if self.take == Take::Twin {
            self.deck_agent(self.deck_focus)
        } else {
            let idx = selection_index(&list, self.selected_session_id.as_deref(), self.cursor);
            Some(list[idx].clone())
        }
    }

    pub fn deck_agent(&self, col: usize) -> Option<Agent> {
        let list = self.agents();
        let cursor = *self.deck_cursor.get(col)?;
        match self.deck_assignments.get(col)? {
            DeckAssignment::Ordinal => list.get(cursor).cloned(),
            DeckAssignment::Session(session_id) => {
                list.iter().find(|agent| agent.id == *session_id).cloned()
            }
            DeckAssignment::Unassigned => None,
        }
    }

    pub fn selected_peer(&self) -> Option<Agent> {
        let list = self.agents();
        if list.len() < 2 {
            None
        } else {
            let idx = self.peer_cursor.min(list.len() - 1);
            Some(list[idx].clone())
        }
    }

    pub fn cycle_deck_focus(&mut self, delta: isize, max_cols: usize) {
        self.clamp_deck_focus(max_cols);
        let cols = max_cols.clamp(1, MAX_TWIN_COLUMNS) as isize;
        let next = (self.deck_focus as isize + delta).rem_euclid(cols);
        self.deck_focus = next as usize;
        let agents = self.agents();
        if !agents.is_empty() {
            self.cursor = self.deck_cursor[self.deck_focus.min(2)].min(agents.len() - 1);
        }
    }

    pub fn clamp_deck_focus(&mut self, visible_cols: usize) {
        let last_visible = visible_cols.clamp(1, MAX_TWIN_COLUMNS) - 1;
        self.deck_focus = self.deck_focus.min(last_visible);
    }

    pub fn move_cursor(&mut self, delta: isize) {
        if self.take == Take::Twin {
            let agents = self.agents();
            if !agents.is_empty() {
                let len = agents.len() as isize;
                let col = self.deck_focus.min(2);
                let cur = self.deck_cursor[col] as isize;
                let next = (cur + delta).clamp(0, len - 1);
                self.deck_cursor[col] = next as usize;
                if let Some(agent) = agents.get(next as usize) {
                    self.deck_assignments[col] = DeckAssignment::Session(agent.id.clone());
                }
                self.cursor = self.deck_cursor[col];
                self.peer_cursor = self.deck_cursor[1.min(len as usize - 1)];
            }
            return;
        }

        if self.take == Take::Mesh {
            let len = self.machines.len() as isize;
            if len > 0 {
                let next = (self.mesh_cursor as isize + delta).clamp(0, len - 1);
                self.mesh_cursor = next as usize;
            }
            return;
        }

        if self.take == Take::Quota {
            let len = self.plans().len() as isize;
            if len > 0 {
                let next = (self.plan_index as isize + delta).clamp(0, len - 1);
                self.plan_index = next as usize;
            }
            return;
        }

        if self.take == Take::Harvest {
            self.move_harvest_cursor(delta);
            return;
        }

        let agents = self.agents();
        if agents.is_empty() {
            self.cursor = 0;
            return;
        }
        let len = agents.len() as isize;
        let from = selection_index(&agents, self.selected_session_id.as_deref(), self.cursor);
        let next = (from as isize + delta).clamp(0, len - 1);
        self.cursor = next as usize;
        self.selected_session_id = agents.get(self.cursor).map(|agent| agent.id.clone());
    }

    pub fn plans(&self) -> &[Plan] {
        &self.plans
    }

    pub fn selected_plan(&self) -> Option<&Plan> {
        if self.plans.is_empty() {
            None
        } else {
            let idx = self.plan_index.min(self.plans.len() - 1);
            self.plans.get(idx)
        }
    }

    pub fn harvest_trees(&self) -> Vec<HarvestTree> {
        let agents = self.agents();
        let mut trees: Vec<HarvestTree> = Vec::new();

        for agent in &agents {
            // (absolute path, touches, freshest touch, its age)
            let mut files_map: HashMap<String, (usize, bool, String)> = HashMap::new();
            let session_rows: Vec<&Row> = self
                .events
                .iter()
                .filter(|r| r.event.session_id == agent.id)
                .collect();
            let cwd = session_rows
                .iter()
                .find_map(|r| r.event.cwd.clone())
                .unwrap_or_default();

            for r in &session_rows {
                // Only writes count as touching a file; reads and greps do not.
                let tool = r.tool.as_deref().unwrap_or("");
                if !is_write_tool(tool) {
                    continue;
                }
                let Some(target) = &r.target else { continue };
                if !is_file_path(target) {
                    continue;
                }
                let abs = absolute_path(target, &cwd);
                let is_recent = r.event.ts > (agent.last_ts - 120_000);
                let age = format_age(r.event.ts);
                let entry = files_map.entry(abs).or_insert((0, is_recent, age));
                entry.0 += 1;
            }

            let mut files: Vec<HarvestFile> = files_map
                .into_iter()
                .map(|(abs, (touches, fresh, age))| {
                    let (adds, dels, state) = match self.git_churn.get(&abs) {
                        Some(&(adds, dels)) => (adds, dels, FileState::Changed),
                        None if self.git_untracked.contains(&abs) => (0, 0, FileState::Untracked),
                        None if self.git_roots.is_empty() => (0, 0, FileState::Unknown),
                        None if self.git_roots.iter().any(|root| abs.starts_with(root)) => {
                            (0, 0, FileState::Clean)
                        }
                        None => (0, 0, FileState::Outside),
                    };
                    HarvestFile {
                        path: clean_file_path(&abs),
                        abs,
                        adds,
                        dels,
                        touches,
                        state,
                        fresh,
                        age,
                    }
                })
                .collect();
            files.sort_by(|a, b| {
                b.fresh
                    .cmp(&a.fresh)
                    .then_with(|| (b.adds + b.dels).cmp(&(a.adds + a.dels)))
                    .then_with(|| b.touches.cmp(&a.touches))
                    .then_with(|| a.path.cmp(&b.path))
            });

            // Resting trees stay in the grove. Fruit is writes; talk without
            // yield is an empty shelf, not a missing row.
            trees.push(HarvestTree {
                session_id: agent.id.clone(),
                handle: agent.handle.clone(),
                source: agent.harness.clone(),
                project: agent.project.clone(),
                last: agent.doing.clone(),
                turns: session_rows.len(),
                fresh: agent.live,
                files,
            });
        }

        trees.sort_by(|a, b| {
            a.files
                .is_empty()
                .cmp(&b.files.is_empty())
                .then_with(|| b.fresh.cmp(&a.fresh))
                .then_with(|| b.turns.cmp(&a.turns))
                .then_with(|| a.handle.cmp(&b.handle))
        });

        trees
    }

    pub fn harvest_item_count(&self) -> usize {
        self.harvest_trees().len()
    }

    pub fn selected_harvest_item(&self) -> Option<(HarvestTree, Option<HarvestFile>)> {
        let trees = self.harvest_trees();
        let tree = trees.get(self.harvest_cursor).cloned()?;
        let file = tree.files.first().cloned();
        Some((tree, file))
    }

    pub fn move_harvest_cursor(&mut self, delta: isize) {
        let trees = self.harvest_trees();
        let count = trees.len() as isize;
        if count > 0 {
            let next = (self.harvest_cursor as isize + delta).clamp(0, count - 1);
            self.harvest_cursor = next as usize;
            if let Some(tree) = trees.get(self.harvest_cursor) {
                let session_id = tree.session_id.clone();
                self.select_session(&session_id);
            }
        }
    }

    /// What actually landed recently: writes to files, newest first. The module
    /// promises recorded changes, so reads and chatter do not belong here.
    pub fn since_records(&self) -> Vec<SinceRecord> {
        let mut records = Vec::new();
        for r in self.events.iter() {
            let tool = r.tool.as_deref().unwrap_or("");
            if !is_write_tool(tool) {
                continue;
            }
            let Some(target) = r.target.as_ref().filter(|t| is_file_path(t)) else {
                continue;
            };
            let (short_name, _) = extract_session_parts(&r.event);
            let path = clean_file_path(target);
            // Repeated writes to one file by one session are one change, counted.
            if let Some(last) = records.last_mut() {
                let last: &mut SinceRecord = last;
                if last.actor == short_name && last.path == path {
                    last.repeats += 1;
                    continue;
                }
            }
            records.push(SinceRecord {
                time: format_clock(r.event.ts),
                actor: short_name,
                change: format!("{tool} {path}"),
                path,
                repeats: 1,
                kind: if tool == "write" { "new" } else { "edit" },
            });
            if records.len() >= 12 {
                break;
            }
        }
        records
    }

    pub fn selected_machine(&self) -> Option<Machine> {
        if self.machines.is_empty() {
            None
        } else {
            Some(self.machines[self.mesh_cursor.min(self.machines.len() - 1)].clone())
        }
    }

    pub fn conversation_threads(&self) -> Vec<ConversationThread> {
        let agents = self.agents();
        if agents.is_empty() {
            return Vec::new();
        }

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let window_ms: u64 = 30 * 60 * 1000;

        agents
            .into_iter()
            .map(|a| {
                // Real activity segments: the slices of the last 30 minutes in
                // which this session actually emitted events. Nothing invented.
                const BUCKETS: usize = 20;
                let mut hit = [false; BUCKETS];
                for r in self.events.iter().filter(|r| r.event.session_id == a.id) {
                    let ts = event_ts_ms(r.event.ts);
                    if ts + window_ms >= now {
                        let off = ts.saturating_sub(now.saturating_sub(window_ms));
                        let idx = ((off as f64 / window_ms as f64) * BUCKETS as f64) as usize;
                        hit[idx.min(BUCKETS - 1)] = true;
                    }
                }
                let mut segments = Vec::new();
                let mut run_start: Option<usize> = None;
                for (i, on) in hit.into_iter().chain(std::iter::once(false)).enumerate() {
                    match (on, run_start) {
                        (true, None) => run_start = Some(i),
                        (false, Some(s)) => {
                            segments.push(ThreadSegment {
                                start: (s * 100 / BUCKETS) as u8,
                                width: (((i - s) * 100 / BUCKETS).max(2)) as u8,
                            });
                            run_start = None;
                        }
                        _ => {}
                    }
                }
                ConversationThread {
                    handle: a.handle,
                    age: a.age,
                    live: a.live,
                    segments,
                }
            })
            .collect()
    }

    pub fn clamp_cursors(&mut self) {
        let count = self.agents().len();
        if count == 0 {
            self.cursor = 0;
            self.peer_cursor = 0;
            self.deck_cursor = [0, 1, 2];
            for assignment in &mut self.deck_assignments {
                if matches!(assignment, DeckAssignment::Session(_)) {
                    *assignment = DeckAssignment::Unassigned;
                }
            }
        } else {
            self.cursor = self.cursor.min(count - 1);
            self.peer_cursor = self.peer_cursor.min(count - 1);
        }

        let plan_count = self.plans().len();
        if plan_count > 0 {
            self.plan_index = self.plan_index.min(plan_count - 1);
        }

        let slot_count = self.composition.modules().len();
        if slot_count > 0 {
            self.focused_slot = self.focused_slot.min(slot_count - 1);
        }

        if !self.machines.is_empty() {
            self.mesh_cursor = self.mesh_cursor.min(self.machines.len() - 1);
        }

        let harvest_items = self.harvest_item_count();
        if harvest_items > 0 {
            self.harvest_cursor = self.harvest_cursor.min(harvest_items - 1);
        }
    }

    fn rebase_agent_cursors(&mut self) {
        // Unpinned cursors intentionally follow the recency-sorted positions.
        // Avoid rebuilding the full fleet on every hydration event until the
        // operator has made a stable session choice.
        if self.selected_session_id.is_none()
            && !self
                .deck_assignments
                .iter()
                .any(|assignment| matches!(assignment, DeckAssignment::Session(_)))
        {
            return;
        }

        let agents = self.agents();
        if agents.is_empty() {
            self.cursor = 0;
            self.peer_cursor = 0;
            self.deck_cursor = [0, 1, 2];
            self.selected_session_id = None;
            for assignment in &mut self.deck_assignments {
                if matches!(assignment, DeckAssignment::Session(_)) {
                    *assignment = DeckAssignment::Unassigned;
                }
            }
            return;
        }

        rebase_cursor(&agents, &mut self.cursor, &mut self.selected_session_id);
        for col in 0..self.deck_cursor.len() {
            rebase_deck_cursor(
                &agents,
                &mut self.deck_cursor[col],
                &mut self.deck_assignments[col],
            );
        }
        self.peer_cursor = self.peer_cursor.min(agents.len() - 1);
    }
}

fn event_dedup_key(event: &TailEvent) -> String {
    [
        event.source.as_str(),
        event.session_id.as_str(),
        &event.ts.to_string(),
        event.kind.as_str(),
        event.summary.as_str(),
    ]
    .join("\0")
}

fn selection_index(agents: &[Agent], session_id: Option<&str>, fallback: usize) -> usize {
    session_id
        .and_then(|id| agents.iter().position(|agent| agent.id == id))
        .unwrap_or_else(|| fallback.min(agents.len().saturating_sub(1)))
}

fn rebase_cursor(agents: &[Agent], cursor: &mut usize, session_id: &mut Option<String>) {
    if let Some(index) = session_id
        .as_deref()
        .and_then(|id| agents.iter().position(|agent| agent.id == id))
    {
        *cursor = index;
    } else {
        *session_id = None;
        *cursor = (*cursor).min(agents.len().saturating_sub(1));
    }
}

fn rebase_deck_cursor(agents: &[Agent], cursor: &mut usize, assignment: &mut DeckAssignment) {
    let index = match assignment {
        DeckAssignment::Session(id) => agents.iter().position(|agent| agent.id == *id),
        DeckAssignment::Ordinal | DeckAssignment::Unassigned => return,
    };
    if let Some(index) = index {
        *cursor = index;
    } else {
        *assignment = DeckAssignment::Unassigned;
    }
}

/// Honest identity: the harness that produced the event plus a short slice of the
/// real session id. Never a made-up persona — two codex sessions are two names.
pub fn extract_session_parts(event: &TailEvent) -> (String, String) {
    let source = event.source.trim().to_lowercase();
    let source = if source.is_empty() {
        "agent".to_string()
    } else {
        source
    };
    // The tail of a session id stays random even when ids are time-ordered, so
    // sibling sessions from one harness don't collapse onto the same handle.
    let sid: Vec<char> = event
        .session_id
        .trim()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    let sid_bit: String = sid[sid.len().saturating_sub(4)..].iter().collect();
    let name = if sid_bit.is_empty() {
        source.clone()
    } else {
        format!("{source}·{sid_bit}")
    };

    let project = event
        .project
        .clone()
        .filter(|p| !p.trim().is_empty())
        .or_else(|| {
            event.cwd.as_ref().and_then(|cwd| {
                std::path::Path::new(cwd)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
            })
        })
        .unwrap_or_else(|| "?".into());

    (name, project)
}

pub fn letterspace(text: &str) -> String {
    let mut out = String::new();
    let chars: Vec<char> = text.chars().collect();
    for (i, c) in chars.iter().enumerate() {
        out.push(*c);
        if i + 1 < chars.len() {
            out.push(' ');
        }
    }
    out
}

pub fn truncate(text: &str, width: usize) -> String {
    if UnicodeWidthStr::width(text) <= width {
        text.to_string()
    } else if width == 0 {
        String::new()
    } else {
        let ellipsis = '…';
        let budget = width.saturating_sub(UnicodeWidthChar::width(ellipsis).unwrap_or(1));
        let mut used = 0;
        let mut truncated = String::new();
        for character in text.chars() {
            let character_width = UnicodeWidthChar::width(character).unwrap_or(0);
            if used + character_width > budget {
                break;
            }
            truncated.push(character);
            used += character_width;
        }
        truncated.push(ellipsis);
        truncated
    }
}

/// Shorten a path from the left, where the meaningful part lives at the tail.
pub fn truncate_path(path: &str, width: usize) -> String {
    let count = path.chars().count();
    if count <= width || width < 4 {
        return path.to_string();
    }
    let tail: String = path.chars().skip(count - (width - 1)).collect();
    format!("…{tail}")
}

pub fn pad_right(text: &str, width: usize) -> String {
    let count = UnicodeWidthStr::width(text);
    if count >= width {
        text.to_string()
    } else {
        format!("{}{}", text, " ".repeat(width - count))
    }
}

/// Wall-clock HH:MM in the operator's local zone, the same clock their
/// terminal's other panes show.
pub fn format_clock(ts: i64) -> String {
    let secs = (event_ts_ms(ts) / 1000) as libc::time_t;
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    let (hours, mins) = if unsafe { libc::localtime_r(&secs, &mut tm) }.is_null() {
        let day = secs.rem_euclid(86_400);
        (day / 3600, (day / 60) % 60)
    } else {
        (tm.tm_hour as libc::time_t, tm.tm_min as libc::time_t)
    };
    format!("{hours:02}:{mins:02}")
}

pub fn format_age(ts: i64) -> String {
    let ts_ms = event_ts_ms(ts);
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    let delta_ms = now_ms.saturating_sub(ts_ms);
    let secs = delta_ms / 1000;
    if secs < 60 {
        format!("{secs}s")
    } else if secs < 3600 {
        format!("{}m", secs / 60)
    } else if secs < 86400 {
        format!("{}h", secs / 3600)
    } else {
        format!("{}d", secs / 86400)
    }
}

pub fn event_ts_ms(ts: i64) -> u64 {
    if ts > 1_000_000_000_000 {
        ts as u64
    } else {
        (ts * 1000) as u64
    }
}

/// Only phrases that actually mean "a human must act". Routine automation chatter
/// like codex's "approval review" heartbeats must NOT trip this.
pub fn event_needs_you(event: &TailEvent) -> bool {
    let sum = event.summary.to_lowercase();
    sum.contains("needs you")
        || sum.contains("needs-you")
        || sum.contains("needs your")
        || sum.contains("waiting on user")
        || sum.contains("waiting for user")
        || sum.contains("approval required")
        || sum.contains("requires approval")
        || sum.contains("permission required")
        || sum.contains("permission request")
        || sum.contains("blocked on")
}

/// The harness a session runs on, taken from the event's own source. An
/// unrecognised source is reported as itself, never guessed into a known name.
pub fn derive_harness(event: &TailEvent) -> String {
    let s = event.source.trim().to_lowercase();
    if s.is_empty() {
        return "agent".into();
    }
    for known in [
        "claude", "codex", "grok", "kimi", "cursor", "opencode", "copilot", "gemini",
    ] {
        if s.contains(known) {
            return known.to_string();
        }
    }
    s.split(|c: char| !c.is_ascii_alphanumeric())
        .find(|part| !part.is_empty())
        .unwrap_or("agent")
        .to_string()
}

/// The broker this TUI talks to is local, so every observed session runs on this
/// machine. Report the real hostname — never an invented one.
pub fn derive_host(_session_id: &str, _event: &TailEvent) -> String {
    local_hostname()
}

pub fn local_hostname() -> String {
    static HOSTNAME: OnceLock<String> = OnceLock::new();
    HOSTNAME
        .get_or_init(|| {
            let mut buf = [0u8; 256];
            let ok = unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) };
            if ok == 0 {
                let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
                let full = String::from_utf8_lossy(&buf[..end]).to_string();
                let short = full.split('.').next().unwrap_or(&full).to_string();
                if !short.is_empty() {
                    return short;
                }
            }
            "this-machine".into()
        })
        .clone()
}

/// True for bracketed stream bookkeeping ("[assistant]", "[attachment]") that
/// stands in for a message rather than being one.
pub fn is_stream_marker(text: &str) -> bool {
    let t = text.trim();
    t.is_empty() || (t.starts_with('[') && t.ends_with(']') && !t.contains(' '))
}

pub fn clean_summary(raw: &str) -> String {
    raw.trim()
        .replace('\n', " ")
        .replace('\r', "")
        .replace("  ", " ")
}

pub fn short_session(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.len() <= 10 {
        return trimmed.to_string();
    }
    let parts: Vec<&str> = trimmed.split(&['-', '_', '.'][..]).collect();
    if parts.len() > 1 && parts[0].len() >= 3 {
        parts[0].to_string()
    } else {
        trimmed.chars().take(8).collect()
    }
}

pub fn is_write_tool(tool: &str) -> bool {
    matches!(
        tool.to_ascii_lowercase().as_str(),
        "edit"
            | "write"
            | "notebookedit"
            | "multiedit"
            | "search_replace"
            | "str_replace"
            | "apply_patch"
    )
}

pub fn is_file_path(path: &str) -> bool {
    let p = path.trim();
    (p.contains('/') || p.contains('.'))
        && !p.starts_with("http")
        && !p.contains(' ')
        && p.len() > 2
}

/// Resolve a tool's target against the session's working directory so churn can
/// be matched to git's own paths.
pub fn absolute_path(target: &str, cwd: &str) -> String {
    let mut p = target.trim().to_string();
    if let Some(idx) = p.find("file://") {
        p = p[idx + 7..].to_string();
    }
    if p.starts_with('/') {
        return p;
    }
    if cwd.trim().is_empty() {
        return p;
    }
    format!(
        "{}/{}",
        cwd.trim_end_matches('/'),
        p.trim_start_matches("./")
    )
}

pub fn clean_file_path(path: &str) -> String {
    let mut p = path.trim().to_string();
    if let Some(idx) = p.find("file://") {
        p = p[idx + 7..].to_string();
    }
    if let Some(idx) = p.find("/Users/") {
        if let Some(rel_idx) = p[idx..].find("/openscout/") {
            p = p[idx + rel_idx + 11..].to_string();
        }
    }
    p
}

fn tui_state_path() -> PathBuf {
    if let Ok(home) = std::env::var("OPENSCOUT_HOME") {
        let trimmed = home.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed).join("tui-state.json");
        }
    }
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join(".openscout/tui-state.json")
}

fn load_detail_split() -> Option<u16> {
    let text = std::fs::read_to_string(tui_state_path()).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let split = value.get("detailSplit")?.as_u64()? as u16;
    Some(split.clamp(28, 75))
}

fn save_detail_split(split: u16) {
    if cfg!(test) {
        return;
    }
    let path = tui_state_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let body = serde_json::json!({ "detailSplit": split.clamp(28, 75) });
    let _ = std::fs::write(path, body.to_string());
}

/// Working, requests, then ended sessions; requests are never counted twice.
pub fn calm_group(a: &Agent) -> u8 {
    if a.needs {
        1
    } else if a.live {
        0
    } else {
        2
    }
}

/// Markdown and links read as plain words on one line.
pub fn plain(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = clean_summary(text);
    // [label](url) -> label
    while let Some(open) = rest.find('[') {
        let Some(mid) = rest[open..].find("](").map(|i| open + i) else {
            break;
        };
        let Some(close) = rest[mid..].find(')').map(|i| mid + i) else {
            break;
        };
        out.push_str(&rest[..open]);
        out.push_str(&rest[open + 1..mid]);
        rest = rest[close + 1..].to_string();
    }
    out.push_str(&rest);
    let out = out.replace("**", "").replace("__", "").replace('`', "");
    out.trim_start_matches(['#', '-', '*', ' '])
        .trim()
        .to_string()
}

fn first_sentence(text: &str) -> String {
    let end = text
        .char_indices()
        .find(|(i, c)| {
            matches!(c, '.' | '!' | '?' | ':') && text[i + c.len_utf8()..].starts_with(' ')
        })
        .map(|(i, _)| i)
        .unwrap_or(text.len());
    text[..end].trim().to_string()
}

/// One line per step: tool commands can carry whole heredocs.
pub fn step_line(text: &str) -> String {
    let line = plain(text.lines().next().unwrap_or(""));
    // "cd <dir> && cmd" reads as cmd; the directory is the session's own.
    let rest = line.as_str();
    for prefix in ["run_terminal_command · ", "Bash · ", "bash · ", "exec · "] {
        if let Some(cmd) = rest.strip_prefix(prefix) {
            let cmd = cmd.trim_start();
            let cmd = match cmd.strip_prefix("cd ").and_then(|c| c.split_once("&&")) {
                Some((_, after)) => after.trim_start(),
                None => cmd,
            };
            return format!("{}{}", prefix, cmd);
        }
    }
    match rest.strip_prefix("cd ").and_then(|c| c.split_once("&&")) {
        Some((_, after)) => after.trim_start().to_string(),
        None => rest.to_string(),
    }
}

/// Reasoning the harness streams as "[thinking] …" is not something said.
pub fn is_thinking(text: &str) -> bool {
    text.trim_start().starts_with("[thinking]")
}

pub fn prompt_title(prompt: &str) -> String {
    let prompt = prompt.trim();
    if [
        "Base directory for this skill:",
        "This session is being continued",
        "# AGENTS.md instructions",
        "## Page contract",
    ]
    .iter()
    .any(|prefix| prompt.starts_with(prefix))
    {
        return String::new();
    }

    let mut skip = false;
    let mut lines = Vec::new();
    for line in prompt.lines() {
        let line = line.trim();
        if line.starts_with("<") {
            skip = !line.starts_with("</") && !line.contains("</");
            continue;
        }
        if skip {
            continue;
        }
        if line.starts_with("Base directory for this skill:")
            || line.starts_with("This session is being continued")
        {
            continue;
        }
        if !line.is_empty() {
            lines.push(line);
        }
    }
    clean_summary(&lines.join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(id: usize, session_id: &str, ts: i64) -> TailEvent {
        TailEvent {
            id: format!("event-{id}"),
            ts,
            source: "codex".into(),
            session_id: session_id.into(),
            kind: "assistant".into(),
            summary: format!("response {id}"),
            project: Some("openscout".into()),
            cwd: Some("/work/openscout".into()),
            raw: None,
        }
    }

    #[test]
    fn parses_every_documented_take_and_composition() {
        let takes = [
            ("now", Take::Now),
            ("horizon", Take::Horizon),
            ("twin", Take::Twin),
            ("mesh", Take::Mesh),
            ("quota", Take::Quota),
            ("harvest", Take::Harvest),
            ("grid", Take::Grid),
        ];
        for (input, expected) in takes {
            assert_eq!(Take::parse(input), Some(expected));
        }
        assert_eq!(Composition::parse("focus"), Some(Composition::Focus));
        assert_eq!(Composition::parse("watch"), Some(Composition::Watch));
        assert_eq!(Composition::parse("review"), Some(Composition::Review));
        assert_eq!(Composition::parse("quad"), Some(Composition::Quad));
    }

    #[test]
    fn rejects_removed_slice_names() {
        for removed in ["tail", "sessions", "needs"] {
            assert_eq!(Take::parse(removed), None, "{removed} unexpectedly parsed");
        }
    }

    #[test]
    fn harvest_plants_grok_search_replace_as_fruit() {
        let mut app = App::new(Take::Harvest);
        app.ingest_event(TailEvent {
            id: "write-1".into(),
            ts: 1_700_000_000_000,
            source: "grok".into(),
            session_id: "session-g".into(),
            kind: "tool".into(),
            summary: "search_replace · app.rs".into(),
            project: Some("openscout".into()),
            cwd: Some("/work/openscout".into()),
            raw: Some(serde_json::json!({
                "tool_name": "search_replace",
                "tool_input": { "target_file": "/work/openscout/crates/scout-tui/src/app.rs" }
            })),
        });
        let trees = app.harvest_trees();
        assert_eq!(trees.len(), 1);
        assert_eq!(trees[0].files.len(), 1);
        assert!(
            trees[0].files[0].path.contains("app.rs"),
            "fruit path was {}",
            trees[0].files[0].path
        );
    }

    #[test]
    fn twin_visible_columns_cover_supported_widths_and_fleet_sizes() {
        let cases = [(60, [1, 1, 1, 1]), (85, [1, 2, 2, 2]), (160, [1, 2, 2, 3])];

        for (width, expected_by_fleet_size) in cases {
            for (fleet_size, expected) in expected_by_fleet_size.into_iter().enumerate() {
                assert_eq!(
                    twin_visible_columns(width, fleet_size),
                    expected,
                    "width={width}, fleet_size={fleet_size}"
                );
            }
        }
    }

    #[test]
    fn watch_grid_moves_to_visual_neighbors() {
        let mut app = App::new(Take::Grid);
        assert_eq!(app.composition, Composition::Watch);
        assert_eq!(app.focused_slot, 0);

        app.move_grid_focus(1, 0);
        assert_eq!(app.focused_slot, 1);
        app.move_grid_focus(1, 0);
        assert_eq!(app.focused_slot, 2);
        app.move_grid_focus(1, 0);
        assert_eq!(app.focused_slot, 2);
        app.move_grid_focus(0, 1);
        assert_eq!(app.focused_slot, 5);
        app.move_grid_focus(-1, 0);
        assert_eq!(app.focused_slot, 4);
        app.move_grid_focus(0, -1);
        assert_eq!(app.focused_slot, 1);
        app.move_grid_focus(0, -1);
        assert_eq!(app.focused_slot, 1);
    }

    #[test]
    fn focus_and_review_grids_fill_columns_first() {
        let mut app = App::new(Take::Grid);
        app.set_composition(Composition::Focus);
        app.move_grid_focus(0, 1);
        assert_eq!(app.focused_slot, 1);
        app.move_grid_focus(1, 0);
        assert_eq!(app.focused_slot, 3);

        app.set_composition(Composition::Review);
        app.move_grid_focus(1, 0);
        assert_eq!(app.focused_slot, 2);
        app.move_grid_focus(0, 1);
        assert_eq!(app.focused_slot, 3);
    }

    #[test]
    fn quad_grid_fills_rows_first() {
        let mut app = App::new(Take::Grid);
        app.set_composition(Composition::Quad);
        app.move_grid_focus(1, 0);
        assert_eq!(app.focused_slot, 1);
        app.move_grid_focus(0, 1);
        assert_eq!(app.focused_slot, 3);
        app.move_grid_focus(-1, 0);
        assert_eq!(app.focused_slot, 2);
    }

    #[test]
    fn deck_slots_without_an_agent_stay_unassigned() {
        let mut app = App::new(Take::Twin);
        app.ingest_event(event(1, "session-a", 1_700_000_000_000));
        app.clamp_cursors();

        assert_eq!(
            app.deck_agent(0).as_ref().map(|agent| agent.id.as_str()),
            Some("session-a")
        );
        assert!(app.deck_agent(1).is_none());
        assert!(app.deck_agent(2).is_none());
        assert!(app.deck_agent(3).is_none());
    }

    #[test]
    fn dedup_state_stays_bounded_with_the_event_window() {
        let mut app = App::new(Take::Now);
        let first = event(0, "session-0", 1_700_000_000_000);
        app.ingest_event(first.clone());
        app.ingest_event(first.clone());
        assert_eq!(app.events.len(), 1);

        for id in 1..=KEEP {
            app.ingest_event(event(
                id,
                &format!("session-{id}"),
                1_700_000_000_000 + id as i64,
            ));
        }
        assert_eq!(app.events.len(), KEEP);
        assert_eq!(app.seen.len(), KEEP);

        // The evicted key may be accepted again; dedup does not grow forever.
        app.ingest_event(first.clone());
        assert_eq!(app.events.len(), KEEP);
        assert_eq!(app.seen.len(), KEEP);
        assert_eq!(app.events.front().map(|row| &row.event.id), Some(&first.id));
    }

    #[test]
    fn dedupes_one_transcript_event_even_when_disk_and_live_ids_differ() {
        let mut app = App::new(Take::Now);
        let disk = event(1, "session-a", 1_700_000_000_000);
        let mut live = disk.clone();
        live.id = "live-offset-0".into();

        app.ingest_event(disk);
        app.ingest_event(live);

        assert_eq!(app.events.len(), 1);
    }

    #[test]
    fn selected_session_survives_recency_reordering() {
        let mut app = App::new(Take::Now);
        app.ingest_event(event(1, "session-a", 1_700_000_002_000));
        app.ingest_event(event(2, "session-b", 1_700_000_001_000));
        assert_eq!(
            app.selected_agent().as_ref().map(|agent| agent.id.as_str()),
            Some("session-a")
        );

        app.move_cursor(1);
        assert_eq!(
            app.selected_agent().as_ref().map(|agent| agent.id.as_str()),
            Some("session-b")
        );

        app.ingest_event(event(3, "session-b", 1_700_000_003_000));

        assert_eq!(app.cursor, 0);
        assert_eq!(
            app.selected_agent().as_ref().map(|agent| agent.id.as_str()),
            Some("session-b")
        );
    }

    #[test]
    fn selected_twin_column_survives_recency_reordering() {
        let mut app = App::new(Take::Twin);
        app.ingest_event(event(1, "session-a", 1_700_000_002_000));
        app.ingest_event(event(2, "session-b", 1_700_000_001_000));

        app.move_cursor(1);
        assert_eq!(
            app.deck_agent(0).as_ref().map(|agent| agent.id.as_str()),
            Some("session-b")
        );

        app.ingest_event(event(3, "session-b", 1_700_000_003_000));

        assert_eq!(app.deck_cursor[0], 0);
        assert_eq!(
            app.deck_agent(0).as_ref().map(|agent| agent.id.as_str()),
            Some("session-b")
        );
    }

    #[test]
    fn evicted_pinned_twin_session_becomes_unassigned() {
        let mut app = App::new(Take::Twin);
        app.ingest_event(event(0, "session-a", 1_700_000_010_000));
        app.ingest_event(event(1, "session-b", 1_700_000_000_000));

        // Pin session-a while it occupies ordinal zero.
        app.move_cursor(0);
        assert_eq!(
            app.deck_agent(0).as_ref().map(|agent| agent.id.as_str()),
            Some("session-a")
        );

        // Keep session-b at the older timestamp while enough of its events
        // arrive to evict session-a from the retained event window. It then
        // occupies session-a's old ordinal zero and must not inherit the deck.
        for id in 2..=KEEP {
            app.ingest_event(event(id, "session-b", 1_700_000_000_000));
        }

        assert_eq!(app.agents()[0].id, "session-b");
        assert_eq!(app.deck_assignments[0], DeckAssignment::Unassigned);
        assert!(app.deck_agent(0).is_none());
    }

    #[test]
    fn truncation_uses_terminal_display_width() {
        assert_eq!(truncate("A界B", 3), "A…");
        assert_eq!(UnicodeWidthStr::width(truncate("A界B", 3).as_str()), 2);
        assert_eq!(truncate("éclair", 4), "écl…");
    }

    #[test]
    fn a_quiet_live_session_gets_no_invented_activity_tick() {
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        let mut app = App::new(Take::Now);
        app.ingest_event(event(1, "session-live-but-quiet", now_ms - 75_000));

        let agents = app.agents();
        assert_eq!(agents.len(), 1);
        assert!(agents[0].live);
        assert!(agents[0].ticks.is_empty());
    }

    #[test]
    fn dossier_split_clamps_and_maps_pointer_column() {
        let mut app = App::new(Take::Harvest);
        app.set_body(0, 100);
        app.nudge_split(100);
        assert_eq!(app.detail_split, 75);
        app.nudge_split(-100);
        assert_eq!(app.detail_split, 28);
        app.set_split_from_col(40);
        assert_eq!(app.detail_split, 40);
        app.set_split_from_col(0);
        assert_eq!(app.detail_split, 28);
    }
}
