#![allow(dead_code)]

use ratatui::style::{Color, Modifier, Style};

/// "Ash and Phosphor" Palette — Committed 2026 Visual Direction.
/// Warm near-black room canvas (#0A0908). Phosphor is the one live hue.
pub const GROUND: Color = Color::Rgb(10, 9, 8); // #0A0908 — the room. Warm near-black. Full canvas.
pub const HEARTH: Color = Color::Rgb(20, 18, 16); // #141210 — the only fill in the frame. Selected agent's tile.
pub const HAIR: Color = Color::Rgb(42, 38, 33); // #2A2621 — hairlines, pulse rule at rest.
pub const ASH: Color = Color::Rgb(90, 82, 72); // #5A5248 — machine chatter: tools, results, reasoning, clocks, JSON.
pub const SMOKE: Color = Color::Rgb(154, 145, 134); // #9A9186 — secondary text: unselected agent names, ages, eyebrows.
pub const BONE: Color = Color::Rgb(237, 231, 223); // #EDE7DF — human words and assistant prose. Bright text.
pub const PHOSPHOR: Color = Color::Rgb(61, 220, 151); // #3DDC97 — the one live hue. Pulse cells, active mark.
pub const SIGNAL: Color = Color::Rgb(240, 169, 59); // #F0A93B — earned amber. Blocked / needs-you only.
pub const FAULT: Color = Color::Rgb(226, 86, 77); // #E2564D — earned failure.

// Phosphor decay / recency ramp
pub const AGE0: Color = Color::Rgb(244, 244, 245);
pub const AGE1: Color = Color::Rgb(201, 206, 214);
pub const AGE2: Color = Color::Rgb(135, 142, 153);
pub const AGE3: Color = Color::Rgb(86, 92, 102);
pub const AGE4: Color = Color::Rgb(53, 57, 63);

// Compatibility aliases
pub const RULE: Color = HAIR;
pub const ACCENT: Color = PHOSPHOR;
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
        .fg(BONE)
        .bg(HEARTH)
        .add_modifier(Modifier::BOLD)
}

pub fn chip_normal_style() -> Style {
    Style::default().fg(SMOKE).bg(GROUND)
}
