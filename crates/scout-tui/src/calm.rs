//! One quiet session list: Working, Requests, Earlier, a docked composer, and
//! the opened session. Every action is a key; Esc backs out one level and never
//! quits. Legacy fleet views remain in draw.rs behind `f`.
use crate::{
    app::{
        calm_group, event_ts_ms, is_stream_marker, pad_right, plain, prompt_title, step_line,
        truncate, Agent, App,
    },
    classify::Class,
    theme::*,
};
use ratatui::{
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Clear, Paragraph},
    Frame,
};
use unicode_width::UnicodeWidthStr;

const SPIN: [char; 10] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

fn span(text: impl Into<String>, color: ratatui::style::Color) -> Span<'static> {
    Span::styled(text.into(), Style::default().fg(color))
}

fn bold(text: impl Into<String>, color: ratatui::style::Color) -> Span<'static> {
    Span::styled(
        text.into(),
        Style::default().fg(color).add_modifier(Modifier::BOLD),
    )
}

fn heading(name: &str, n: usize, width: usize) -> Line<'static> {
    Line::from(vec![
        bold(format!("{name} "), BONE),
        span(format!("{n} "), ASH),
        span(
            "─".repeat(width.saturating_sub(name.len() + n.to_string().len() + 2)),
            HAIR,
        ),
    ])
}

fn aligned(left: Vec<Span<'static>>, right: Vec<Span<'static>>, width: usize) -> Line<'static> {
    let rw: usize = right.iter().map(Span::width).sum();
    let mut l = Line::from(left);
    crate::draw::fit_line(&mut l, width.saturating_sub(rw + 1));
    l.spans
        .push(span(" ".repeat(width.saturating_sub(l.width() + rw)), ASH));
    l.spans.extend(right);
    l
}

fn short_id(a: &Agent) -> String {
    a.handle
        .rsplit('·')
        .next()
        .unwrap_or(&a.id)
        .trim()
        .to_string()
}

fn raised(line: Line<'static>) -> Line<'static> {
    line.style(Style::default().bg(HEARTH))
}

/// Word-wrap plain text to `width` columns.
pub fn wrap(text: &str, width: usize) -> Vec<String> {
    let width = width.max(8);
    let mut out = Vec::new();
    let mut line = String::new();
    for word in text.split_whitespace() {
        let next = if line.is_empty() {
            word.width()
        } else {
            line.width() + 1 + word.width()
        };
        if next > width && !line.is_empty() {
            out.push(std::mem::take(&mut line));
        }
        if !line.is_empty() {
            line.push(' ');
        }
        line.push_str(&truncate(word, width));
    }
    if !line.is_empty() {
        out.push(line);
    }
    out
}

struct Frame0 {
    x: u16,
    w: u16,
    width: usize,
    ticks: u128,
}

impl Frame0 {
    fn spin(&self, offset: u128) -> char {
        SPIN[((self.ticks / 90 + offset) % 10) as usize]
    }
}

pub fn draw_calm(frame: &mut Frame, app: &mut App, area: Rect) {
    let inset = if area.width >= 100 { 2 } else { 1 };
    let f = Frame0 {
        x: area.x + inset,
        w: area.width.saturating_sub(inset * 2),
        width: area.width.saturating_sub(inset * 2) as usize,
        ticks: app.animation_start.elapsed().as_millis(),
    };
    let agents = app.agents();
    let selected = app.selected_agent();
    let cursor_on = (f.ticks / 530).is_multiple_of(2);

    // Top line: where we are, or the filter being typed.
    let top = if app.filtering || !app.filter.is_empty() {
        let mut left = vec![span("/ ", EMBER), span(app.filter.clone(), BONE)];
        if app.filtering {
            left.push(span(if cursor_on { "█" } else { " " }, EMBER));
        }
        aligned(
            left,
            vec![span(format!("{} shown · Esc clears", agents.len()), ASH)],
            f.width,
        )
    } else {
        let live = agents.iter().filter(|a| a.live).count();
        let context = selected
            .as_ref()
            .map(|a| format!("  {} · {}", a.project, a.host))
            .unwrap_or_default();
        aligned(
            vec![bold("scout", BONE), span(context, ASH)],
            vec![
                span(
                    format!("{} sessions · ", agents.len() + app.calm_silent_count()),
                    ASH,
                ),
                span(format!("{live} live"), if live > 0 { EMBER } else { ASH }),
            ],
            f.width,
        )
    };
    frame.render_widget(Paragraph::new(top), Rect::new(f.x, area.y + 1, f.w, 1));

    let cy = area.bottom().saturating_sub(5);
    let body = Rect::new(f.x, area.y + 3, f.w, cy.saturating_sub(area.y + 4));

    match (&selected, app.calm_detail) {
        (Some(a), true) => draw_detail(frame, app, a, body, &f),
        _ => draw_list(frame, app, &agents, selected.as_ref(), body, &f),
    }

    if let Some(error) = &app.error {
        frame.render_widget(
            Paragraph::new(span(truncate(&format!("Feed: {error}"), f.width), ASH)),
            Rect::new(f.x, cy.saturating_sub(1), f.w, 1),
        );
    }
    draw_composer(frame, app, selected.as_ref(), cy, &f, cursor_on);

    let keys: &[(&str, &str)] = if app.calm_detail {
        &[
            ("Esc", "back"),
            ("a", "ask"),
            ("↑↓", "scroll"),
            ("?", "keys"),
        ]
    } else {
        &[
            ("↑↓", "move"),
            ("⏎", "open"),
            ("a", "ask"),
            ("/", "filter"),
            ("f", "fleet"),
            ("?", "keys"),
            ("⌃c", "quit"),
        ]
    };
    let mut footer = Line::from(
        keys.iter()
            .flat_map(|(k, what)| [span(format!("{k} "), BONE), span(format!("{what}   "), ASH)])
            .collect::<Vec<_>>(),
    );
    crate::draw::fit_line(&mut footer, f.width);
    frame.render_widget(
        Paragraph::new(footer),
        Rect::new(f.x, area.bottom() - 1, f.w, 1),
    );

    if app.help {
        draw_keys(frame, area);
    }
}

fn row(app: &App, a: &Agent, chosen: bool, f: &Frame0, title_w: usize) -> Line<'static> {
    let group = calm_group(a);
    let (glyph, glyph_color) = match group {
        0 => (f.spin(if chosen { 0 } else { 5 }).to_string(), EMBER),
        1 => ("◆".to_string(), SIGNAL),
        _ => ("○".to_string(), HAIR),
    };
    let title = truncate(&app.session_title(&a.id), title_w);
    let outcome = match group {
        1 => a.ask.as_deref().map(plain).unwrap_or_default(),
        _ => {
            let said = app.session_outcome(&a.id);
            if said.is_empty() && group == 0 {
                app.session_steps(&a.id).pop().unwrap_or_default()
            } else {
                said
            }
        }
    };
    let who_w = (f.width / 5).clamp(10, 22);
    let who = format!("{} · {}", a.harness, short_id(a));
    let who = if who.width() > who_w {
        a.harness.clone()
    } else {
        who
    };
    let age_color = match group {
        0 => EMBER,
        1 => SIGNAL,
        _ => ASH,
    };
    let line = aligned(
        vec![
            span(format!("{glyph} "), glyph_color),
            Span::styled(
                pad_right(&title, title_w + 2),
                Style::default().fg(BONE).add_modifier(if group == 0 {
                    Modifier::BOLD
                } else {
                    Modifier::empty()
                }),
            ),
            span(outcome, if chosen { BONE } else { ASH }),
        ],
        vec![
            span(pad_right(&who, who_w), if chosen { ASH } else { HAIR }),
            span(format!("{:>7}", a.age), age_color),
        ],
        f.width,
    );
    if chosen {
        raised(line)
    } else {
        line
    }
}

fn draw_list(
    frame: &mut Frame,
    app: &App,
    agents: &[Agent],
    selected: Option<&Agent>,
    body: Rect,
    f: &Frame0,
) {
    let title_w = if f.width >= 140 {
        36
    } else if f.width >= 100 {
        28
    } else {
        20
    };
    let is_sel = |a: &Agent| selected.is_some_and(|s| s.id == a.id);
    let group = |g: u8| agents.iter().filter(move |a| calm_group(a) == g);

    let mut lines: Vec<Line> = Vec::new();
    let mut selection_line = 0;
    lines.push(heading("Working", group(0).count(), f.width));
    for a in group(0) {
        if is_sel(a) {
            selection_line = lines.len();
        }
        lines.push(row(app, a, is_sel(a), f, title_w));
        if is_sel(a) && f.width >= 60 {
            let steps = app.session_steps(&a.id);
            let shown = steps
                .len()
                .saturating_sub(if body.height < 24 { 2 } else { 4 });
            let current = steps.len().saturating_sub(1);
            for (i, step) in steps.iter().enumerate().skip(shown) {
                let now = i == current && a.live;
                lines.push(raised(Line::from(vec![
                    span(
                        format!("    {} ", if now { f.spin(3) } else { '✓' }),
                        if now { EMBER } else { HAIR },
                    ),
                    span(
                        truncate(step, f.width.saturating_sub(6)),
                        if now { BONE } else { HAIR },
                    ),
                ])));
            }
        }
    }
    lines.push(Line::default());
    lines.push(heading("Requests", group(1).count(), f.width));
    if group(1).count() == 0 {
        lines.push(Line::from(span("  Nothing is waiting on you.", HAIR)));
    }
    for a in group(1) {
        if is_sel(a) {
            selection_line = lines.len();
        }
        lines.push(row(app, a, is_sel(a), f, title_w));
    }
    lines.push(Line::default());
    let silent = if app.filter.is_empty() {
        app.calm_silent_count()
    } else {
        0
    };
    let earlier: Vec<&Agent> = group(2).collect();
    lines.push(heading("Earlier", earlier.len() + silent, f.width));

    // Earlier is the long group: window it around the selection so the
    // headings above never scroll away.
    let room = (body.height as usize).saturating_sub(lines.len());
    let tail_line = |text: String| Line::from(span(format!("  {text}"), HAIR));
    let needs_window = earlier.len() + usize::from(silent > 0) > room;
    if needs_window && room >= 2 {
        let shown = room - 1;
        let at = earlier.iter().position(|a| is_sel(a)).unwrap_or(0);
        let start = at.saturating_sub(shown / 2).min(earlier.len() - shown);
        for (i, a) in earlier.iter().enumerate().skip(start).take(shown) {
            if is_sel(a) {
                selection_line = lines.len();
            }
            lines.push(row(app, a, is_sel(a), f, title_w));
            let _ = i;
        }
        let above = start;
        let below = earlier.len() - start - shown;
        let more = match (above, below) {
            (0, b) => format!("+ {b} more below"),
            (a, 0) => format!("+ {a} more above"),
            (a, b) => format!("+ {a} above · {b} below"),
        };
        lines.push(tail_line(more));
    } else {
        for a in &earlier {
            if is_sel(a) {
                selection_line = lines.len();
            }
            lines.push(row(app, a, is_sel(a), f, title_w));
        }
        if silent > 0 {
            lines.push(tail_line(format!(
                "+ {silent} {} with no messages yet",
                if silent == 1 { "session" } else { "sessions" }
            )));
        }
    }

    // Only a very busy Working group can still overflow; keep the selection in view.
    let h = body.height as usize;
    let scroll = if lines.len() > h && selection_line + 3 > h {
        (selection_line + 3 - h).min(lines.len() - h)
    } else {
        0
    };
    frame.render_widget(
        Paragraph::new(lines).scroll((scroll.min(u16::MAX as usize) as u16, 0)),
        body,
    );
}

/// The opened session: what was asked, what was said, and the tool steps
/// between them folded to one line per stretch.
fn draw_detail(frame: &mut Frame, app: &mut App, a: &Agent, body: Rect, f: &Frame0) {
    let width = f.width;
    let text_w = width.saturating_sub(6).min(100);
    let head = aligned(
        vec![span("‹ ", ASH), bold(app.session_title(&a.id), BONE)],
        vec![
            span(format!("{} · {}   ", a.harness, short_id(a)), HAIR),
            span(a.age.clone(), if a.live { EMBER } else { ASH }),
        ],
        width,
    );
    frame.render_widget(
        Paragraph::new(head),
        Rect::new(body.x, body.y, body.width, 1),
    );
    frame.render_widget(
        Paragraph::new(span("─".repeat(width), HAIR)),
        Rect::new(body.x, body.y + 1, body.width, 1),
    );

    let mut rows: Vec<_> = app
        .events
        .iter()
        .filter(|r| r.event.session_id == a.id)
        .collect();
    rows.sort_by_key(|r| event_ts_ms(r.event.ts));

    let mut lines: Vec<Line> = Vec::new();
    let mut steps = 0usize;
    let mut last_step = String::new();
    let flush = |lines: &mut Vec<Line>, steps: &mut usize, last: &str| {
        if *steps > 0 {
            let what = format!("{steps} {}", if *steps == 1 { "step" } else { "steps" });
            lines.push(Line::from(vec![
                span("  ✓ ", HAIR),
                span(
                    truncate(&format!("{what} · {last}"), width.saturating_sub(4)),
                    HAIR,
                ),
            ]));
            lines.push(Line::default());
            *steps = 0;
        }
    };
    for r in &rows {
        match r.cls {
            Class::Human => {
                let said = prompt_title(&r.event.summary);
                if said.is_empty() {
                    continue;
                }
                flush(&mut lines, &mut steps, &last_step);
                for (i, l) in wrap(&said, text_w).into_iter().enumerate() {
                    lines.push(Line::from(vec![
                        span(if i == 0 { "› " } else { "  " }, EMBER),
                        span(l, BONE),
                    ]));
                }
                lines.push(Line::default());
            }
            Class::Convo
                if r.event.kind == "assistant"
                    && !is_stream_marker(&r.text)
                    && !crate::app::is_thinking(&r.text) =>
            {
                flush(&mut lines, &mut steps, &last_step);
                for l in wrap(&plain(&r.text), text_w) {
                    lines.push(Line::from(vec![span("  ", SMOKE), span(l, SMOKE)]));
                }
                lines.push(Line::default());
            }
            Class::Tool | Class::Plan => {
                steps += 1;
                last_step = step_line(&r.text);
            }
            _ => {}
        }
    }
    if steps > 0 && a.live {
        let what = format!("{steps} {}", if steps == 1 { "step" } else { "steps" });
        lines.push(Line::from(vec![
            span(format!("  {} ", f.spin(0)), EMBER),
            span(truncate(&last_step, width.saturating_sub(16)), BONE),
            span(format!("   {what}"), HAIR),
        ]));
    } else {
        flush(&mut lines, &mut steps, &last_step);
    }
    if lines.is_empty() {
        lines.push(Line::from(span(
            "  Nothing said in the retained window yet.",
            HAIR,
        )));
    }

    // Newest at the bottom; ↑ scrolls back.
    let h = body.height.saturating_sub(3) as usize;
    let max_back = lines.len().saturating_sub(h);
    app.detail_scroll = app.detail_scroll.min(max_back);
    let scroll = max_back - app.detail_scroll;
    frame.render_widget(
        Paragraph::new(lines).scroll((scroll.min(u16::MAX as usize) as u16, 0)),
        Rect::new(body.x, body.y + 3, body.width, h as u16),
    );
}

fn draw_composer(
    frame: &mut Frame,
    app: &App,
    selected: Option<&Agent>,
    cy: u16,
    f: &Frame0,
    cursor_on: bool,
) {
    let inner = f.width.saturating_sub(2);
    let edge = if app.composing { EMBER } else { ASH };
    frame.render_widget(
        Paragraph::new(span(format!("╭{}╮", "─".repeat(inner)), edge)),
        Rect::new(f.x, cy, f.w, 1),
    );
    let target = selected
        .map(|a| format!("{} · {}", a.harness, short_id(a)))
        .unwrap_or_else(|| "no session".into());
    let (text, color) = if app.composing {
        (format!("› {}", app.draft), BONE)
    } else if let Some(notice) = &app.composer_notice {
        (
            format!("› {notice}"),
            if app.composer_ok { EMBER } else { ASH },
        )
    } else if !app.draft.is_empty() {
        (format!("› {}   draft kept", app.draft), ASH)
    } else {
        (format!("a  to ask {target}"), HAIR)
    };
    let text = truncate(&text, inner.saturating_sub(3));
    let mut spans = vec![span("│ ", edge), span(text, color)];
    if app.composing {
        spans.push(span(if cursor_on { "█" } else { " " }, EMBER));
    }
    let used: usize = spans.iter().map(Span::width).sum();
    spans.push(span(" ".repeat(f.width.saturating_sub(used + 1)), ASH));
    spans.push(span("│", edge));
    frame.render_widget(
        Paragraph::new(Line::from(spans)),
        Rect::new(f.x, cy + 1, f.w, 1),
    );

    // The tail feed carries no approval policy, so the border names only the target.
    let meta = truncate(&format!(" {target} "), inner.saturating_sub(28));
    let hint = if app.composing {
        " ⏎ send · Esc keeps draft "
    } else {
        ""
    };
    let fill = inner.saturating_sub(meta.width() + hint.width() + 1);
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            span("╰─", edge),
            span(meta, ASH),
            span("─".repeat(fill), edge),
            span(hint, ASH),
            span("╯", edge),
        ])),
        Rect::new(f.x, cy + 2, f.w, 1),
    );
}

pub const KEYS: &[(&str, &str)] = &[
    ("↑ ↓  j k", "move"),
    ("g G", "top · bottom"),
    ("PgUp PgDn", "page"),
    ("⏎", "open session"),
    ("Esc", "back one level"),
    ("a  Tab", "ask the selected session"),
    ("/", "filter as you type"),
    ("f", "fleet"),
    ("?", "keys"),
    ("⌃c", "quit"),
];

fn draw_keys(frame: &mut Frame, area: Rect) {
    let key_w = KEYS.iter().map(|(k, _)| k.width()).max().unwrap_or(0) + 3;
    let w = (key_w + KEYS.iter().map(|(_, v)| v.width()).max().unwrap_or(0) + 6) as u16;
    let h = KEYS.len() as u16 + 4;
    if area.width < w + 2 || area.height < h + 2 {
        return;
    }
    let rect = Rect::new(
        area.x + (area.width - w) / 2,
        area.y + (area.height - h) / 2,
        w,
        h,
    );
    frame.render_widget(Clear, rect);
    let inner = w as usize - 2;
    let mut lines = vec![Line::from(span(format!("╭{}╮", "─".repeat(inner)), ASH))];
    let boxed = |content: Vec<Span<'static>>| {
        let used: usize = content.iter().map(Span::width).sum();
        let mut spans = vec![span("│  ", ASH)];
        spans.extend(content);
        spans.push(span(" ".repeat(inner.saturating_sub(used + 2)), ASH));
        spans.push(span("│", ASH));
        Line::from(spans)
    };
    lines.push(boxed(vec![bold("Keys", BONE)]));
    lines.push(boxed(vec![]));
    for (k, what) in KEYS {
        lines.push(boxed(vec![
            span(pad_right(k, key_w), BONE),
            span(*what, ASH),
        ]));
    }
    lines.push(Line::from(span(format!("╰{}╯", "─".repeat(inner)), ASH)));
    frame.render_widget(
        Paragraph::new(lines).style(Style::default().bg(GROUND)),
        rect,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{app::Take, feed::TailEvent};
    use ratatui::{backend::TestBackend, Terminal};

    fn now_ms() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64
    }

    fn said(app: &mut App, n: usize, ts: i64, session: &str, kind: &str, text: &str) {
        app.ingest_event(TailEvent {
            id: format!("e{n}-{session}"),
            ts,
            source: "grok".into(),
            session_id: session.into(),
            kind: kind.into(),
            summary: text.into(),
            project: Some("openscout".into()),
            cwd: None,
            raw: None,
        });
    }

    fn render(app: &mut App, w: u16, h: u16) -> String {
        let mut terminal = Terminal::new(TestBackend::new(w, h)).unwrap();
        terminal.draw(|f| crate::draw::draw(f, app)).unwrap();
        let buf = terminal.backend().buffer();
        (0..h)
            .map(|y| (0..w).map(|x| buf[(x, y)].symbol()).collect::<String>())
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn compact_list_keeps_all_sections_with_a_busy_fleet() {
        let mut app = App::new(Take::Now);
        let now = now_ms();
        for n in 0..12 {
            let ts = if n < 3 {
                now
            } else {
                now - 600_000 - n as i64 * 1000
            };
            said(
                &mut app,
                n,
                ts,
                &format!("same-timestamp-prefix-{n:04}"),
                "assistant",
                &format!("Outcome {n}"),
            );
        }
        for _ in 0..12 {
            let text = render(&mut app, 80, 24);
            for expected in [
                "Working",
                "Requests",
                "Earlier",
                "Nothing is waiting on you.",
                "⌃c quit",
            ] {
                assert!(text.contains(expected), "missing {expected}:\n{text}");
            }
            let selected = app.selected_agent().unwrap();
            assert!(
                text.contains(&app.session_outcome(&selected.id)),
                "selection off screen:\n{text}"
            );
            app.move_cursor(1);
        }
    }

    #[test]
    fn earlier_window_follows_the_selection_to_the_bottom() {
        let mut app = App::new(Take::Now);
        let now = now_ms();
        for n in 0..20 {
            said(
                &mut app,
                n,
                now - 600_000 - n as i64 * 60_000,
                &format!("s{n:02}"),
                "assistant",
                &format!("Outcome number {n:02}"),
            );
        }
        app.move_cursor(1_000);
        let text = render(&mut app, 80, 24);
        assert!(text.contains("Outcome number 19"), "{text}");
        assert!(text.contains("more above"), "{text}");
        assert!(text.contains("Earlier"));
    }

    #[test]
    fn silent_sessions_fold_into_one_line() {
        let mut app = App::new(Take::Now);
        let now = now_ms();
        said(&mut app, 1, now - 900_000, "talks", "assistant", "Done.");
        said(
            &mut app,
            2,
            now - 900_000,
            "quiet-a",
            "system",
            "turn started",
        );
        said(
            &mut app,
            3,
            now - 900_000,
            "quiet-b",
            "system",
            "turn started",
        );
        assert_eq!(app.agents().len(), 1);
        let text = render(&mut app, 100, 30);
        assert!(text.contains("+ 2 sessions with no messages yet"), "{text}");
        assert!(text.contains("3 sessions"), "{text}");
    }

    #[test]
    fn titles_fall_back_from_prompt_to_first_line_to_step() {
        let mut app = App::new(Take::Now);
        let now = now_ms();
        said(
            &mut app,
            1,
            now,
            "a",
            "assistant",
            "**The review** is a list. I'll turn it into an explainer.",
        );
        assert_eq!(app.session_title("a"), "The review is a list");
        said(&mut app, 2, now - 1, "a", "user", "Build an explainer");
        assert_eq!(app.session_title("a"), "Build an explainer");
        assert_eq!(app.session_title("missing"), "agent session");
    }

    #[test]
    fn opened_session_folds_steps_and_shows_the_conversation() {
        let mut app = App::new(Take::Now);
        let now = now_ms();
        said(
            &mut app,
            1,
            now - 5000,
            "a",
            "user",
            "Can you build an interactive explainer?",
        );
        said(
            &mut app,
            2,
            now - 4000,
            "a",
            "assistant",
            "Yes. Checking the design skill first.",
        );
        for n in 0..5 {
            said(
                &mut app,
                10 + n,
                now - 3000 + n as i64,
                "a",
                "tool",
                &format!("read_file file{n}.ts"),
            );
        }
        said(
            &mut app,
            20,
            now - 1000,
            "a",
            "assistant",
            "Done; the page is up.",
        );
        app.calm_detail = true;
        let text = render(&mut app, 100, 30);
        assert!(
            text.contains("› Can you build an interactive explainer?"),
            "{text}"
        );
        assert!(text.contains("Checking the design skill first."));
        assert!(text.contains("5 steps"), "{text}");
        assert!(text.contains("Esc back"));
    }

    #[test]
    fn plain_reads_markdown_as_words() {
        assert_eq!(
            plain("PR is up: [#1152](https://x/1152). **Root cause:** `scout` smoke"),
            "PR is up: #1152. Root cause: scout smoke"
        );
    }

    #[test]
    fn keys_overlay_lists_every_calm_key() {
        let mut app = App::new(Take::Now);
        said(&mut app, 1, now_ms(), "a", "assistant", "hi");
        app.help = true;
        let text = render(&mut app, 100, 30);
        for (k, _) in KEYS {
            assert!(text.contains(k), "missing {k}");
        }
    }

    #[test]
    fn steps_drop_the_cd_prefix_and_thinking_is_not_said() {
        assert_eq!(
            step_line("run_terminal_command · cd ~/dev/x && cargo test\nmore"),
            "run_terminal_command · cargo test"
        );
        assert_eq!(step_line("cd /tmp && ls"), "ls");
        let mut app = App::new(Take::Now);
        said(
            &mut app,
            1,
            now_ms(),
            "a",
            "assistant",
            "[thinking] weighing it",
        );
        said(&mut app, 2, now_ms() - 10, "a", "assistant", "Done.");
        assert_eq!(app.session_outcome("a"), "Done.");
    }
}
