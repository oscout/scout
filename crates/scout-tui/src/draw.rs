#![allow(dead_code)]

use std::time::{SystemTime, UNIX_EPOCH};

use ratatui::layout::{Alignment, Constraint, Direction, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Padding, Paragraph};
use ratatui::Frame;
use unicode_width::UnicodeWidthStr;

use crate::app::{
    event_ts_ms, format_age, format_clock, letterspace, pad_right, truncate, truncate_path,
    twin_visible_columns, Agent, App, Composition, FileState, Machine, ModuleKind, Row, Take,
};
use crate::classify::Class;
use crate::machines::normalize_host;
use crate::theme::{ASH, BONE, GROUND, HAIR, HEARTH, PHOSPHOR, SIGNAL, SMOKE};

const SPARK_BARS: &[char] = &[' ', ' ', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
const EIGHTHS: &[char] = &[' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/// Greedy word-wrap capped at `max_lines`; the last line gets an ellipsis when clipped.
fn wrap_text(text: &str, width: usize, max_lines: usize) -> Vec<String> {
    if width < 4 || max_lines == 0 {
        return Vec::new();
    }
    let mut lines: Vec<String> = Vec::new();
    let mut current = String::new();
    for word in text.split_whitespace() {
        let word_len = UnicodeWidthStr::width(word);
        let cur_len = UnicodeWidthStr::width(current.as_str());
        if !current.is_empty() && cur_len + 1 + word_len > width {
            lines.push(std::mem::take(&mut current));
        }
        if current.is_empty() && word_len > width {
            current = truncate(word, width);
        } else if current.is_empty() {
            current = word.to_string();
        } else {
            current.push(' ');
            current.push_str(word);
        }
    }
    if !current.is_empty() {
        lines.push(current);
    }
    if lines.len() > max_lines {
        lines.truncate(max_lines);
        if let Some(last) = lines.last_mut() {
            *last = truncate(&format!("{last}…"), width);
        }
    }
    lines
}

/// Pad `lines` with blanks so `tail` renders on the bottom rows of an `height`-row pane.
fn anchor_bottom(lines: &mut Vec<Line<'static>>, tail: Vec<Line<'static>>, height: usize) {
    let needed = lines.len() + tail.len();
    if height > needed {
        for _ in 0..(height - needed) {
            lines.push(Line::from(""));
        }
    }
    lines.extend(tail);
}

/// What git says about a file we watched a session write to.
fn file_state_label(state: FileState) -> &'static str {
    match state {
        FileState::Changed => "changed",
        FileState::Clean => "matches HEAD",
        FileState::Untracked => "untracked",
        FileState::Outside => "outside repo",
        FileState::Unknown => "no git read",
    }
}

/// Bar length proportional to the largest diff on screen, minimum one cell.
fn scale_bar(value: usize, max: usize, cap: usize) -> usize {
    if value == 0 || cap == 0 {
        return 0;
    }
    ((value * cap) / max.max(1)).clamp(1, cap)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn draw(frame: &mut Frame, app: &mut App) {
    let area = frame.area();
    frame.render_widget(Block::default().style(Style::default().bg(GROUND)), area);

    if area.height < 6 || area.width < 30 {
        let msg = Line::from(Span::styled(
            "terminal too small for scout night instrument",
            Style::default().fg(ASH),
        ));
        frame.render_widget(Paragraph::new(msg), area);
        return;
    }

    if app.help {
        draw_help(frame, area);
        return;
    }

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1), // Mast / Header
            Constraint::Length(1), // Air
            Constraint::Min(4),    // Main Take Viewport
            Constraint::Length(1), // Footer / Keys
        ])
        .split(area);

    let mast_area = chunks[0];
    let body_area = chunks[2];
    let footer_area = chunks[3];

    let agents = app.agents();
    if app.take == Take::Twin {
        app.clamp_deck_focus(twin_visible_columns(body_area.width, agents.len()));
    }
    let selected = app.selected_agent();

    // 1. Mast (Header)
    draw_mast(frame, app, mast_area, &agents, selected.as_ref());

    // 2. Main Take Viewport
    if agents.is_empty()
        && app.take != Take::Mesh
        && app.take != Take::Quota
        && app.take != Take::Harvest
        && app.take != Take::Grid
    {
        draw_empty_state(frame, body_area);
    } else {
        match app.take {
            Take::Now => draw_take_now(frame, app, body_area, &agents, selected.as_ref()),
            Take::Horizon => draw_take_horizon(frame, app, body_area, &agents, selected.as_ref()),
            Take::Twin => draw_take_twin(frame, app, body_area, &agents, selected.as_ref()),
            Take::Mesh => draw_take_mesh(frame, app, body_area, &agents, selected.as_ref()),
            Take::Quota => draw_take_quota(frame, app, body_area, &agents),
            Take::Harvest => draw_take_harvest(frame, app, body_area),
            Take::Grid => draw_take_grid(frame, app, body_area, &agents, selected.as_ref()),
        }
    }

    // 3. Footer
    draw_footer(frame, app, footer_area, selected.as_ref());
}

fn draw_mast(frame: &mut Frame, app: &App, area: Rect, agents: &[Agent], selected: Option<&Agent>) {
    let width = area.width as usize;
    let live_count = agents.iter().filter(|a| a.live).count();
    let need_count = agents.iter().filter(|a| a.needs).count();

    let mut left_spans = Vec::new();
    left_spans.push(Span::styled("S c o u t", Style::default().fg(SMOKE)));
    left_spans.push(Span::styled("   ", Style::default()));

    if app.take == Take::Grid {
        let mods = app.composition.modules();
        let focused_mod = mods
            .get(app.focused_slot)
            .copied()
            .unwrap_or(ModuleKind::Current);
        left_spans.push(Span::styled(
            format!(
                "grid · {} · slot {} [{}] · [hjkl] move · [Tab] cycle · [g] comp",
                app.composition.title(),
                app.focused_slot + 1,
                focused_mod.label()
            ),
            Style::default().fg(BONE).add_modifier(Modifier::BOLD),
        ));
    } else if app.take == Take::Twin {
        left_spans.push(Span::styled(
            format!(
                "deck · COL {} focused · [Tab/h/l] switch col · [j/k] switch agent",
                app.deck_focus + 1
            ),
            Style::default().fg(BONE).add_modifier(Modifier::BOLD),
        ));
    } else if app.take == Take::Mesh {
        let online = app.machines.iter().filter(|m| m.online).count();
        let scouts = app.machines.iter().filter(|m| m.scout.is_some()).count();
        left_spans.push(Span::styled(
            format!("{} machines", app.machines.len()),
            Style::default().fg(BONE),
        ));
        left_spans.push(Span::styled(" · ", Style::default().fg(ASH)));
        left_spans.push(Span::styled(
            format!("{online} online"),
            Style::default().fg(PHOSPHOR).add_modifier(Modifier::BOLD),
        ));
        left_spans.push(Span::styled(
            if app.scout_registry_ready {
                format!(" · {scouts} running scout")
            } else {
                " · reading the scout registry…".to_string()
            },
            Style::default().fg(ASH),
        ));
    } else if app.take == Take::Quota {
        left_spans.push(Span::styled(
            quota_mast_label(app),
            Style::default().fg(ASH),
        ));
    } else if app.take == Take::Harvest {
        let trees = app.harvest_trees();
        let total_files: usize = trees.iter().map(|t| t.files.len()).sum();
        let total_adds: usize = trees
            .iter()
            .flat_map(|t| t.files.iter().map(|f| f.adds))
            .sum();
        let total_dels: usize = trees
            .iter()
            .flat_map(|t| t.files.iter().map(|f| f.dels))
            .sum();
        left_spans.push(Span::styled(
            if total_adds == 0 && total_dels == 0 {
                format!(
                    "harvest · {} file{} touched · no diff against HEAD",
                    total_files,
                    if total_files == 1 { "" } else { "s" }
                )
            } else {
                format!(
                    "harvest · {} file{} · +{} −{} in the working trees",
                    total_files,
                    if total_files == 1 { "" } else { "s" },
                    total_adds,
                    total_dels
                )
            },
            Style::default().fg(BONE),
        ));
    } else {
        left_spans.push(Span::styled(
            format!(
                "{} session{}",
                agents.len(),
                if agents.len() == 1 { "" } else { "s" }
            ),
            Style::default().fg(BONE),
        ));
        if live_count > 0 {
            left_spans.push(Span::styled(" · ", Style::default().fg(ASH)));
            left_spans.push(Span::styled(
                format!("{} live", live_count),
                Style::default().fg(PHOSPHOR).add_modifier(Modifier::BOLD),
            ));
        } else {
            left_spans.push(Span::styled(" · quiet", Style::default().fg(ASH)));
        }
        if need_count > 0 {
            left_spans.push(Span::styled(" · ", Style::default().fg(ASH)));
            left_spans.push(Span::styled(
                format!("{} need", need_count),
                Style::default().fg(SIGNAL).add_modifier(Modifier::BOLD),
            ));
        }
        let newest_age = selected
            .map(|a| a.age.clone())
            .unwrap_or_else(|| "—".into());
        left_spans.push(Span::styled(
            format!(" · last {}", newest_age),
            Style::default().fg(ASH),
        ));
    }

    // Right side: Take Navigation chips
    let mut right_spans = Vec::new();
    let takes = [
        (Take::Now, "1 Now"),
        (Take::Horizon, "2 Horizon"),
        (Take::Twin, "3 Twin"),
        (Take::Mesh, "4 Mesh"),
        (Take::Quota, "5 Quota"),
        (Take::Harvest, "6 Harvest"),
        (Take::Grid, "7 Grid"),
    ];

    for (take, label) in takes {
        let is_active = app.take == take;
        if is_active {
            right_spans.push(Span::styled(
                format!(" [{label}] "),
                Style::default()
                    .fg(BONE)
                    .bg(HEARTH)
                    .add_modifier(Modifier::BOLD),
            ));
        } else {
            right_spans.push(Span::styled(format!(" {label} "), Style::default().fg(ASH)));
        }
    }

    let right_len: usize = right_spans
        .iter()
        .map(|span| UnicodeWidthStr::width(span.content.as_ref()))
        .sum();

    let mut line_spans = Vec::new();
    if width >= right_len + 16 {
        let max_left = width.saturating_sub(right_len + 2);
        let mut cur_len = 0;
        for s in left_spans {
            let span_width = UnicodeWidthStr::width(s.content.as_ref());
            if cur_len + span_width <= max_left {
                cur_len += span_width;
                line_spans.push(s);
            } else {
                let rem = max_left.saturating_sub(cur_len);
                if rem > 3 {
                    line_spans.push(Span::styled(truncate(s.content.as_ref(), rem), s.style));
                }
                break;
            }
        }
        let total_so_far: usize = line_spans
            .iter()
            .map(|span| UnicodeWidthStr::width(span.content.as_ref()))
            .sum();
        let gap = width.saturating_sub(total_so_far + right_len);
        if gap > 0 {
            line_spans.push(Span::styled(" ".repeat(gap), Style::default()));
        }
        line_spans.extend(right_spans);
    } else {
        line_spans = right_spans;
    }

    frame.render_widget(Paragraph::new(Line::from(line_spans)), area);
}

/// TAKE 1 · NOW (Hero, Fleet Floor Plan & Leaded Trace Stream)
fn draw_take_now(
    frame: &mut Frame,
    app: &App,
    area: Rect,
    agents: &[Agent],
    selected: Option<&Agent>,
) {
    let Some(agent) = selected else {
        draw_empty_state(frame, area);
        return;
    };

    let total_h = area.height;
    let hero_height = if total_h >= 44 {
        13
    } else if total_h >= 34 {
        10
    } else if total_h >= 24 {
        7
    } else {
        5
    };

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(hero_height), // Band 1: Hero & Floor Plan
            Constraint::Length(1),           // Air
            Constraint::Min(4),              // Band 2: Leaded Trace Stream
            Constraint::Length(1),           // Draft dock
        ])
        .split(area);

    let band1_area = chunks[0];
    let trace_area = chunks[2];
    let dock_area = chunks[3];

    // --- BAND 1: HERO TILE (Left) + FLOOR PLAN CHIPS (Center) + ALSO MOVING (Right) ---
    let width = area.width;
    let (hero_w, chips_w, side_w) = if width >= 110 {
        (
            Constraint::Percentage(42),
            Constraint::Percentage(38),
            Constraint::Percentage(20),
        )
    } else if width >= 80 {
        (
            Constraint::Percentage(50),
            Constraint::Percentage(50),
            Constraint::Length(0),
        )
    } else {
        (
            Constraint::Percentage(100),
            Constraint::Length(0),
            Constraint::Length(0),
        )
    };

    let band1_cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([hero_w, chips_w, side_w])
        .split(band1_area);

    // 1. Hero Tile
    draw_hero_card(frame, agent, band1_cols[0]);

    // 2. Floor Plan Chips
    if band1_cols[1].width > 0 {
        draw_floor_plan_chips(frame, app, agents, band1_cols[1]);
    }

    // 3. Also Moving Kicker
    if band1_cols[2].width > 0 {
        draw_also_moving_side(frame, agents, agent.id.as_str(), band1_cols[2]);
    }

    // --- BAND 2: LEADED TRACE STREAM ---
    draw_trace_stream(frame, app, &agent.id, trace_area);

    // --- DRAFT DOCK ---
    draw_dock(frame, app, &agent.handle, dock_area);
}

/// TAKE 2 · HORIZON (Time Axis Tracks Across Fleet)
fn draw_take_horizon(
    frame: &mut Frame,
    app: &App,
    area: Rect,
    agents: &[Agent],
    selected: Option<&Agent>,
) {
    if area.height < 4 || area.width < 30 {
        return;
    }

    let chunks = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage(58),
            Constraint::Length(1), // Gutter / separator
            Constraint::Percentage(41),
        ])
        .split(area);

    let tracks_area = chunks[0];
    let sep_area = chunks[1];
    let inspect_area = chunks[2];

    // Subtle vertical separator
    let sep_lines: Vec<Line> = (0..area.height)
        .map(|_| Line::from(Span::styled("│", Style::default().fg(HAIR))))
        .collect();
    frame.render_widget(Paragraph::new(sep_lines), sep_area);

    let width = tracks_area.width as usize;

    // Reserve a fleet-pulse skyline at the bottom when the terminal is tall enough.
    let n = agents.len().max(1);
    let total_rows = tracks_area.height as usize;
    let pulse_h: u16 = if total_rows >= n * 2 + 14 && width >= 40 {
        (total_rows - n * 2 - 4).clamp(7, 10) as u16
    } else {
        0
    };
    let (list_area, pulse_area) = if pulse_h > 0 {
        let split = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Min(4), Constraint::Length(pulse_h)])
            .split(tracks_area);
        (split[0], Some(split[1]))
    } else {
        (tracks_area, None)
    };

    let height = list_area.height as usize;

    let show_project = width >= 68;
    let meta_w = if show_project { 30 } else { 16 };
    let age_w = 5;
    let track_w = width.saturating_sub(meta_w + age_w).max(8);

    let mut lines = Vec::new();

    // 1. Header with Time Axis
    let mut axis_spans = Vec::new();
    if show_project {
        axis_spans.push(Span::styled(
            "AGENT            PROJECT      ",
            Style::default().fg(ASH),
        ));
    } else {
        axis_spans.push(Span::styled("AGENT           ", Style::default().fg(ASH)));
    }

    if track_w >= 28 {
        let left_pad = track_w / 3;
        let mid_pad = track_w.saturating_sub(left_pad + 12);
        axis_spans.push(Span::styled("-30m", Style::default().fg(ASH)));
        axis_spans.push(Span::styled(
            " ".repeat(left_pad.saturating_sub(4)),
            Style::default(),
        ));
        axis_spans.push(Span::styled("-15m", Style::default().fg(ASH)));
        axis_spans.push(Span::styled(
            " ".repeat(mid_pad.saturating_sub(4)),
            Style::default(),
        ));
        axis_spans.push(Span::styled("now", Style::default().fg(PHOSPHOR)));
    } else if track_w >= 14 {
        let pad = track_w.saturating_sub(7);
        axis_spans.push(Span::styled("-30m", Style::default().fg(ASH)));
        axis_spans.push(Span::styled(" ".repeat(pad), Style::default()));
        axis_spans.push(Span::styled("now", Style::default().fg(PHOSPHOR)));
    } else {
        axis_spans.push(Span::styled(
            format!("{:>w$}", "now", w = track_w),
            Style::default().fg(PHOSPHOR),
        ));
    }
    axis_spans.push(Span::styled("  AGE", Style::default().fg(ASH)));
    lines.push(Line::from(axis_spans));
    lines.push(Line::from(""));

    // 2. Track Rows with Scroll — lanes grow taller when the terminal has room.
    let avail = height.saturating_sub(2);
    let lane_h = if !agents.is_empty() && avail >= agents.len() * 3 {
        3
    } else if !agents.is_empty() && avail >= agents.len() * 2 {
        2
    } else {
        1
    };
    let max_visible = (avail / lane_h).max(1);
    let start_idx = if app.cursor >= max_visible {
        app.cursor.saturating_sub(max_visible - 1)
    } else {
        0
    };

    for (i, agent) in agents.iter().enumerate().skip(start_idx).take(max_visible) {
        let is_selected = app.cursor == i;
        let mark = if is_selected { "▸" } else { " " };
        let mut row_spans = Vec::new();

        row_spans.push(Span::styled(
            format!("{mark} "),
            Style::default().fg(if is_selected { PHOSPHOR } else { ASH }),
        ));

        if show_project {
            row_spans.push(Span::styled(
                format!("{:<15}", truncate(&agent.handle, 15)),
                if is_selected {
                    Style::default().fg(BONE).add_modifier(Modifier::BOLD)
                } else if agent.live {
                    Style::default().fg(PHOSPHOR)
                } else {
                    Style::default().fg(SMOKE)
                },
            ));
            row_spans.push(Span::styled(
                format!("{:>12} ", truncate(&format!("({})", agent.project), 12)),
                Style::default().fg(ASH),
            ));
        } else {
            row_spans.push(Span::styled(
                format!("{:<14}", truncate(&agent.handle, 14)),
                if is_selected {
                    Style::default().fg(BONE).add_modifier(Modifier::BOLD)
                } else if agent.live {
                    Style::default().fg(PHOSPHOR)
                } else {
                    Style::default().fg(SMOKE)
                },
            ));
        }

        // Render sparkline / event track for this agent across track_w
        let mut track_chars = vec!['·'; track_w];
        for &t in &agent.ticks {
            let pos = ((t * (track_w as f32)) as usize).min(track_w.saturating_sub(1));
            track_chars[pos] = if agent.live && pos >= track_w.saturating_sub(2) {
                '█'
            } else {
                '■'
            };
        }

        for (idx, ch) in track_chars.into_iter().enumerate() {
            if ch == '·' {
                row_spans.push(Span::styled("·", Style::default().fg(HAIR)));
            } else if agent.live && idx >= track_w.saturating_sub(3) {
                row_spans.push(Span::styled(
                    ch.to_string(),
                    Style::default().fg(PHOSPHOR).add_modifier(Modifier::BOLD),
                ));
            } else if agent.live {
                row_spans.push(Span::styled(ch.to_string(), Style::default().fg(PHOSPHOR)));
            } else {
                row_spans.push(Span::styled(ch.to_string(), Style::default().fg(SMOKE)));
            }
        }

        row_spans.push(Span::styled(
            format!(" {:>4}", agent.age),
            Style::default().fg(if is_selected { BONE } else { ASH }),
        ));

        let mut row_line = Line::from(row_spans);
        if is_selected {
            row_line = row_line.style(Style::default().bg(HEARTH));
        }
        lines.push(row_line);

        // Tall lanes carry what the agent is doing under its track.
        if lane_h >= 2 {
            let sub = truncate(&agent.doing, width.saturating_sub(meta_w + 8));
            let mut sub_line = Line::from(vec![
                Span::styled(" ".repeat(meta_w), Style::default()),
                Span::styled(
                    sub,
                    Style::default().fg(if is_selected { SMOKE } else { ASH }),
                ),
            ]);
            if is_selected {
                sub_line = sub_line.style(Style::default().bg(HEARTH));
            }
            lines.push(sub_line);
        }
        if lane_h >= 3 {
            lines.push(Line::from(""));
        }
    }

    frame.render_widget(Paragraph::new(lines), list_area);

    // Fleet pulse skyline: every event in the last 30 minutes, bucketed across the width.
    if let Some(pulse_rect) = pulse_area {
        draw_fleet_pulse(frame, app, agents, pulse_rect);
    }

    // Right: Selected Agent Detail Card
    if let Some(agent) = selected {
        draw_agent_detail_card(frame, app, agent, inspect_area);
    }
}

/// Aggregate event amplitude across the whole fleet, last 30 minutes, full width.
fn draw_fleet_pulse(frame: &mut Frame, app: &App, agents: &[Agent], area: Rect) {
    let w = area.width as usize;
    let h = area.height as usize;
    if w < 20 || h < 5 {
        return;
    }

    let window_ms: u64 = 30 * 60 * 1000;
    let now = now_ms();
    let start = now.saturating_sub(window_ms);
    let mut buckets = vec![0usize; w];
    let mut total = 0usize;
    for r in &app.events {
        let ts = r.event.ts.max(0) as u64;
        if ts >= start {
            let off = (ts - start).min(window_ms.saturating_sub(1));
            let idx = ((off as f64 / window_ms as f64) * w as f64) as usize;
            buckets[idx.min(w - 1)] += 1;
            total += 1;
        }
    }
    let peak = buckets.iter().copied().max().unwrap_or(0).max(1);
    let bar_rows = h.saturating_sub(3).max(1);
    // Columns inside the last five minutes burn phosphor; older ones settle to smoke.
    let recent_from = w.saturating_sub(w / 6);

    let mut lines = Vec::new();
    lines.push(Line::from(vec![
        Span::styled(
            "FLEET PULSE",
            Style::default().fg(BONE).add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            format!(
                " · last 30m · {} events · {} sessions · peak {}/col",
                total,
                agents.len(),
                peak
            ),
            Style::default().fg(ASH),
        ),
    ]));

    for row in 0..bar_rows {
        let base = (bar_rows - 1 - row) * 8;
        let mut spans: Vec<Span> = Vec::with_capacity(w);
        for (col, &count) in buckets.iter().enumerate() {
            let filled = count * bar_rows * 8 / peak;
            let cell = filled.saturating_sub(base).min(8);
            if cell == 0 {
                if row == bar_rows - 1 {
                    spans.push(Span::styled("·", Style::default().fg(HAIR)));
                } else {
                    spans.push(Span::styled(" ", Style::default()));
                }
            } else {
                let color = if col >= recent_from { PHOSPHOR } else { SMOKE };
                spans.push(Span::styled(
                    EIGHTHS[cell].to_string(),
                    Style::default().fg(color),
                ));
            }
        }
        lines.push(Line::from(spans));
    }

    // Time ruler under the skyline.
    let mut ruler = String::with_capacity(w);
    ruler.push_str("-30m");
    let mid = w / 2;
    while ruler.chars().count() < mid.saturating_sub(2) {
        ruler.push('─');
    }
    ruler.push_str("-15m");
    while ruler.chars().count() < w.saturating_sub(3) {
        ruler.push('─');
    }
    let ruler = truncate(&ruler, w.saturating_sub(3));
    lines.push(Line::from(vec![
        Span::styled(ruler, Style::default().fg(HAIR)),
        Span::styled("now", Style::default().fg(PHOSPHOR)),
    ]));

    frame.render_widget(Paragraph::new(lines), area);
}
/// TAKE 3 · TWIN / DECK (Multi-Column Live Stream Deck · TweetDeck Style)
fn draw_take_twin(
    frame: &mut Frame,
    app: &App,
    area: Rect,
    agents: &[Agent],
    _selected: Option<&Agent>,
) {
    if area.width < 30 || area.height < 6 {
        return;
    }

    let num_cols = twin_visible_columns(area.width, agents.len());

    if num_cols == 3 {
        let chunks = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([
                Constraint::Percentage(33),
                Constraint::Length(1), // Divider
                Constraint::Percentage(33),
                Constraint::Length(1), // Divider
                Constraint::Percentage(34),
            ])
            .split(area);

        for &sep_idx in &[1, 3] {
            let sep_lines: Vec<Line> = (0..area.height)
                .map(|_| Line::from(Span::styled("│", Style::default().fg(HAIR))))
                .collect();
            frame.render_widget(Paragraph::new(sep_lines), chunks[sep_idx]);
        }

        let col0_agent = app.deck_agent(0);
        let col1_agent = app.deck_agent(1);
        let col2_agent = app.deck_agent(2);

        draw_deck_column(frame, app, 0, col0_agent.as_ref(), chunks[0]);
        draw_deck_column(frame, app, 1, col1_agent.as_ref(), chunks[2]);
        draw_deck_column(frame, app, 2, col2_agent.as_ref(), chunks[4]);
    } else if num_cols == 2 {
        let chunks = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([
                Constraint::Percentage(50),
                Constraint::Length(1), // Divider
                Constraint::Percentage(50),
            ])
            .split(area);

        let sep_lines: Vec<Line> = (0..area.height)
            .map(|_| Line::from(Span::styled("│", Style::default().fg(HAIR))))
            .collect();
        frame.render_widget(Paragraph::new(sep_lines), chunks[1]);

        let col0_agent = app.deck_agent(0);
        let col1_agent = app.deck_agent(1);

        draw_deck_column(frame, app, 0, col0_agent.as_ref(), chunks[0]);
        draw_deck_column(frame, app, 1, col1_agent.as_ref(), chunks[2]);
    } else {
        let col0_agent = app.deck_agent(0);
        draw_deck_column(frame, app, 0, col0_agent.as_ref(), area);
    }
}

fn draw_deck_column(
    frame: &mut Frame,
    app: &App,
    col_idx: usize,
    agent: Option<&Agent>,
    area: Rect,
) {
    if area.width < 10 || area.height < 4 {
        return;
    }

    let is_focus = app.deck_focus == col_idx;
    let col_w = area.width as usize;

    let Some(agent) = agent else {
        let mut lines = Vec::new();
        lines.push(Line::from(vec![
            Span::styled(
                format!("  [COL {}] ", col_idx + 1),
                Style::default().fg(if is_focus { PHOSPHOR } else { ASH }),
            ),
            Span::styled("EMPTY DECK STREAM", Style::default().fg(ASH)),
        ]));
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled(
            "  No session assigned to this column.",
            Style::default().fg(ASH),
        )));
        lines.push(Line::from(Span::styled(
            "  Press [j/k] to assign an active agent.",
            Style::default().fg(SMOKE),
        )));
        frame.render_widget(Paragraph::new(lines), area);
        return;
    };

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3), // Header mast
            Constraint::Length(1), // Hairline divider
            Constraint::Min(4),    // Event stream
            Constraint::Length(1), // Column dock
        ])
        .split(area);

    let header_area = chunks[0];
    let div_area = chunks[1];
    let stream_area = chunks[2];
    let dock_area = chunks[3];

    // --- 1. COLUMN HEADER ---
    let mut header_lines = Vec::new();

    let mut row1 = Vec::new();
    let focus_mark = if is_focus { "▸" } else { " " };
    row1.push(Span::styled(
        format!("{focus_mark}[COL {}] ", col_idx + 1),
        Style::default()
            .fg(if is_focus { PHOSPHOR } else { ASH })
            .add_modifier(if is_focus {
                Modifier::BOLD
            } else {
                Modifier::empty()
            }),
    ));
    row1.push(Span::styled(
        format!("{} ", agent.handle),
        if is_focus {
            Style::default().fg(BONE).add_modifier(Modifier::BOLD)
        } else if agent.live {
            Style::default().fg(PHOSPHOR)
        } else {
            Style::default().fg(SMOKE)
        },
    ));
    row1.push(Span::styled(
        format!("({}) ", truncate(&agent.project, 10)),
        Style::default().fg(ASH),
    ));
    row1.push(Span::styled(
        format!("[{}] ", agent.harness),
        Style::default().fg(PHOSPHOR),
    ));
    row1.push(Span::styled(
        if agent.live { "● live" } else { "○ quiet" },
        Style::default().fg(if agent.live { PHOSPHOR } else { SMOKE }),
    ));
    row1.push(Span::styled(
        format!(" · {}", agent.age),
        Style::default().fg(ASH),
    ));
    header_lines.push(Line::from(row1));

    let doing_text = format!("Doing: {}", agent.doing);
    header_lines.push(Line::from(Span::styled(
        truncate(&doing_text, col_w.saturating_sub(2)),
        Style::default().fg(BONE),
    )));

    if let Some(ask) = &agent.ask {
        let needs_text = format!("Needs: {ask}");
        header_lines.push(Line::from(Span::styled(
            truncate(&needs_text, col_w.saturating_sub(2)),
            Style::default().fg(SIGNAL).add_modifier(Modifier::BOLD),
        )));
    } else {
        let thought_text = format!("Thought: \"{}\"", agent.thought);
        header_lines.push(Line::from(Span::styled(
            truncate(&thought_text, col_w.saturating_sub(2)),
            Style::default().fg(SMOKE),
        )));
    }
    frame.render_widget(Paragraph::new(header_lines), header_area);

    // --- 2. HAIRLINE DIVIDER ---
    let div_char = if is_focus { "━" } else { "─" };
    let div_style = Style::default().fg(if is_focus { ASH } else { HAIR });
    let div_line = Line::from(Span::styled(div_char.repeat(col_w), div_style));
    frame.render_widget(Paragraph::new(div_line), div_area);

    // --- 3. LIVE EVENT STREAM ---
    draw_trace_stream(frame, app, &agent.id, stream_area);

    // --- 4. COLUMN DRAFT FOOTER ---
    let mut dock_spans = Vec::new();
    if is_focus {
        if app.composing {
            dock_spans.push(Span::styled("› ", Style::default().fg(SIGNAL)));
            dock_spans.push(Span::styled(
                format!("Draft for {}: ", agent.handle),
                Style::default().fg(BONE).add_modifier(Modifier::BOLD),
            ));
            dock_spans.push(Span::styled(app.draft.clone(), Style::default().fg(BONE)));
            dock_spans.push(Span::styled("█", Style::default().fg(PHOSPHOR)));
        } else if let Some(notice) = &app.composer_notice {
            dock_spans.push(Span::styled("NOT SENT · ", Style::default().fg(SIGNAL)));
            dock_spans.push(Span::styled(notice.clone(), Style::default().fg(ASH)));
            dock_spans.push(Span::styled(
                " · [i] edit retained draft",
                Style::default().fg(BONE),
            ));
        } else {
            dock_spans.push(Span::styled("› ", Style::default().fg(SIGNAL)));
            dock_spans.push(Span::styled(
                format!(
                    "Press [i] to draft for {} · sending unavailable ",
                    agent.handle
                ),
                Style::default().fg(BONE),
            ));
            dock_spans.push(Span::styled(
                "· [j/k] cycle agent · [Tab/h/l] next col",
                Style::default().fg(ASH),
            ));
        }
    } else {
        dock_spans.push(Span::styled(
            format!("  [Tab / h / l] focus COL {}", col_idx + 1),
            Style::default().fg(HAIR),
        ));
    }
    frame.render_widget(Paragraph::new(Line::from(dock_spans)), dock_area);
}

/// TAKE 4 · MESH (Interactive Topology Graph, Pairwise Route Matrix & Inter-Agent Channels)
/// TAKE 4 · MESH (Connected machines: this host, tailnet peers, scout mesh nodes)
fn draw_take_mesh(
    frame: &mut Frame,
    app: &App,
    area: Rect,
    agents: &[Agent],
    _selected: Option<&Agent>,
) {
    if area.width < 30 || area.height < 6 {
        return;
    }

    if app.machines.is_empty() {
        let detail = app
            .machines_error
            .clone()
            .unwrap_or_else(|| "waiting for the first tailscale and scout mesh probe".to_string());
        draw_gap_state(frame, area, "No connected machines.", &detail);
        return;
    }

    // Wide terminals get list beside detail; narrow ones stack the two.
    if area.width >= 92 {
        let cols = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([
                Constraint::Percentage(57),
                Constraint::Length(1),
                Constraint::Percentage(42),
            ])
            .split(area);

        let vsep: Vec<Line> = (0..area.height)
            .map(|_| Line::from(Span::styled("│", Style::default().fg(HAIR))))
            .collect();
        frame.render_widget(Paragraph::new(vsep), cols[1]);

        draw_machine_list(frame, app, agents, cols[0]);
        draw_machine_detail(frame, app, agents, cols[2]);
    } else {
        let rows = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Percentage(48), Constraint::Percentage(52)])
            .split(area);
        draw_machine_list(frame, app, agents, rows[0]);
        draw_machine_detail(frame, app, agents, rows[1]);
    }
}

/// Sessions observed on a machine. Host names come from the machine that
/// reported them, so the match is by name — never inferred from a session id.
fn machine_sessions<'a>(machine: &Machine, agents: &'a [Agent]) -> Vec<&'a Agent> {
    let key = normalize_host(&machine.name);
    let alt = normalize_host(machine.dns_name.split('.').next().unwrap_or(""));
    agents
        .iter()
        .filter(|a| {
            let host = normalize_host(&a.host);
            host == key || (!alt.is_empty() && host == alt)
        })
        .collect()
}

fn fmt_bytes(n: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut value = n as f64;
    let mut unit = 0usize;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{n} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

fn draw_machine_list(frame: &mut Frame, app: &App, agents: &[Agent], area: Rect) {
    let w = area.width as usize;
    let online = app.machines.iter().filter(|m| m.online).count();
    let scouts = app.machines.iter().filter(|m| m.scout.is_some()).count();

    let mut lines: Vec<Line> = Vec::new();
    lines.push(Line::from(vec![
        Span::styled(
            "CONNECTED MACHINES",
            Style::default().fg(BONE).add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            if app.scout_registry_ready {
                format!(
                    " · {online} of {} online · {scouts} running scout",
                    app.machines.len()
                )
            } else {
                format!(
                    " · {online} of {} online · reading the scout registry…",
                    app.machines.len()
                )
            },
            Style::default().fg(ASH),
        ),
    ]));
    lines.push(Line::from(""));

    // Lanes grow with the pane: one line each when tight, a session line when
    // there is room, and the mesh address when there is plenty.
    let body_h = (area.height as usize).saturating_sub(2);
    let count = app.machines.len().max(1);
    let rows_per = if body_h >= count * 3 {
        3
    } else if body_h >= count * 2 {
        2
    } else {
        1
    };
    // A blank line between lanes once every machine already has its full lane.
    let airy = rows_per > 1 && body_h >= count * (rows_per + 1);
    let lane = rows_per + usize::from(airy);
    let visible = (body_h / lane).max(1);
    let start = if app.mesh_cursor >= visible {
        app.mesh_cursor.saturating_sub(visible - 1)
    } else {
        0
    };

    let name_w = w.saturating_sub(52).clamp(11, 26);
    let show_ip = w >= 54;
    let show_os = w >= 66;
    let show_link = w >= 78;

    for (i, m) in app.machines.iter().enumerate().skip(start).take(visible) {
        let is_sel = i == app.mesh_cursor;
        let mut spans = Vec::new();
        spans.push(Span::styled(
            if is_sel { "▸ " } else { "  " }.to_string(),
            Style::default().fg(if is_sel { PHOSPHOR } else { ASH }),
        ));
        spans.push(Span::styled(
            format!("{} ", if m.online { "●" } else { "○" }),
            Style::default().fg(if m.online { PHOSPHOR } else { HAIR }),
        ));
        spans.push(Span::styled(
            pad_right(&truncate(&m.name, name_w), name_w + 1),
            if is_sel {
                Style::default().fg(BONE).add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(SMOKE)
            },
        ));
        spans.push(Span::styled(
            format!("{} ", if m.scout.is_some() { "◆" } else { " " }),
            Style::default().fg(PHOSPHOR),
        ));
        if show_ip {
            spans.push(Span::styled(
                pad_right(&truncate(if m.ip.is_empty() { "—" } else { &m.ip }, 15), 16),
                Style::default().fg(ASH),
            ));
        }
        if show_os {
            spans.push(Span::styled(
                pad_right(&truncate(if m.os.is_empty() { "—" } else { &m.os }, 7), 8),
                Style::default().fg(ASH),
            ));
        }
        // The age column is reserved before the link takes the slack, so a long
        // "last seen" stamp never falls off the right edge.
        let age = truncate(&m.last_seen, 12);
        let age_len = age.chars().count();
        if show_link {
            let used: usize = spans.iter().map(|s| s.content.chars().count()).sum();
            let link_w = w.saturating_sub(used + age_len + 2);
            if link_w >= 6 {
                spans.push(Span::styled(
                    pad_right(&truncate(&m.link, link_w.saturating_sub(1)), link_w),
                    Style::default().fg(if m.is_self { PHOSPHOR } else { ASH }),
                ));
            }
        }

        let used: usize = spans.iter().map(|s| s.content.chars().count()).sum();
        if w > used + age_len {
            spans.push(Span::styled(
                " ".repeat(w - used - age_len),
                Style::default(),
            ));
            spans.push(Span::styled(age, Style::default().fg(ASH)));
        }

        let mut line = Line::from(spans);
        if is_sel {
            line = line.style(Style::default().bg(HEARTH));
        }
        lines.push(line);

        if rows_per >= 2 {
            let sessions = machine_sessions(m, agents);
            let mut note = Vec::new();
            if sessions.is_empty() {
                note.push("no sessions observed".to_string());
            } else {
                let mut projects: Vec<String> = Vec::new();
                for s in &sessions {
                    if !projects.contains(&s.project) {
                        projects.push(s.project.clone());
                    }
                }
                projects.truncate(3);
                note.push(format!(
                    "{} session{} · {}",
                    sessions.len(),
                    if sessions.len() == 1 { "" } else { "s" },
                    projects.join(", ")
                ));
            }
            match &m.scout {
                Some(node) if !node.scope.is_empty() => {
                    note.push(format!("scout node · {} scope", node.scope));
                }
                Some(_) => note.push("scout node".to_string()),
                None => {}
            }
            let mut sub = Line::from(Span::styled(
                format!("      {}", truncate(&note.join(" · "), w.saturating_sub(8))),
                Style::default().fg(ASH),
            ));
            if is_sel {
                sub = sub.style(Style::default().bg(HEARTH));
            }
            lines.push(sub);
        }

        if rows_per >= 3 {
            let addr = match &m.scout {
                Some(node) if !node.broker_url.is_empty() => {
                    format!("broker {}", node.broker_url)
                }
                Some(_) => "scout node with no broker address".to_string(),
                None if m.dns_name.is_empty() => "no tailnet address".to_string(),
                None => m.dns_name.clone(),
            };
            let mut third = Line::from(Span::styled(
                format!("      {}", truncate(&addr, w.saturating_sub(8))),
                Style::default().fg(HAIR),
            ));
            if is_sel {
                third = third.style(Style::default().bg(HEARTH));
            }
            lines.push(third);
        }

        if airy {
            lines.push(Line::from(""));
        }
    }

    if let Some(err) = &app.machines_error {
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled(
            truncate(err, w.saturating_sub(2)),
            Style::default().fg(SIGNAL),
        )));
    }

    frame.render_widget(Paragraph::new(lines), area);
}

fn draw_machine_detail(frame: &mut Frame, app: &App, agents: &[Agent], area: Rect) {
    let Some(m) = app.selected_machine() else {
        return;
    };
    let w = area.width as usize;
    let h = area.height as usize;
    let value_w = w.saturating_sub(15).max(8);

    let field = |label: &str, value: String| -> Line<'static> {
        Line::from(vec![
            Span::styled(format!("{label:<13}"), Style::default().fg(ASH)),
            Span::styled(truncate(&value, value_w), Style::default().fg(BONE)),
        ])
    };

    let state = if m.is_self {
        "THIS MACHINE"
    } else if m.online {
        "ONLINE"
    } else {
        "OFFLINE"
    };

    let mut lines: Vec<Line> = Vec::new();
    lines.push(Line::from(vec![
        Span::styled(
            letterspace(&truncate(&m.name, 16).to_uppercase()),
            Style::default().fg(BONE).add_modifier(Modifier::BOLD),
        ),
        Span::styled("  ", Style::default()),
        Span::styled(
            state,
            Style::default().fg(if m.online { PHOSPHOR } else { ASH }),
        ),
    ]));
    lines.push(Line::from(""));

    lines.push(field(
        "Host",
        if m.dns_name.is_empty() {
            m.name.clone()
        } else {
            m.dns_name.clone()
        },
    ));
    lines.push(field(
        "Address",
        if m.ips.is_empty() {
            "—".to_string()
        } else {
            m.ips.join(", ")
        },
    ));
    lines.push(field(
        "System",
        if m.os.is_empty() {
            "—".into()
        } else {
            m.os.clone()
        },
    ));
    lines.push(field("Link", m.link.clone()));
    lines.push(field("Last seen", m.last_seen.clone()));
    if m.is_self {
        let presence = match m.scout.as_ref().map(|node| node.scope.as_str()) {
            Some("mesh") => "mesh-reachable",
            Some(scope) if !scope.is_empty() => scope,
            _ => "local-only",
        };
        lines.push(field("Presence", presence.into()));
    }
    if m.tx_bytes > 0 || m.rx_bytes > 0 {
        lines.push(field(
            "Traffic",
            format!("↑ {}  ↓ {}", fmt_bytes(m.tx_bytes), fmt_bytes(m.rx_bytes)),
        ));
    }
    if m.exit_node {
        lines.push(field("Exit node", "advertised".into()));
    }
    if !m.tags.is_empty() {
        lines.push(field("Tags", m.tags.join(" ")));
    }
    lines.push(Line::from(""));

    lines.push(Line::from(Span::styled(
        "SCOUT NODE",
        Style::default().fg(BONE).add_modifier(Modifier::BOLD),
    )));
    match &m.scout {
        Some(node) => {
            if !node.broker_url.is_empty() {
                lines.push(field("  Broker", node.broker_url.clone()));
            }
            if !node.web_url.is_empty() {
                lines.push(field("  Web", node.web_url.clone()));
            }
            if !node.scope.is_empty() {
                lines.push(field("  Scope", node.scope.clone()));
            }
            if !node.capabilities.is_empty() {
                lines.push(field("  Serves", node.capabilities.join(", ")));
            }
            if node.last_seen_ms > 0 {
                lines.push(field("  Registered", format_age(node.last_seen_ms)));
            }
        }
        None => {
            lines.push(Line::from(Span::styled(
                "  no broker advertised to the mesh",
                Style::default().fg(ASH),
            )));
        }
    }
    lines.push(Line::from(""));

    let sessions = machine_sessions(&m, agents);
    lines.push(Line::from(vec![
        Span::styled(
            "SESSIONS HERE",
            Style::default().fg(BONE).add_modifier(Modifier::BOLD),
        ),
        Span::styled(format!(" · {}", sessions.len()), Style::default().fg(ASH)),
    ]));
    if sessions.is_empty() {
        lines.push(Line::from(Span::styled(
            "  none observed from this broker",
            Style::default().fg(ASH),
        )));
    } else {
        let room = h.saturating_sub(lines.len() + 3);
        for a in sessions.iter().take(room) {
            lines.push(Line::from(vec![
                Span::styled(
                    format!("  {} ", if a.live { "●" } else { "·" }),
                    Style::default().fg(if a.live { PHOSPHOR } else { HAIR }),
                ),
                Span::styled(
                    pad_right(&a.handle, w.saturating_sub(24).clamp(10, 22)),
                    Style::default().fg(SMOKE),
                ),
                Span::styled(truncate(&a.project, 12), Style::default().fg(ASH)),
                Span::styled(format!(" {:>4}", a.age), Style::default().fg(ASH)),
            ]));
        }
    }

    let dock = if let Some(notice) = &app.mesh_notice {
        notice.clone()
    } else {
        "[p] ping · [a] announce this machine · [x] withdraw · [r] refresh".to_string()
    };
    let tail = vec![Line::from(vec![
        Span::styled("  › ", Style::default().fg(SIGNAL)),
        Span::styled(
            truncate(&dock, w.saturating_sub(6)),
            Style::default().fg(ASH),
        ),
    ])];
    anchor_bottom(&mut lines, tail, h);

    frame.render_widget(Paragraph::new(lines), area);
}

/// A named gap: what is missing and why, instead of sample data standing in for it.
fn draw_gap_state(frame: &mut Frame, area: Rect, headline: &str, detail: &str) {
    let mut lines = Vec::new();
    for _ in 0..(area.height / 2).saturating_sub(2) {
        lines.push(Line::from(""));
    }
    lines.push(Line::from(Span::styled("· ○ ·", Style::default().fg(HAIR))));
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        headline.to_string(),
        Style::default().fg(BONE).add_modifier(Modifier::BOLD),
    )));
    for wrapped in wrap_text(detail, (area.width as usize).saturating_sub(8).max(20), 3) {
        lines.push(Line::from(Span::styled(wrapped, Style::default().fg(ASH))));
    }
    frame.render_widget(Paragraph::new(lines).alignment(Alignment::Center), area);
}

fn quota_mast_label(app: &App) -> String {
    if !app.plans_ready {
        "quota · reading providers".to_string()
    } else if !app.plans.is_empty() {
        format!("{} provider engines", app.plans.len())
    } else if app.plans_error.is_some() {
        "quota · feed unreachable".to_string()
    } else {
        "quota · no windows yet".to_string()
    }
}

fn quota_gap(app: &App) -> Option<(&'static str, String)> {
    if !app.plans_ready {
        return Some((
            "Reading provider quota windows.",
            "Asking the local providers feed for plan windows and usage.".into(),
        ));
    }
    if !app.plans.is_empty() {
        return None;
    }
    if let Some(error) = &app.plans_error {
        return Some(("Provider quota feed unreachable.", error.clone()));
    }
    Some((
        "No provider quota windows yet.",
        "The local providers feed is live, but no quota windows are populated right now.".into(),
    ))
}

/// TAKE 6 · QUOTA (Provider Fuel Gauges & Budget Windows)
fn draw_take_quota(frame: &mut Frame, app: &App, area: Rect, _agents: &[Agent]) {
    let plans = app.plans();
    if let Some((headline, detail)) = quota_gap(app) {
        draw_gap_state(frame, area, headline, &detail);
        return;
    }

    let chunks = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(55), Constraint::Percentage(45)])
        .split(area);

    let left_area = chunks[0];
    let right_area = chunks[1];

    let selected_plan = app.selected_plan();

    let mut left_lines = Vec::new();
    left_lines.push(Line::from(vec![
        Span::styled(
            "PROVIDER FUEL GAUGES · TIER USAGE & LIMITS",
            Style::default().fg(BONE).add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            format!(" · {} active engine feeds", plans.len()),
            Style::default().fg(ASH),
        ),
    ]));
    left_lines.push(Line::from(""));

    // Rows per plan derived from the actual window count, not a guessed constant.
    let pane_w = left_area.width as usize;
    let gauge_w = pane_w.saturating_sub(84).clamp(20, 44);
    let rows_per_plan = 2 + plans.iter().map(|p| p.windows.len()).max().unwrap_or(2);
    let max_visible_plans = ((left_area.height as usize).saturating_sub(3) / rows_per_plan).max(1);
    let plan_start_idx = if app.plan_index >= max_visible_plans {
        app.plan_index.saturating_sub(max_visible_plans - 1)
    } else {
        0
    };

    for (i, p) in plans
        .iter()
        .enumerate()
        .skip(plan_start_idx)
        .take(max_visible_plans)
    {
        let is_sel = app.plan_index == i;
        let mark = if is_sel { "▸" } else { " " };
        let name_style = if is_sel {
            Style::default().fg(BONE).add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(SMOKE)
        };

        let mut head_spans = vec![
            Span::styled(
                format!("{mark} "),
                Style::default().fg(if is_sel { PHOSPHOR } else { ASH }),
            ),
            Span::styled(format!("{:<23}", truncate(&p.name, 22)), name_style),
        ];
        if !p.plan.is_empty() {
            head_spans.push(Span::styled(
                format!("({})", p.plan),
                Style::default().fg(ASH),
            ));
        }
        head_spans.push(Span::styled(
            format!(" · {} · {}", p.availability, p.burn_rate),
            Style::default().fg(ASH),
        ));
        let mut head_line = Line::from(head_spans);
        if is_sel {
            head_line = head_line.style(Style::default().bg(HEARTH));
        }
        left_lines.push(head_line);

        for w in &p.windows {
            let spark_str: String = w
                .spark
                .iter()
                .map(|&v| {
                    let idx = ((v * 8.0) as usize).min(SPARK_BARS.len() - 1);
                    SPARK_BARS[idx]
                })
                .collect();

            let bar_filled = ((w.used as usize) * gauge_w / 100).min(gauge_w);
            let bar_empty = gauge_w.saturating_sub(bar_filled);
            let gauge = format!("{}{}", "■".repeat(bar_filled), "─".repeat(bar_empty));

            let mut win_spans = Vec::new();
            win_spans.push(Span::styled("   ", Style::default()));
            win_spans.push(Span::styled(
                format!("{:<19}", truncate(&w.label, 18)),
                Style::default().fg(ASH),
            ));
            win_spans.push(Span::styled(
                format!("{gauge} "),
                Style::default().fg(if w.used > 80 {
                    SIGNAL
                } else if w.used > 50 {
                    PHOSPHOR
                } else {
                    SMOKE
                }),
            ));
            win_spans.push(Span::styled(
                format!("{:>3}% ", w.used),
                Style::default().fg(if w.used > 80 { SIGNAL } else { BONE }),
            ));
            win_spans.push(Span::styled(
                format!("(resets {}) ", w.reset),
                Style::default().fg(ASH),
            ));
            win_spans.push(Span::styled(spark_str, Style::default().fg(PHOSPHOR)));
            win_spans.push(Span::styled(
                format!(" · {}", w.pace),
                Style::default().fg(ASH),
            ));

            left_lines.push(Line::from(win_spans));
        }

        left_lines.push(Line::from(""));
    }

    // Tall pane: only show failover when the feed actually supplied a rule.
    let left_h = left_area.height as usize;
    let has_failover = plans.iter().any(|p| !p.failover.is_empty());
    if has_failover
        && plans.len() <= max_visible_plans
        && left_h >= left_lines.len() + plans.len() + 3
    {
        left_lines.push(Line::from(Span::styled(
            "ROUTING & FAILOVER",
            Style::default().fg(BONE).add_modifier(Modifier::BOLD),
        )));
        for p in plans {
            if p.failover.is_empty() {
                continue;
            }
            left_lines.push(Line::from(vec![
                Span::styled(
                    format!("  {:<24}", truncate(&p.name, 22)),
                    Style::default().fg(SMOKE),
                ),
                Span::styled(
                    truncate(&p.failover, pane_w.saturating_sub(28)),
                    Style::default().fg(ASH),
                ),
            ]));
        }
    }

    frame.render_widget(Paragraph::new(left_lines), left_area);

    // Right: Selected Provider Deep Inspection Card
    if let Some(p) = selected_plan {
        let mut right_lines = Vec::new();
        right_lines.push(Line::from(vec![
            Span::styled(
                letterspace(&p.name.to_uppercase()),
                Style::default().fg(BONE).add_modifier(Modifier::BOLD),
            ),
            Span::styled("  ", Style::default()),
            Span::styled(
                format!("SOURCE {}", p.source),
                Style::default().fg(PHOSPHOR),
            ),
        ]));
        right_lines.push(Line::from(""));

        right_lines.push(Line::from(vec![
            Span::styled("Tier & Plan:  ", Style::default().fg(ASH)),
            Span::styled(
                if p.plan.is_empty() {
                    "unreported".to_string()
                } else {
                    p.plan.clone()
                },
                Style::default().fg(BONE),
            ),
        ]));
        right_lines.push(Line::from(vec![
            Span::styled("Availability: ", Style::default().fg(ASH)),
            Span::styled(p.availability.clone(), Style::default().fg(PHOSPHOR)),
            Span::styled(
                format!(" · confidence {}", p.confidence),
                Style::default().fg(ASH),
            ),
        ]));
        right_lines.push(Line::from(vec![
            Span::styled("Burn Rate:    ", Style::default().fg(ASH)),
            Span::styled(p.burn_rate.clone(), Style::default().fg(SMOKE)),
        ]));
        if !p.primary_roles.is_empty() {
            right_lines.push(Line::from(vec![
                Span::styled("Orchestration:", Style::default().fg(ASH)),
                Span::styled(p.primary_roles.join(" · "), Style::default().fg(BONE)),
            ]));
        }
        if !p.failover.is_empty() {
            right_lines.push(Line::from(vec![
                Span::styled("Failover Rule:", Style::default().fg(ASH)),
                Span::styled(p.failover.clone(), Style::default().fg(SIGNAL)),
            ]));
        }
        right_lines.push(Line::from(""));

        // Window detail gauges — the deep inspection earns the tall pane.
        let rw = right_area.width as usize;
        let rh = right_area.height as usize;
        if rh >= right_lines.len() + p.windows.len() * 3 + 6 {
            right_lines.push(Line::from(Span::styled(
                "WINDOW DETAIL",
                Style::default().fg(BONE).add_modifier(Modifier::BOLD),
            )));
            let big_gauge_w = rw.saturating_sub(14).clamp(12, 48);
            for w in &p.windows {
                right_lines.push(Line::from(vec![
                    Span::styled(
                        format!("  {:<19}", truncate(&w.label, 18)),
                        Style::default().fg(ASH),
                    ),
                    Span::styled(
                        format!("{:>3}% · resets {} · {}", w.used, w.reset, w.pace),
                        Style::default().fg(if w.used > 80 { SIGNAL } else { SMOKE }),
                    ),
                ]));
                let filled = ((w.used as usize) * big_gauge_w / 100).min(big_gauge_w);
                right_lines.push(Line::from(vec![
                    Span::styled("  ", Style::default()),
                    Span::styled(
                        "█".repeat(filled),
                        Style::default().fg(if w.used > 80 {
                            SIGNAL
                        } else if w.used > 50 {
                            PHOSPHOR
                        } else {
                            SMOKE
                        }),
                    ),
                    Span::styled(
                        "─".repeat(big_gauge_w.saturating_sub(filled)),
                        Style::default().fg(HAIR),
                    ),
                ]));
                right_lines.push(Line::from(""));
            }
        }

        if let Some(status) = &p.status {
            right_lines.push(Line::from(Span::styled(
                "ADAPTIVE FLEET STATUS",
                Style::default().fg(BONE).add_modifier(Modifier::BOLD),
            )));
            right_lines.push(Line::from(Span::styled(
                format!("  {status}"),
                Style::default().fg(SMOKE),
            )));
            right_lines.push(Line::from(""));
        }

        let tail = vec![
            Line::from(Span::styled(
                "POLICY CONTROL",
                Style::default().fg(SIGNAL).add_modifier(Modifier::BOLD),
            )),
            Line::from(vec![
                Span::styled("  › ", Style::default().fg(SIGNAL)),
                Span::styled(
                    format!("Budget policy controls for {} are not wired here", p.id),
                    Style::default().fg(ASH),
                ),
            ]),
        ];
        anchor_bottom(&mut right_lines, tail, rh);

        frame.render_widget(Paragraph::new(right_lines), right_area);
    }
}

/// TAKE 7 · HARVEST (Living Orchard Churn Wall & File Yields)
fn draw_take_harvest(frame: &mut Frame, app: &App, area: Rect) {
    let trees = app.harvest_trees();
    if trees.is_empty() {
        draw_gap_state(
            frame,
            area,
            "No file churn in the window.",
            "Harvest shows files the fleet actually touched. No session has reported an edit yet.",
        );
        return;
    }

    let chunks = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(55), Constraint::Percentage(45)])
        .split(area);

    let left_area = chunks[0];
    let right_area = chunks[1];

    let selected_item = app.selected_harvest_item();

    let max_visible_lines = (left_area.height as usize).saturating_sub(2);
    let mut all_rows: Vec<(usize, Line)> = Vec::new();

    // Path column and churn bars stretch with the pane instead of pinning at 34 chars.
    let lw = left_area.width as usize;
    // Row budget: indent + path + diff column + bars + meta, with a gutter so
    // nothing ever runs into the pane edge.
    const META_W: usize = 20;
    const DIFF_W: usize = 13;
    const BAR_W: usize = 8;
    let path_w = lw
        .saturating_sub(5 + DIFF_W + META_W + BAR_W + 2)
        .clamp(14, 60);
    let bar_cap = lw
        .saturating_sub(path_w + 5 + DIFF_W + META_W + 2)
        .clamp(0, 24);
    let max_churn = trees
        .iter()
        .flat_map(|t| t.files.iter().map(|f| f.adds.max(f.dels)))
        .max()
        .unwrap_or(1)
        .max(1);
    // Blank row between working trees when everything fits with room to spare.
    let total_rows: usize = trees.iter().map(|t| 1 + t.files.len()).sum();
    let airy = max_visible_lines >= total_rows + trees.len() + 2;

    let mut flat_idx = 0;
    for t in &trees {
        let is_tree_sel = flat_idx == app.harvest_cursor;
        let tree_mark = if is_tree_sel { "▸" } else { " " };
        let tree_style = if is_tree_sel {
            Style::default().fg(BONE).add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(SMOKE)
        };

        let mut tree_line = Line::from(vec![
            Span::styled(
                format!("{tree_mark} "),
                Style::default().fg(if is_tree_sel { PHOSPHOR } else { ASH }),
            ),
            Span::styled(format!("{} ", t.handle), tree_style),
            Span::styled(format!("({})", t.project), Style::default().fg(ASH)),
            Span::styled(
                format!(" · {} events · {}", t.turns, t.source),
                Style::default().fg(ASH),
            ),
        ]);
        if is_tree_sel {
            tree_line = tree_line.style(Style::default().bg(HEARTH));
        }
        all_rows.push((flat_idx, tree_line));
        flat_idx += 1;

        for f in &t.files {
            let is_file_sel = flat_idx == app.harvest_cursor;
            let f_mark = if is_file_sel { "▸" } else { " " };

            let meta = format!(
                " · {} touch{} · {}",
                f.touches,
                if f.touches == 1 { "" } else { "es" },
                f.age
            );

            let mut file_spans = Vec::new();
            file_spans.push(Span::styled(
                format!("   {f_mark} "),
                Style::default().fg(if is_file_sel { PHOSPHOR } else { ASH }),
            ));
            file_spans.push(Span::styled(
                pad_right(&truncate_path(&f.path, path_w), path_w + 1),
                if is_file_sel {
                    Style::default().fg(BONE).add_modifier(Modifier::BOLD)
                } else {
                    Style::default().fg(SMOKE)
                },
            ));
            if f.state == FileState::Changed {
                file_spans.push(Span::styled(
                    format!("+{:<6}", f.adds),
                    Style::default().fg(PHOSPHOR),
                ));
                file_spans.push(Span::styled(
                    format!("−{:<7}", f.dels),
                    Style::default().fg(ASH),
                ));
                // Bars take the slack the meta column leaves, scaled to the
                // biggest real diff on screen so rows stay comparable.
                let used: usize = file_spans.iter().map(|s| s.content.chars().count()).sum();
                let room = lw.saturating_sub(used + META_W + 1).min(bar_cap);
                if room >= 2 {
                    let adds_cells = scale_bar(f.adds, max_churn, room * 2 / 3);
                    let dels_cells = scale_bar(f.dels, max_churn, room - adds_cells);
                    file_spans.push(Span::styled(
                        pad_right(
                            &format!("{}{}", "■".repeat(adds_cells), "─".repeat(dels_cells)),
                            room,
                        ),
                        Style::default().fg(PHOSPHOR),
                    ));
                }
            } else {
                file_spans.push(Span::styled(
                    pad_right(file_state_label(f.state), DIFF_W),
                    Style::default().fg(ASH),
                ));
            }
            file_spans.push(Span::styled(
                pad_right(&truncate(&meta, META_W), META_W),
                Style::default().fg(ASH),
            ));

            let mut file_line = Line::from(file_spans);
            if is_file_sel {
                file_line = file_line.style(Style::default().bg(HEARTH));
            }
            all_rows.push((flat_idx, file_line));
            flat_idx += 1;
        }

        if airy {
            all_rows.push((usize::MAX, Line::from("")));
        }
    }

    let sel_pos = all_rows
        .iter()
        .position(|(idx, _)| *idx == app.harvest_cursor)
        .unwrap_or(0);
    let start_pos = if sel_pos >= max_visible_lines {
        sel_pos.saturating_sub(max_visible_lines - 1)
    } else {
        0
    };

    let mut left_lines = Vec::new();
    for (_, line) in all_rows.into_iter().skip(start_pos).take(max_visible_lines) {
        left_lines.push(line);
    }

    frame.render_widget(Paragraph::new(left_lines), left_area);

    // Right: Harvest Inspection / File Diff Card
    if let Some((t, maybe_file)) = selected_item {
        let mut right_lines = Vec::new();

        if let Some(f) = maybe_file {
            right_lines.push(Line::from(vec![
                Span::styled(
                    "FILE HARVEST CHURN",
                    Style::default().fg(BONE).add_modifier(Modifier::BOLD),
                ),
                Span::styled(format!(" · {}", f.age), Style::default().fg(ASH)),
            ]));
            right_lines.push(Line::from(""));

            right_lines.push(Line::from(vec![
                Span::styled("Path:       ", Style::default().fg(ASH)),
                Span::styled(f.path.clone(), Style::default().fg(BONE)),
            ]));
            right_lines.push(Line::from(vec![
                Span::styled("Touched By: ", Style::default().fg(ASH)),
                Span::styled(
                    format!("{} ({})", t.handle, t.source),
                    Style::default().fg(SMOKE),
                ),
            ]));
            right_lines.push(Line::from(vec![
                Span::styled("Diff:       ", Style::default().fg(ASH)),
                Span::styled(
                    if f.state == FileState::Changed {
                        format!("+{} −{} against HEAD", f.adds, f.dels)
                    } else {
                        file_state_label(f.state).to_string()
                    },
                    Style::default().fg(if f.state == FileState::Changed {
                        PHOSPHOR
                    } else {
                        ASH
                    }),
                ),
            ]));
            right_lines.push(Line::from(vec![
                Span::styled("Touched:    ", Style::default().fg(ASH)),
                Span::styled(
                    format!(
                        "{} time{} by this session · last {}",
                        f.touches,
                        if f.touches == 1 { "" } else { "s" },
                        f.age
                    ),
                    Style::default().fg(SMOKE),
                ),
            ]));
            right_lines.push(Line::from(""));

            right_lines.push(Line::from(Span::styled(
                "RECENT INTENT / COMMIT THOUGHT",
                Style::default().fg(BONE).add_modifier(Modifier::BOLD),
            )));
            right_lines.push(Line::from(Span::styled(
                format!("  \"{}\"", t.last),
                Style::default().fg(SMOKE),
            )));
            right_lines.push(Line::from(""));

            let tail = vec![
                Line::from(Span::styled(
                    "RESPONSE CONTROL",
                    Style::default().fg(SIGNAL).add_modifier(Modifier::BOLD),
                )),
                Line::from(vec![
                    Span::styled("  › ", Style::default().fg(SIGNAL)),
                    Span::styled(
                        format!(
                            "Sending is unavailable · inspect {} on {}",
                            t.handle, f.path
                        ),
                        Style::default().fg(ASH),
                    ),
                ]),
            ];
            anchor_bottom(&mut right_lines, tail, right_area.height as usize);
        } else {
            right_lines.push(Line::from(vec![
                Span::styled(
                    letterspace(&t.handle.to_uppercase()),
                    Style::default().fg(BONE).add_modifier(Modifier::BOLD),
                ),
                Span::styled("  ", Style::default()),
                Span::styled(
                    format!("PROJECT {}", t.project),
                    Style::default().fg(PHOSPHOR),
                ),
            ]));
            right_lines.push(Line::from(""));

            right_lines.push(Line::from(vec![
                Span::styled("Last Action: ", Style::default().fg(ASH)),
                Span::styled(t.last.clone(), Style::default().fg(BONE)),
            ]));
            right_lines.push(Line::from(vec![
                Span::styled("Touched:     ", Style::default().fg(ASH)),
                Span::styled(
                    format!(
                        "{} file{} in the working tree",
                        t.files.len(),
                        if t.files.len() == 1 { "" } else { "s" }
                    ),
                    Style::default().fg(SMOKE),
                ),
            ]));
            let tree_adds: usize = t.files.iter().map(|f| f.adds).sum();
            let tree_dels: usize = t.files.iter().map(|f| f.dels).sum();
            right_lines.push(Line::from(vec![
                Span::styled("Churn:       ", Style::default().fg(ASH)),
                Span::styled(
                    if tree_adds == 0 && tree_dels == 0 {
                        "no diff against HEAD".to_string()
                    } else {
                        format!("+{tree_adds} −{tree_dels} in those files")
                    },
                    Style::default().fg(if tree_adds + tree_dels > 0 {
                        PHOSPHOR
                    } else {
                        ASH
                    }),
                ),
            ]));
            right_lines.push(Line::from(Span::styled(
                "             git counts the whole file, not one session's share",
                Style::default().fg(ASH),
            )));
            right_lines.push(Line::from(""));

            // The tree's file yield, largest churn first, as far as the pane allows.
            let rw = right_area.width as usize;
            let rh = right_area.height as usize;
            let list_room = rh.saturating_sub(right_lines.len() + 4);
            if list_room >= 2 {
                right_lines.push(Line::from(Span::styled(
                    "FILES TOUCHED",
                    Style::default().fg(BONE).add_modifier(Modifier::BOLD),
                )));
                for f in t.files.iter().take(list_room.saturating_sub(1)) {
                    right_lines.push(Line::from(vec![
                        Span::styled(
                            format!("  {} ", if f.fresh { "●" } else { "·" }),
                            Style::default().fg(if f.fresh { PHOSPHOR } else { HAIR }),
                        ),
                        Span::styled(
                            {
                                let cell = rw.saturating_sub(24).clamp(16, 64);
                                pad_right(&truncate_path(&f.path, cell), cell + 1)
                            },
                            Style::default().fg(SMOKE),
                        ),
                        if f.state == FileState::Changed {
                            Span::styled(
                                format!("+{:<6}−{:<5}", f.adds, f.dels),
                                Style::default().fg(PHOSPHOR),
                            )
                        } else {
                            Span::styled(
                                file_state_label(f.state).to_string(),
                                Style::default().fg(ASH),
                            )
                        },
                    ]));
                }
            }

            let tail = vec![Line::from(vec![
                Span::styled("  › ", Style::default().fg(SIGNAL)),
                Span::styled(
                    format!("Sending is unavailable · [j/k] walk {}'s yield", t.handle),
                    Style::default().fg(ASH),
                ),
            ])];
            anchor_bottom(&mut right_lines, tail, rh);
        }

        frame.render_widget(Paragraph::new(right_lines), right_area);
    }
}

/// TAKE 8 · GRID (Modular Compositions & Slot Architecture)
fn draw_take_grid(
    frame: &mut Frame,
    app: &App,
    area: Rect,
    agents: &[Agent],
    selected: Option<&Agent>,
) {
    let composition = app.composition;
    let modules = composition.modules();
    // Rectangle order must match `Composition::slot_grid` so hjkl lands on
    // the neighbor the operator can see.
    let slot_rects = match composition {
        Composition::Focus => {
            let cols = Layout::default()
                .direction(Direction::Horizontal)
                .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
                .split(area);
            let left = Layout::default()
                .direction(Direction::Vertical)
                .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
                .split(cols[0]);
            let right = Layout::default()
                .direction(Direction::Vertical)
                .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
                .split(cols[1]);
            vec![left[0], left[1], right[0], right[1]]
        }
        Composition::Watch => {
            let rows = Layout::default()
                .direction(Direction::Vertical)
                .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
                .split(area);
            let top = Layout::default()
                .direction(Direction::Horizontal)
                .constraints([
                    Constraint::Percentage(33),
                    Constraint::Percentage(33),
                    Constraint::Percentage(34),
                ])
                .split(rows[0]);
            let bot = Layout::default()
                .direction(Direction::Horizontal)
                .constraints([
                    Constraint::Percentage(33),
                    Constraint::Percentage(33),
                    Constraint::Percentage(34),
                ])
                .split(rows[1]);
            vec![top[0], top[1], top[2], bot[0], bot[1], bot[2]]
        }
        Composition::Review => {
            let cols = Layout::default()
                .direction(Direction::Horizontal)
                .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
                .split(area);
            let left = Layout::default()
                .direction(Direction::Vertical)
                .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
                .split(cols[0]);
            let right = Layout::default()
                .direction(Direction::Vertical)
                .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
                .split(cols[1]);
            vec![left[0], left[1], right[0], right[1]]
        }
        Composition::Quad => {
            let rows = Layout::default()
                .direction(Direction::Vertical)
                .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
                .split(area);
            let top = Layout::default()
                .direction(Direction::Horizontal)
                .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
                .split(rows[0]);
            let bot = Layout::default()
                .direction(Direction::Horizontal)
                .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
                .split(rows[1]);
            vec![top[0], top[1], bot[0], bot[1]]
        }
    };

    for (i, &module) in modules.iter().enumerate() {
        if i >= slot_rects.len() {
            break;
        }
        let slot_area = slot_rects[i];
        draw_slot_panel(frame, app, slot_area, module, i + 1, agents, selected);
    }
}

fn draw_slot_panel(
    frame: &mut Frame,
    app: &App,
    area: Rect,
    module: ModuleKind,
    slot_num: usize,
    agents: &[Agent],
    selected: Option<&Agent>,
) {
    let focused_idx = app
        .focused_slot
        .min(app.composition.modules().len().saturating_sub(1));
    let is_focused = slot_num.saturating_sub(1) == focused_idx;
    let block = if is_focused {
        Block::default().style(Style::default().bg(HEARTH))
    } else {
        Block::default().style(Style::default().bg(GROUND))
    };
    frame.render_widget(block, area);

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1), // Header
            Constraint::Min(2),    // Content
        ])
        .split(area);

    let header_area = chunks[0];
    let content_area = chunks[1];

    let header_style = if is_focused {
        Style::default().fg(BONE).add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(ASH)
    };

    let header_line = Line::from(vec![
        Span::styled(
            format!(" {slot_num} "),
            Style::default().fg(if is_focused { PHOSPHOR } else { ASH }),
        ),
        Span::styled(format!("{:<14}", module.label()), header_style),
        Span::styled(format!(" · {}", module.job()), Style::default().fg(ASH)),
    ]);
    frame.render_widget(Paragraph::new(header_line), header_area);

    match module {
        ModuleKind::Current => draw_module_current(frame, app, content_area, selected),
        ModuleKind::Threads => draw_module_threads(frame, app, content_area),
        ModuleKind::Motion => draw_module_motion(frame, app, content_area, agents),
        ModuleKind::Runtime => draw_module_runtime(frame, app, content_area),
        ModuleKind::Usage => draw_module_usage(frame, app, content_area),
        ModuleKind::Since => draw_module_since(frame, app, content_area),
        ModuleKind::Compare => draw_module_compare(frame, app, content_area, selected),
        ModuleKind::Harvest => draw_module_harvest(frame, app, content_area),
        ModuleKind::Horizon => draw_module_horizon(frame, app, content_area, agents),
    }
}

fn draw_module_current(frame: &mut Frame, _app: &App, area: Rect, selected: Option<&Agent>) {
    if let Some(agent) = selected {
        let mut lines = Vec::new();
        lines.push(Line::from(vec![
            Span::styled(" ", Style::default()),
            Span::styled(
                agent.handle.clone(),
                Style::default().fg(BONE).add_modifier(Modifier::BOLD),
            ),
            Span::styled(format!(" ({})", agent.project), Style::default().fg(ASH)),
            Span::styled(format!(" · {}", agent.age), Style::default().fg(ASH)),
        ]));
        lines.push(Line::from(vec![
            Span::styled("   doing: ", Style::default().fg(ASH)),
            Span::styled(
                truncate(&agent.doing, area.width.saturating_sub(12) as usize),
                Style::default().fg(SMOKE),
            ),
        ]));
        if let Some(ask) = &agent.ask {
            lines.push(Line::from(vec![
                Span::styled("   needs: ", Style::default().fg(SIGNAL)),
                Span::styled(
                    truncate(ask, area.width.saturating_sub(12) as usize),
                    Style::default().fg(SIGNAL),
                ),
            ]));
        } else {
            lines.push(Line::from(vec![
                Span::styled("   thought: ", Style::default().fg(ASH)),
                Span::styled(
                    truncate(&agent.thought, area.width.saturating_sub(14) as usize),
                    Style::default().fg(SMOKE),
                ),
            ]));
        }
        frame.render_widget(Paragraph::new(lines), area);
    } else {
        let msg = Line::from(Span::styled(
            " No active agent in hand",
            Style::default().fg(ASH),
        ));
        frame.render_widget(Paragraph::new(msg), area);
    }
}

fn draw_module_threads(frame: &mut Frame, app: &App, area: Rect) {
    let threads = app.conversation_threads();
    let mut lines = Vec::new();
    let w = area.width as usize;
    let track_w = w.saturating_sub(26).max(8);

    if threads.is_empty() {
        lines.push(module_gap_line(
            "no conversations in the window".to_string(),
        ));
    }
    for t in threads.iter().take(area.height as usize) {
        let mark = match t.state {
            "live" => "●",
            "quiet" => "○",
            _ => "·",
        };
        let color = match t.state {
            "live" => PHOSPHOR,
            "quiet" => SMOKE,
            _ => ASH,
        };

        // Render segment track
        let mut track_chars = vec!['─'; track_w];
        for seg in &t.segments {
            let start = ((seg.start as usize * track_w) / 100).min(track_w.saturating_sub(1));
            let len = ((seg.width as usize * track_w) / 100).max(1);
            let end = (start + len).min(track_w);
            let segment_char = if seg.kind == "active" { '■' } else { '┄' };
            for cell in track_chars.iter_mut().take(end).skip(start) {
                *cell = segment_char;
            }
        }
        if let Some(sp) = t.splice {
            let sp_idx = ((sp as usize * track_w) / 100).min(track_w.saturating_sub(1));
            track_chars[sp_idx] = '×';
        }
        let track_str: String = track_chars.into_iter().collect();

        lines.push(Line::from(vec![
            Span::styled(format!(" {mark} "), Style::default().fg(color)),
            Span::styled(
                format!("{:<13}", truncate(&t.handle, 12)),
                Style::default().fg(BONE),
            ),
            Span::styled(
                track_str,
                Style::default().fg(if t.state == "live" { PHOSPHOR } else { HAIR }),
            ),
            Span::styled(format!(" {:>3}", t.age), Style::default().fg(ASH)),
        ]));
    }
    frame.render_widget(Paragraph::new(lines), area);
}

fn draw_module_motion(frame: &mut Frame, _app: &App, area: Rect, agents: &[Agent]) {
    let mut lines = Vec::new();
    let w = (area.width as usize).saturating_sub(18);
    for a in agents.iter().take(area.height as usize) {
        let mut track_chars = vec!['·'; w];
        for &t in &a.ticks {
            let pos = ((t * (w as f32)) as usize).min(w.saturating_sub(1));
            track_chars[pos] = '■';
        }
        let track: String = track_chars.into_iter().collect();
        lines.push(Line::from(vec![
            Span::styled(
                format!(" {:<13}", truncate(&a.handle, 12)),
                Style::default().fg(BONE),
            ),
            Span::styled(
                track,
                Style::default().fg(if a.live { PHOSPHOR } else { HAIR }),
            ),
            Span::styled(format!(" {:>3}", a.age), Style::default().fg(ASH)),
        ]));
    }
    frame.render_widget(Paragraph::new(lines), area);
}

fn draw_module_runtime(frame: &mut Frame, app: &App, area: Rect) {
    let mut lines = Vec::new();
    if app.machines.is_empty() {
        lines.push(module_gap_line(
            app.machines_error
                .clone()
                .unwrap_or_else(|| "reading the tailnet…".to_string()),
        ));
    }
    for m in app.machines.iter().take(area.height as usize) {
        lines.push(Line::from(vec![
            Span::styled(
                format!(" {} ", if m.scout.is_some() { "◆" } else { "·" }),
                Style::default().fg(if m.online { PHOSPHOR } else { HAIR }),
            ),
            Span::styled(
                format!("{:<12}", truncate(&m.name, 11)),
                Style::default().fg(BONE),
            ),
            Span::styled(
                format!(
                    "{:<8}",
                    truncate(if m.os.is_empty() { "—" } else { &m.os }, 7)
                ),
                Style::default().fg(SMOKE),
            ),
            Span::styled(
                truncate(&m.link, area.width.saturating_sub(26) as usize),
                Style::default().fg(ASH),
            ),
        ]));
    }
    frame.render_widget(Paragraph::new(lines), area);
}

/// One dim line naming what is missing — modules never invent filler rows.
fn module_gap_line(text: String) -> Line<'static> {
    Line::from(Span::styled(format!(" {text}"), Style::default().fg(ASH)))
}

fn draw_module_usage(frame: &mut Frame, app: &App, area: Rect) {
    let plans = app.plans();
    let mut lines = Vec::new();
    if let Some((headline, detail)) = quota_gap(app) {
        lines.push(module_gap_line(headline.to_ascii_lowercase()));
        if area.height > 1 {
            lines.push(module_gap_line(detail));
        }
    }
    for p in plans.iter().take(area.height as usize) {
        if let Some(w) = p.windows.first() {
            let bar = "■".repeat((w.used as usize / 10).min(10));
            lines.push(Line::from(vec![
                Span::styled(" ", Style::default()),
                Span::styled(
                    format!("{:<13}", truncate(&p.name, 12)),
                    Style::default().fg(BONE),
                ),
                Span::styled(format!("{:<10}", bar), Style::default().fg(PHOSPHOR)),
                Span::styled(format!("{:>3}% ", w.used), Style::default().fg(BONE)),
                Span::styled(format!("· {}", w.reset), Style::default().fg(ASH)),
            ]));
        }
    }
    frame.render_widget(Paragraph::new(lines), area);
}

fn draw_module_since(frame: &mut Frame, app: &App, area: Rect) {
    let records = app.since_records();
    let mut lines = Vec::new();
    if records.is_empty() {
        lines.push(module_gap_line(
            "nothing landed while you were away".to_string(),
        ));
    }
    for r in records.iter().take(area.height as usize) {
        lines.push(Line::from(vec![
            Span::styled(format!(" {} ", r.time), Style::default().fg(ASH)),
            Span::styled(
                format!("{} ", if r.kind == "new" { "+" } else { "·" }),
                Style::default().fg(if r.kind == "new" { PHOSPHOR } else { HAIR }),
            ),
            Span::styled(
                format!("{:<14}", truncate(&r.actor, 13)),
                Style::default().fg(BONE),
            ),
            Span::styled(
                truncate(&r.change, area.width.saturating_sub(32) as usize),
                Style::default().fg(SMOKE),
            ),
            Span::styled(
                if r.repeats > 1 {
                    format!(" ×{}", r.repeats)
                } else {
                    String::new()
                },
                Style::default().fg(ASH),
            ),
        ]));
    }
    frame.render_widget(Paragraph::new(lines), area);
}

fn draw_module_compare(frame: &mut Frame, app: &App, area: Rect, selected: Option<&Agent>) {
    let peer = app.selected_peer();
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
        .split(area);

    if let Some(a) = selected {
        let mut lines = Vec::new();
        lines.push(Line::from(Span::styled(
            format!(" {}", a.handle),
            Style::default().fg(BONE).add_modifier(Modifier::BOLD),
        )));
        lines.push(Line::from(Span::styled(
            format!(
                " {}",
                truncate(&a.doing, cols[0].width.saturating_sub(2) as usize)
            ),
            Style::default().fg(SMOKE),
        )));
        frame.render_widget(Paragraph::new(lines), cols[0]);
    }
    if let Some(p) = peer {
        let mut lines = Vec::new();
        lines.push(Line::from(Span::styled(
            format!(" {}", p.handle),
            Style::default().fg(BONE).add_modifier(Modifier::BOLD),
        )));
        lines.push(Line::from(Span::styled(
            format!(
                " {}",
                truncate(&p.doing, cols[1].width.saturating_sub(2) as usize)
            ),
            Style::default().fg(SMOKE),
        )));
        frame.render_widget(Paragraph::new(lines), cols[1]);
    }
}

fn draw_module_harvest(frame: &mut Frame, app: &App, area: Rect) {
    let trees = app.harvest_trees();
    let mut lines = Vec::new();
    for t in trees.iter().take(area.height as usize) {
        let total_adds: usize = t.files.iter().map(|f| f.adds).sum();
        let total_dels: usize = t.files.iter().map(|f| f.dels).sum();
        lines.push(Line::from(vec![
            Span::styled(" ", Style::default()),
            Span::styled(
                format!("{:<13}", truncate(&t.handle, 12)),
                Style::default().fg(BONE),
            ),
            Span::styled(
                if total_adds == 0 && total_dels == 0 {
                    "no diff ".to_string()
                } else {
                    format!("+{total_adds} -{total_dels} ")
                },
                Style::default().fg(if total_adds + total_dels > 0 {
                    PHOSPHOR
                } else {
                    ASH
                }),
            ),
            Span::styled(
                format!(
                    "· {} file{}",
                    t.files.len(),
                    if t.files.len() == 1 { "" } else { "s" }
                ),
                Style::default().fg(ASH),
            ),
        ]));
    }
    frame.render_widget(Paragraph::new(lines), area);
}

fn draw_module_horizon(frame: &mut Frame, _app: &App, area: Rect, agents: &[Agent]) {
    let mut lines = Vec::new();
    let w = (area.width as usize).saturating_sub(16);
    for a in agents.iter().take(area.height as usize) {
        let mut track_chars = vec!['·'; w];
        for &t in &a.ticks {
            let pos = ((t * (w as f32)) as usize).min(w.saturating_sub(1));
            track_chars[pos] = '■';
        }
        let track: String = track_chars.into_iter().collect();
        lines.push(Line::from(vec![
            Span::styled(
                format!(" {:<11}", truncate(&a.handle, 10)),
                Style::default().fg(BONE),
            ),
            Span::styled(track, Style::default().fg(PHOSPHOR)),
        ]));
    }
    frame.render_widget(Paragraph::new(lines), area);
}

fn draw_hero_card(frame: &mut Frame, agent: &Agent, area: Rect) {
    let w = area.width as usize;
    let h = area.height as usize;
    let mut lines = Vec::new();

    let mut mast_spans = Vec::new();
    mast_spans.push(Span::styled(
        letterspace(&agent.handle.to_uppercase()),
        Style::default().fg(BONE).add_modifier(Modifier::BOLD),
    ));
    mast_spans.push(Span::styled("   ", Style::default()));
    mast_spans.push(Span::styled(
        format!("PROJECT {}", agent.project),
        Style::default().fg(PHOSPHOR),
    ));
    mast_spans.push(Span::styled(
        format!(" · ON {}", agent.host),
        Style::default().fg(ASH),
    ));
    lines.push(Line::from(mast_spans));
    lines.push(Line::from(""));

    // Taller heroes earn wrapped prose instead of one clipped line.
    let doing_rows = if h >= 12 {
        3
    } else if h >= 8 {
        2
    } else {
        1
    };
    for (i, row) in wrap_text(&agent.doing, w.saturating_sub(7), doing_rows)
        .into_iter()
        .enumerate()
    {
        let prefix = if i == 0 { "Doing: " } else { "       " };
        lines.push(Line::from(vec![
            Span::styled(prefix, Style::default().fg(ASH)),
            Span::styled(row, Style::default().fg(BONE)),
        ]));
    }

    let quote_rows = if h >= 12 { 2 } else { 1 };
    if let Some(ask) = &agent.ask {
        for (i, row) in wrap_text(ask, w.saturating_sub(7), quote_rows)
            .into_iter()
            .enumerate()
        {
            let prefix = if i == 0 { "Needs: " } else { "       " };
            lines.push(Line::from(vec![
                Span::styled(prefix, Style::default().fg(SIGNAL)),
                Span::styled(
                    row,
                    Style::default().fg(SIGNAL).add_modifier(Modifier::BOLD),
                ),
            ]));
        }
    } else {
        for (i, row) in wrap_text(&agent.thought, w.saturating_sub(9), quote_rows)
            .into_iter()
            .enumerate()
        {
            let prefix = if i == 0 { "Thought: " } else { "         " };
            lines.push(Line::from(vec![
                Span::styled(prefix, Style::default().fg(ASH)),
                Span::styled(row, Style::default().fg(SMOKE)),
            ]));
        }
    }

    if h >= lines.len() + 2 && h >= 8 {
        lines.push(Line::from(""));
        lines.push(Line::from(vec![
            Span::styled(
                if agent.live { "● live" } else { "○ quiet" },
                Style::default().fg(if agent.live { PHOSPHOR } else { SMOKE }),
            ),
            Span::styled(format!(" · last {}", agent.age), Style::default().fg(ASH)),
            Span::styled(
                format!(" · [{}]", agent.harness),
                Style::default().fg(PHOSPHOR),
            ),
        ]));
    }

    // 60-second activity strip on tall terminals.
    if h >= lines.len() + 3 && h >= 10 {
        lines.push(Line::from(""));
        let track_w = w.saturating_sub(2).max(8);
        lines.push(Line::from(vec![
            Span::styled("ACTIVITY", Style::default().fg(ASH)),
            Span::styled(
                format!("{:>pad$}", "-60s ─ now", pad = track_w.saturating_sub(8)),
                Style::default().fg(HAIR),
            ),
        ]));
        let mut track_chars = vec!['·'; track_w];
        for &t in &agent.ticks {
            let pos = ((t * (track_w as f32)) as usize).min(track_w.saturating_sub(1));
            track_chars[pos] = if agent.live && pos >= track_w.saturating_sub(2) {
                '█'
            } else {
                '■'
            };
        }
        let mut track_spans = Vec::new();
        for (idx, ch) in track_chars.into_iter().enumerate() {
            if ch == '·' {
                track_spans.push(Span::styled("·", Style::default().fg(HAIR)));
            } else if agent.live && idx >= track_w.saturating_sub(3) {
                track_spans.push(Span::styled(
                    ch.to_string(),
                    Style::default().fg(PHOSPHOR).add_modifier(Modifier::BOLD),
                ));
            } else {
                track_spans.push(Span::styled(
                    ch.to_string(),
                    Style::default().fg(if agent.live { PHOSPHOR } else { SMOKE }),
                ));
            }
        }
        lines.push(Line::from(track_spans));
    }

    frame.render_widget(Paragraph::new(lines), area);
}

fn draw_floor_plan_chips(frame: &mut Frame, app: &App, agents: &[Agent], area: Rect) {
    let w = area.width as usize;
    let h = area.height as usize;
    let mut lines = Vec::new();
    lines.push(Line::from(vec![
        Span::styled("FLEET FLOOR PLAN", Style::default().fg(ASH)),
        Span::styled(
            format!(
                " · {} session{}",
                agents.len(),
                if agents.len() == 1 { "" } else { "s" }
            ),
            Style::default().fg(HAIR),
        ),
    ]));

    // Chip cells scale with the pane: wide panes carry the age, tall panes more rows.
    let wide_chips = w >= 52;
    let cell_w = if wide_chips { 17 } else { 11 };
    let per_row = (w / cell_w).max(1);
    let max_rows = h.saturating_sub(1).max(1);
    let capacity = per_row * max_rows;

    let mut chip_spans = Vec::new();
    let shown = agents.len().min(capacity);
    for (i, a) in agents.iter().take(shown).enumerate() {
        let is_sel = app.cursor == i;
        let mark = if is_sel { "▸" } else { " " };
        let style = if is_sel {
            Style::default()
                .fg(BONE)
                .bg(HEARTH)
                .add_modifier(Modifier::BOLD)
        } else if a.needs {
            Style::default().fg(SIGNAL)
        } else if a.live {
            Style::default().fg(PHOSPHOR)
        } else {
            Style::default().fg(SMOKE)
        };

        let label = if wide_chips {
            format!("{mark}{:<9} {:>4}  ", truncate(&a.handle, 9), a.age)
        } else {
            format!("{mark}{:<9} ", truncate(&a.handle, 9))
        };
        chip_spans.push(Span::styled(label, style));
        if chip_spans.len() >= per_row {
            lines.push(Line::from(chip_spans.clone()));
            chip_spans.clear();
        }
    }
    if !chip_spans.is_empty() {
        lines.push(Line::from(chip_spans));
    }
    if agents.len() > shown {
        lines.push(Line::from(Span::styled(
            format!(" +{} more · [j/k] to reach them", agents.len() - shown),
            Style::default().fg(ASH),
        )));
    }

    frame.render_widget(Paragraph::new(lines), area);
}

fn draw_also_moving_side(frame: &mut Frame, agents: &[Agent], cur_id: &str, area: Rect) {
    let w = area.width as usize;
    let h = area.height as usize;
    let mut lines = Vec::new();

    // "Moving" means moved recently. Everything older belongs to the floor plan,
    // where the age column tells the truth about it.
    let now = now_ms();
    let recent: Vec<&Agent> = agents
        .iter()
        .filter(|a| a.id != cur_id && now.saturating_sub(event_ts_ms(a.last_ts)) < 30 * 60 * 1000)
        .collect();

    lines.push(Line::from(Span::styled(
        truncate(
            &if recent.is_empty() {
                "ALSO MOVING · all quiet".to_string()
            } else {
                format!("ALSO MOVING · {}", recent.len())
            },
            w,
        ),
        Style::default().fg(ASH),
    )));

    let max_rows = h.saturating_sub(1).max(1);
    for a in recent.into_iter().take(max_rows) {
        let head_len = a.handle.chars().count() + a.age.chars().count() + 4;
        lines.push(Line::from(vec![
            Span::styled(
                format!("{} ", a.handle),
                Style::default().fg(if a.live { PHOSPHOR } else { BONE }),
            ),
            Span::styled(format!("({}) ", a.age), Style::default().fg(ASH)),
            Span::styled(
                truncate(&a.doing, w.saturating_sub(head_len)),
                Style::default().fg(SMOKE),
            ),
        ]));
    }

    frame.render_widget(Paragraph::new(lines), area);
}

fn draw_trace_stream(frame: &mut Frame, app: &App, session_id: &str, area: Rect) {
    let mut lines = Vec::new();
    let max_lines = area.height as usize;

    let matching: Vec<&Row> = app
        .events
        .iter()
        .filter(|r| r.event.session_id == session_id)
        .take(max_lines)
        .collect();

    for r in matching.iter().rev() {
        let time = format_clock(r.event.ts);
        let mut spans = Vec::new();
        spans.push(Span::styled(format!("{time}  "), Style::default().fg(ASH)));

        match r.cls {
            Class::Human => {
                spans.push(Span::styled(
                    "human   ",
                    Style::default().fg(BONE).add_modifier(Modifier::BOLD),
                ));
                spans.push(Span::styled(r.text.clone(), Style::default().fg(BONE)));
            }
            Class::Convo => {
                spans.push(Span::styled("convo   ", Style::default().fg(SMOKE)));
                spans.push(Span::styled(r.text.clone(), Style::default().fg(SMOKE)));
            }
            Class::Plan => {
                spans.push(Span::styled("plan    ", Style::default().fg(PHOSPHOR)));
                spans.push(Span::styled(r.text.clone(), Style::default().fg(PHOSPHOR)));
            }
            Class::Tool => {
                let tool_name = r.tool.as_deref().unwrap_or("tool");
                spans.push(Span::styled(
                    format!("{:<8}", tool_name),
                    Style::default().fg(ASH),
                ));
                spans.push(Span::styled(r.text.clone(), Style::default().fg(SMOKE)));
            }
            _ => {
                spans.push(Span::styled("sys     ", Style::default().fg(HAIR)));
                spans.push(Span::styled(r.text.clone(), Style::default().fg(HAIR)));
            }
        }

        lines.push(Line::from(spans));
    }

    if lines.is_empty() {
        lines.push(Line::from(Span::styled(
            " Waiting for live trace stream lines…",
            Style::default().fg(ASH),
        )));
    }

    frame.render_widget(Paragraph::new(lines), area);
}

fn draw_dock(frame: &mut Frame, app: &App, handle: &str, area: Rect) {
    let mut spans = Vec::new();
    if app.composing {
        spans.push(Span::styled("› ", Style::default().fg(SIGNAL)));
        spans.push(Span::styled(
            format!("Draft for {handle}: "),
            Style::default().fg(BONE).add_modifier(Modifier::BOLD),
        ));
        spans.push(Span::styled(app.draft.clone(), Style::default().fg(BONE)));
        spans.push(Span::styled("█", Style::default().fg(PHOSPHOR)));
    } else if let Some(notice) = &app.composer_notice {
        spans.push(Span::styled("NOT SENT · ", Style::default().fg(SIGNAL)));
        spans.push(Span::styled(notice.clone(), Style::default().fg(ASH)));
        spans.push(Span::styled(
            " · [i] edit retained draft",
            Style::default().fg(BONE),
        ));
    } else {
        spans.push(Span::styled("› ", Style::default().fg(ASH)));
        spans.push(Span::styled(
            format!("Press [i] to draft for {handle} · sending unavailable"),
            Style::default().fg(ASH),
        ));
    }
    frame.render_widget(Paragraph::new(Line::from(spans)), area);
}

fn draw_agent_detail_card(frame: &mut Frame, app: &App, agent: &Agent, area: Rect) {
    let w = area.width as usize;
    if w < 10 || area.height < 4 {
        return;
    }
    let mut lines = Vec::new();

    let handle_str = letterspace(&agent.handle.to_uppercase());
    lines.push(Line::from(vec![
        Span::styled(
            truncate(&handle_str, w.saturating_sub(18)),
            Style::default().fg(BONE).add_modifier(Modifier::BOLD),
        ),
        Span::styled("  ", Style::default()),
        Span::styled(
            truncate(&format!("PROJECT {}", agent.project), 18),
            Style::default().fg(PHOSPHOR),
        ),
    ]));
    lines.push(Line::from(""));

    lines.push(Line::from(vec![
        Span::styled("Host:    ", Style::default().fg(ASH)),
        Span::styled(
            truncate(&agent.host, w.saturating_sub(24)),
            Style::default().fg(SMOKE),
        ),
        Span::styled(
            format!(" · [{}]", agent.harness),
            Style::default().fg(PHOSPHOR),
        ),
    ]));
    lines.push(Line::from(vec![
        Span::styled("Status:  ", Style::default().fg(ASH)),
        Span::styled(
            if agent.live {
                "● live activity"
            } else {
                "○ session quiet"
            },
            Style::default().fg(if agent.live { PHOSPHOR } else { SMOKE }),
        ),
        Span::styled(
            format!(" · last seen {}", agent.age),
            Style::default().fg(ASH),
        ),
    ]));
    lines.push(Line::from(vec![
        Span::styled("Doing:   ", Style::default().fg(ASH)),
        Span::styled(
            truncate(&agent.doing, w.saturating_sub(10)),
            Style::default().fg(BONE),
        ),
    ]));
    lines.push(Line::from(""));

    lines.push(Line::from(Span::styled(
        "RECENT INTENT / THOUGHT",
        Style::default().fg(BONE).add_modifier(Modifier::BOLD),
    )));
    lines.push(Line::from(Span::styled(
        format!("  \"{}\"", truncate(&agent.thought, w.saturating_sub(6))),
        Style::default().fg(SMOKE),
    )));
    lines.push(Line::from(""));

    lines.push(Line::from(Span::styled(
        "LATEST EVENTS",
        Style::default().fg(ASH),
    )));
    let matching: Vec<&Row> = app
        .events
        .iter()
        .filter(|r| r.event.session_id == agent.id)
        .take(area.height.saturating_sub(12) as usize)
        .collect();
    for r in matching {
        lines.push(Line::from(vec![
            Span::styled(
                format!("  {} ", format_clock(r.event.ts)),
                Style::default().fg(ASH),
            ),
            Span::styled(
                truncate(&r.text, w.saturating_sub(12)),
                Style::default().fg(SMOKE),
            ),
        ]));
    }

    frame.render_widget(Paragraph::new(lines), area);
}

fn draw_footer(frame: &mut Frame, app: &App, area: Rect, selected: Option<&Agent>) {
    let mut spans = Vec::new();
    if let Some(notice) = &app.composer_notice {
        spans.push(Span::styled("NOT SENT · ", Style::default().fg(SIGNAL)));
        spans.push(Span::styled(notice.clone(), Style::default().fg(ASH)));
    } else if app.take == Take::Grid {
        let mods = app.composition.modules();
        let current_mod = mods
            .get(app.focused_slot)
            .copied()
            .unwrap_or(ModuleKind::Current);
        spans.push(Span::styled("hjkl", Style::default().fg(BONE)));
        spans.push(Span::styled(" move slot  ", Style::default().fg(ASH)));
        spans.push(Span::styled("Tab", Style::default().fg(BONE)));
        spans.push(Span::styled(" cycle  ", Style::default().fg(ASH)));
        spans.push(Span::styled("g", Style::default().fg(BONE)));
        spans.push(Span::styled(" composition  ", Style::default().fg(ASH)));
        spans.push(Span::styled("1-7", Style::default().fg(BONE)));
        spans.push(Span::styled(" takes  ", Style::default().fg(ASH)));
        spans.push(Span::styled("? ", Style::default().fg(BONE)));
        spans.push(Span::styled("help    ", Style::default().fg(ASH)));
        spans.push(Span::styled(
            format!(
                "focus: slot {} ({})",
                app.focused_slot + 1,
                current_mod.label()
            ),
            Style::default().fg(PHOSPHOR),
        ));
    } else if app.take == Take::Twin {
        spans.push(Span::styled("j/k", Style::default().fg(BONE)));
        spans.push(Span::styled(" assign agent  ", Style::default().fg(ASH)));
        spans.push(Span::styled("Tab/Shift+Tab", Style::default().fg(BONE)));
        spans.push(Span::styled(
            " cycle column focus  ",
            Style::default().fg(ASH),
        ));
        spans.push(Span::styled("1-7", Style::default().fg(BONE)));
        spans.push(Span::styled(" takes  ", Style::default().fg(ASH)));
        spans.push(Span::styled("i", Style::default().fg(BONE)));
        spans.push(Span::styled(" draft only  ", Style::default().fg(ASH)));
        spans.push(Span::styled("? ", Style::default().fg(BONE)));
        spans.push(Span::styled("help", Style::default().fg(ASH)));
    } else if app.take == Take::Mesh {
        if let Some(notice) = &app.mesh_notice {
            spans.push(Span::styled(
                "MESH · ",
                Style::default().fg(if app.mesh_busy { SIGNAL } else { PHOSPHOR }),
            ));
            spans.push(Span::styled(notice.clone(), Style::default().fg(ASH)));
        } else {
            spans.push(Span::styled("j/k", Style::default().fg(BONE)));
            spans.push(Span::styled(" select  ", Style::default().fg(ASH)));
            spans.push(Span::styled("p", Style::default().fg(BONE)));
            spans.push(Span::styled(" ping  ", Style::default().fg(ASH)));
            spans.push(Span::styled("a", Style::default().fg(BONE)));
            spans.push(Span::styled(" announce  ", Style::default().fg(ASH)));
            spans.push(Span::styled("x", Style::default().fg(BONE)));
            spans.push(Span::styled(" withdraw  ", Style::default().fg(ASH)));
            spans.push(Span::styled("r", Style::default().fg(BONE)));
            spans.push(Span::styled(" refresh  ", Style::default().fg(ASH)));
            spans.push(Span::styled("? ", Style::default().fg(BONE)));
            spans.push(Span::styled("help", Style::default().fg(ASH)));
        }
    } else if app.take == Take::Quota {
        spans.push(Span::styled("j/k", Style::default().fg(BONE)));
        spans.push(Span::styled(" select plan  ", Style::default().fg(ASH)));
        spans.push(Span::styled("1-7", Style::default().fg(BONE)));
        spans.push(Span::styled(" takes  ", Style::default().fg(ASH)));
        spans.push(Span::styled("send unavailable  ", Style::default().fg(ASH)));
        spans.push(Span::styled("? ", Style::default().fg(BONE)));
        spans.push(Span::styled("help", Style::default().fg(ASH)));
    } else if app.take == Take::Harvest {
        spans.push(Span::styled("j/k", Style::default().fg(BONE)));
        spans.push(Span::styled(
            " navigate yield/file  ",
            Style::default().fg(ASH),
        ));
        spans.push(Span::styled("1-7", Style::default().fg(BONE)));
        spans.push(Span::styled(" takes  ", Style::default().fg(ASH)));
        spans.push(Span::styled("send unavailable  ", Style::default().fg(ASH)));
        spans.push(Span::styled("? ", Style::default().fg(BONE)));
        spans.push(Span::styled("help", Style::default().fg(ASH)));
    } else {
        spans.push(Span::styled("j/k", Style::default().fg(BONE)));
        spans.push(Span::styled(" select  ", Style::default().fg(ASH)));
        spans.push(Span::styled("1-7", Style::default().fg(BONE)));
        spans.push(Span::styled(" takes  ", Style::default().fg(ASH)));
        spans.push(Span::styled("Tab", Style::default().fg(BONE)));
        spans.push(Span::styled(" cycle take  ", Style::default().fg(ASH)));
        spans.push(Span::styled("i", Style::default().fg(BONE)));
        spans.push(Span::styled(" draft only  ", Style::default().fg(ASH)));
        spans.push(Span::styled("? ", Style::default().fg(BONE)));
        spans.push(Span::styled("help    ", Style::default().fg(ASH)));

        if let Some(agent) = selected {
            spans.push(Span::styled(
                format!("selected: {}", agent.handle),
                Style::default().fg(PHOSPHOR),
            ));
        }
    }

    frame.render_widget(Paragraph::new(Line::from(spans)), area);
}

fn draw_help(frame: &mut Frame, area: Rect) {
    let takes: &[(&str, &str, &str)] = &[
        (
            "1",
            "Now",
            "Signature 3-band composition (Hero + Floor Plan + Trace)",
        ),
        (
            "2",
            "Horizon",
            "30m temporal cadence & activity tracks across fleet",
        ),
        (
            "3",
            "Twin",
            "Multi-column live stream deck (TweetDeck style)",
        ),
        (
            "4",
            "Mesh",
            "Connected machines: tailnet peers and scout mesh nodes",
        ),
        (
            "5",
            "Quota",
            "Provider fuel gauges, tier usage & reset sparklines",
        ),
        (
            "6",
            "Harvest",
            "Orchard living churn wall & git diff yields",
        ),
        (
            "7",
            "Grid",
            "Modular slot compositions (Focus, Watch, Review, Quad)",
        ),
    ];
    let controls: &[(&str, &str)] = &[
        ("j / k", "Navigate sessions / machines / harvest files"),
        (
            "h / j / k / l",
            "Move to the neighboring Grid slot, or Twin column",
        ),
        (
            "Tab",
            "Cycle takes (or wrap slot focus in Grid, column in Twin)",
        ),
        (
            "Shift+Tab",
            "Reverse slot focus in Grid or column focus in Twin",
        ),
        (
            "g",
            "Cycle Grid composition (Focus → Watch → Review → Quad)",
        ),
        (
            "p / Enter",
            "Ping the selected Mesh machine via scout mesh ping",
        ),
        (
            "a / x / r",
            "Announce, withdraw, or refresh this machine on the mesh",
        ),
        (
            "i / Enter",
            "Open local draft editor in Now or Twin (sending unavailable)",
        ),
        ("?", "Toggle this help"),
        ("q / Esc", "Quit, or fall back to Now"),
    ];

    let mut lines = Vec::new();
    lines.push(Line::from(Span::styled("TAKES", Style::default().fg(ASH))));
    for (num, name, desc) in takes {
        lines.push(Line::from(vec![
            Span::styled(format!("  {num}  "), Style::default().fg(PHOSPHOR)),
            Span::styled(
                format!("{name:<9}"),
                Style::default().fg(BONE).add_modifier(Modifier::BOLD),
            ),
            Span::styled(*desc, Style::default().fg(SMOKE)),
        ]));
    }
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        "CONTROLS",
        Style::default().fg(ASH),
    )));
    for (key, desc) in controls {
        lines.push(Line::from(vec![
            Span::styled(format!("  {key:<12}"), Style::default().fg(BONE)),
            Span::styled(*desc, Style::default().fg(SMOKE)),
        ]));
    }

    // Small terminals get the plain list; roomy ones a centered card.
    if area.width < 78 || area.height < 24 {
        let mut plain = vec![
            Line::from(Span::styled(
                "SCOUT NIGHT INSTRUMENT · SEVEN TAKES ON ONE FLEET",
                Style::default().fg(BONE).add_modifier(Modifier::BOLD),
            )),
            Line::from(""),
        ];
        plain.extend(lines);
        frame.render_widget(Paragraph::new(plain), area);
        return;
    }

    let card_w = 76u16.min(area.width.saturating_sub(4));
    let card_h = (lines.len() as u16 + 4).min(area.height.saturating_sub(2));
    let card = Rect {
        x: area.x + (area.width - card_w) / 2,
        y: area.y + (area.height - card_h) / 2,
        width: card_w,
        height: card_h,
    };

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(HAIR))
        .style(Style::default().bg(GROUND))
        .padding(Padding::new(2, 2, 1, 1))
        .title(Span::styled(
            " S c o u t · NIGHT INSTRUMENT ",
            Style::default().fg(BONE).add_modifier(Modifier::BOLD),
        ))
        .title_bottom(
            Line::from(Span::styled(
                " ? or Esc to close ",
                Style::default().fg(ASH),
            ))
            .right_aligned(),
        );
    let inner = block.inner(card);
    frame.render_widget(block, card);
    frame.render_widget(Paragraph::new(lines), inner);
}

fn draw_empty_state(frame: &mut Frame, area: Rect) {
    let mut lines = Vec::new();
    for _ in 0..(area.height / 2).saturating_sub(2) {
        lines.push(Line::from(""));
    }
    lines.push(Line::from(Span::styled("· ○ ·", Style::default().fg(HAIR))));
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        "No active sessions found.",
        Style::default().fg(BONE).add_modifier(Modifier::BOLD),
    )));
    lines.push(Line::from(Span::styled(
        "Start an agent with scout or trigger an ask flight to seed the night sky.",
        Style::default().fg(ASH),
    )));
    frame.render_widget(Paragraph::new(lines).alignment(Alignment::Center), area);
}

#[cfg(test)]
mod tests {
    use ratatui::{backend::TestBackend, Terminal};

    use super::*;
    use crate::feed::TailEvent;

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

    fn rendered_text(terminal: &Terminal<TestBackend>) -> String {
        terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect()
    }

    #[test]
    fn grid_mast_renders_at_85_columns_without_slicing_unicode() {
        let backend = TestBackend::new(85, 24);
        let mut terminal = Terminal::new(backend).expect("test terminal");
        let mut app = App::new(Take::Grid);

        terminal
            .draw(|frame| draw(frame, &mut app))
            .expect("85-column grid should render");
    }

    #[test]
    fn twin_renders_an_unassigned_slot_and_truthful_footer() {
        let backend = TestBackend::new(85, 24);
        let mut terminal = Terminal::new(backend).expect("test terminal");
        let mut app = App::new(Take::Twin);
        app.ingest_event(event(1, "session-a", 1_700_000_000_000));

        terminal
            .draw(|frame| draw(frame, &mut app))
            .expect("ordinary-width Twin should render");

        let rendered = rendered_text(&terminal);
        assert!(rendered.contains("EMPTY DECK STREAM"));
        assert!(rendered.contains("cycle column focus"));
        assert!(!rendered.contains("cycle take"));
    }

    #[test]
    fn twin_focus_clamps_when_the_terminal_shrinks() {
        let backend = TestBackend::new(160, 24);
        let mut terminal = Terminal::new(backend).expect("test terminal");
        let mut app = App::new(Take::Twin);
        for id in 0..3 {
            app.ingest_event(event(
                id,
                &format!("session-{id}"),
                1_700_000_000_000 + id as i64,
            ));
        }
        app.deck_focus = 2;

        terminal
            .draw(|frame| draw(frame, &mut app))
            .expect("wide Twin should render");
        assert_eq!(app.deck_focus, 2);

        terminal.backend_mut().resize(85, 24);
        terminal
            .draw(|frame| draw(frame, &mut app))
            .expect("resized Twin should render");
        assert_eq!(app.deck_focus, 1);

        terminal.backend_mut().resize(60, 24);
        terminal
            .draw(|frame| draw(frame, &mut app))
            .expect("narrow Twin should render");
        assert_eq!(app.deck_focus, 0);
    }
}
