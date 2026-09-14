#![allow(dead_code)]

use ratatui::style::{Color, Modifier, Style};

/// "Ash and Ember" — warm near-black room, one live orange.
///
/// Ambient ramp is the Nightwatch calibration: ASH/SMOKE stay readable as
/// machine chatter, HEARTH actually lifts off GROUND. Ember is the single
/// chromatic hue (live, selected, pulse, prompt). SIGNAL is a brighter gold
/// reserved for needs-you. FAULT is failure.
pub const GROUND: Color = Color::Rgb(12, 10, 8); // #0C0A08 — the room. Warm near-black.
pub const HEARTH: Color = Color::Rgb(34, 28, 22); // #221C16 — selected fill; must read as a tile.
pub const HAIR: Color = Color::Rgb(58, 50, 40); // #3A3228 — hairlines, idle pulse cells.
pub const ASH: Color = Color::Rgb(138, 125, 110); // #8A7D6E — machine chatter: tools, clocks, JSON.
pub const SMOKE: Color = Color::Rgb(196, 182, 166); // #C4B6A6 — secondary text: unselected names, ages.
pub const BONE: Color = Color::Rgb(240, 230, 216); // #F0E6D8 — human words and assistant prose.
pub const EMBER: Color = Color::Rgb(255, 133, 51); // #FF8533 — the one live hue. Pulse, selected, live.
pub const EMBER_DIM: Color = Color::Rgb(196, 94, 36); // #C45E24 — cooled coal; older pulse cells.
pub const SIGNAL: Color = Color::Rgb(255, 196, 77); // #FFC44D — earned gold. Blocked / needs-you only.
pub const FAULT: Color = Color::Rgb(226, 86, 77); // #E2564D — earned failure.

/// Ember decay / recency ramp. Fresh coal → spent coal. Never cool zinc.
pub const AGE0: Color = EMBER; // #FF8533
pub const AGE1: Color = Color::Rgb(224, 112, 46); // #E0702E
pub const AGE2: Color = Color::Rgb(176, 90, 40); // #B05A28
pub const AGE3: Color = Color::Rgb(122, 72, 38); // #7A4826
pub const AGE4: Color = Color::Rgb(74, 50, 32); // #4A3220

// Compatibility aliases
pub const PHOSPHOR: Color = EMBER;
pub const RULE: Color = HAIR;
pub const ACCENT: Color = EMBER;
pub const BG: Color = GROUND;
pub const SURFACE: Color = HEARTH;
pub const FAINT: Color = ASH;
pub const DIM: Color = ASH;
pub const MUTED: Color = SMOKE;
pub const TEXT: Color = BONE;
pub const WAIT: Color = SIGNAL;
pub const ERR: Color = FAULT;

pub fn fg(color: Color) -> Style {
    Style::default().fg(color)
}

pub fn bold(color: Color) -> Style {
    Style::default().fg(color).add_modifier(Modifier::BOLD)
}

pub fn hero_tile_style() -> Style {
    Style::default().fg(BONE).bg(HEARTH)
}

pub fn chip_selected_style() -> Style {
    Style::default()
        .fg(EMBER)
        .bg(HEARTH)
        .add_modifier(Modifier::BOLD)
}

pub fn chip_normal_style() -> Style {
    Style::default().fg(SMOKE).bg(GROUND)
}
