//! THESIS: One calm list of observed work, requests, and outcomes.
//! OWN-WORLD: Warm near-black room canvas (#0C0A08), BONE primary text,
//! ASH machine details, EMBER live/selected, SIGNAL gold for requests.
//! STORY: What is moving; last thought already on screen; draft a response.
//! FORM: Calm list first; legacy fleet views behind explicit keys.

mod app;
mod ask;
mod calm;
mod classify;
mod deliver;
mod draw;
mod feed;
mod git;
mod http;
mod local_config;
mod machines;
mod providers;
mod theme;

use std::io::{self, Write};
use std::sync::mpsc::Receiver;
use std::sync::mpsc::TryRecvError;
use std::time::{Duration, Instant};

use crossterm::cursor::Show;
use crossterm::event::{
    self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEvent, KeyEventKind,
    KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;

use app::{
    clean_summary, short_session, twin_visible_columns, App, Composition, HitKind, Pointer, Take,
};
use ask::spawn_asker;
use feed::{fetch_recent, spawn_tail};
use git::spawn_git;
use machines::spawn_machines;
use providers::spawn_providers;

/// How long the loop waits for input before checking the workers again.
const INPUT_POLL: Duration = Duration::from_millis(80);
/// Live spinners only; unfocused, non-live views redraw on worker/input changes.
const ANIMATION_TICK: Duration = Duration::from_millis(90);

/// Apply every queued worker snapshot; true when at least one arrived.
fn drain<T>(rx: &Receiver<T>, mut apply: impl FnMut(T)) -> bool {
    let mut any = false;
    while let Ok(item) = rx.try_recv() {
        apply(item);
        any = true;
    }
    any
}

struct TerminalGuard;

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        restore_terminal();
    }
}

fn restore_terminal() {
    let _ = disable_raw_mode();
    let mut out = io::stdout();
    let _ = write!(out, "{}", Pointer::Default.osc());
    let _ = execute!(out, DisableMouseCapture, LeaveAlternateScreen, Show);
    let _ = out.flush();
}

fn sync_pointer(app: &mut App, next: Pointer) {
    if app.pointer == next {
        return;
    }
    app.pointer = next;
    let mut out = io::stdout();
    let _ = write!(out, "{}", next.osc());
    let _ = out.flush();
}

fn pointer_for_hit(kind: Option<HitKind>) -> Pointer {
    match kind {
        Some(HitKind::Split) => Pointer::EwResize,
        Some(_) => Pointer::Hand,
        None => Pointer::Default,
    }
}

struct Args {
    probe: bool,
    take: Take,
    composition: Option<Composition>,
}

fn parse_args() -> Args {
    let mut probe = false;
    let mut take = Take::Now;
    let mut composition = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--probe" => probe = true,
            "--help" | "-h" => {
                print_help();
                std::process::exit(0);
            }
            "--take" | "-t" => {
                let value = args.next().unwrap_or_default();
                take = parse_take_or_exit(&value);
            }
            "--composition" | "-c" => {
                let value = args.next().unwrap_or_default();
                composition = Some(parse_composition_or_exit(&value));
                take = Take::Grid;
            }
            other if other.starts_with("--take=") => {
                take = parse_take_or_exit(&other[7..]);
            }
            other if other.starts_with("--composition=") => {
                composition = Some(parse_composition_or_exit(&other[14..]));
                take = Take::Grid;
            }
            other if other.starts_with("--slice=") => {
                take = parse_take_or_exit(&other[8..]);
            }
            other => {
                if let Some(t) = Take::parse(other) {
                    take = t;
                } else if let Some(c) = Composition::parse(other) {
                    take = Take::Grid;
                    composition = Some(c);
                } else {
                    eprintln!("unknown arg: {other}");
                    print_help();
                    std::process::exit(2);
                }
            }
        }
    }
    Args {
        probe,
        take,
        composition,
    }
}

fn parse_take_or_exit(value: &str) -> Take {
    Take::parse(value).unwrap_or_else(|| {
        eprintln!("unknown take: {value} (valid: now, horizon, twin, mesh, quota, harvest, grid)");
        print_help();
        std::process::exit(2);
    })
}

fn parse_composition_or_exit(value: &str) -> Composition {
    Composition::parse(value).unwrap_or_else(|| {
        eprintln!("unknown composition: {value} (valid: focus, watch, review, quad)");
        print_help();
        std::process::exit(2);
    })
}

fn print_help() {
    eprintln!(
        "scout-tui [--take now|horizon|twin|mesh|quota|harvest|grid] [--composition focus|watch|review|quad] [--probe]\n\
         Scout Nightwatch, Harvest & Grid: seven takes, four grid compositions, one fleet."
    );
}

fn handle_key(app: &mut App, key: KeyEvent, terminal_width: u16) -> bool {
    if key.kind != KeyEventKind::Press {
        return false;
    }

    let visible_twin_cols = if app.take == Take::Twin {
        let cols = twin_visible_columns(terminal_width, app.agents().len());
        app.clamp_deck_focus(cols);
        cols
    } else {
        1
    };

    // Ctrl+C always quits
    if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
        return true;
    }

    if app.help {
        match key.code {
            KeyCode::Char('?') | KeyCode::Char('q') | KeyCode::Esc | KeyCode::Enter => {
                app.help = false;
            }
            _ => {}
        }
        return false;
    }

    if app.filtering {
        match key.code {
            KeyCode::Esc => {
                app.filtering = false;
                app.filter.clear();
            }
            KeyCode::Enter => app.filtering = false,
            KeyCode::Backspace => {
                app.filter.pop();
            }
            KeyCode::Down => app.move_cursor(1),
            KeyCode::Up => app.move_cursor(-1),
            KeyCode::Char(c) => app.filter.push(c),
            _ => {}
        }
        return false;
    }

    if app.composing {
        match key.code {
            // The calm list keeps the draft: Esc only steps out of the composer.
            KeyCode::Esc if app.calm() => app.composing = false,
            KeyCode::Esc => {
                app.cancel_compose();
            }
            KeyCode::Enter => {
                app.submit_compose();
            }
            KeyCode::Backspace => {
                app.draft.pop();
            }
            KeyCode::Char(c) => {
                app.draft.push(c);
            }
            _ => {}
        }
        return false;
    }

    if app.calm() {
        if let Some(()) = handle_calm_key(app, key.code) {
            return false;
        }
    }
    if app.fleet_view && matches!(key.code, KeyCode::Esc | KeyCode::Char('f')) {
        app.fleet_view = false;
        app.take = Take::Now;
        return false;
    }
    if matches!(
        key.code,
        KeyCode::Char('1') | KeyCode::Char('/') | KeyCode::Tab | KeyCode::BackTab
    ) {
        app.fleet_view = false;
    }
    // Normal instrument key navigation
    match (key.code, key.modifiers) {
        (KeyCode::Char('q'), _) => app.take = Take::Quota,
        (KeyCode::Char('f'), _) => {
            app.take = Take::Now;
            app.fleet_view = true;
        }
        (KeyCode::Char('/'), _) => {
            app.take = Take::Now;
            app.filtering = true;
        }
        (KeyCode::Char('a'), _) if app.take != Take::Mesh => app.begin_compose(),
        (KeyCode::Enter, _) if app.take == Take::Now && !app.fleet_view => app.take = Take::Twin,
        (KeyCode::Char('?'), _) => {
            app.help = true;
        }
        (KeyCode::Char('1'), _) => app.take = Take::Now,
        (KeyCode::Char('2'), _) => app.take = Take::Horizon,
        (KeyCode::Char('3'), _) => app.take = Take::Twin,
        (KeyCode::Char('4'), _) => app.take = Take::Mesh,
        (KeyCode::Char('5'), _) => app.take = Take::Quota,
        (KeyCode::Char('6'), _) => app.take = Take::Harvest,
        (KeyCode::Char('7'), _) => app.take = Take::Grid,
        (KeyCode::Char('g'), _) => {
            if app.take == Take::Grid {
                app.next_composition();
            } else {
                app.take = match app.take {
                    Take::Horizon => Take::Mesh,
                    Take::Mesh => Take::Harvest,
                    Take::Harvest => Take::Horizon,
                    _ => Take::Horizon,
                };
            }
        }
        (KeyCode::Char('h'), _) | (KeyCode::Left, _) if app.take == Take::Grid => {
            app.move_grid_focus(-1, 0);
        }
        (KeyCode::Char('l'), _) | (KeyCode::Right, _) if app.take == Take::Grid => {
            app.move_grid_focus(1, 0);
        }
        (KeyCode::Char('j'), _) | (KeyCode::Down, _) if app.take == Take::Grid => {
            app.move_grid_focus(0, 1);
        }
        (KeyCode::Char('k'), _) | (KeyCode::Up, _) if app.take == Take::Grid => {
            app.move_grid_focus(0, -1);
        }
        (KeyCode::Char('h'), _) | (KeyCode::Left, _) if app.take == Take::Twin => {
            app.cycle_deck_focus(-1, visible_twin_cols);
        }
        (KeyCode::Char('l'), _) | (KeyCode::Right, _) if app.take == Take::Twin => {
            app.cycle_deck_focus(1, visible_twin_cols);
        }
        (KeyCode::Char('j'), _) | (KeyCode::Down, _) => {
            app.move_cursor(1);
        }
        (KeyCode::Char('k'), _) | (KeyCode::Up, _) => {
            app.move_cursor(-1);
        }
        (KeyCode::Tab, _) => {
            if app.take == Take::Grid {
                app.move_slot_focus(1);
            } else if app.take == Take::Twin {
                app.cycle_deck_focus(1, visible_twin_cols);
            } else {
                app.take = app.take.next_spine();
            }
        }
        (KeyCode::BackTab, _) => {
            if app.take == Take::Grid {
                app.move_slot_focus(-1);
            } else if app.take == Take::Twin {
                app.cycle_deck_focus(-1, visible_twin_cols);
            } else {
                app.take = app.take.prev_spine();
            }
        }
        (KeyCode::Char('p'), _) | (KeyCode::Enter, _) if app.take == Take::Mesh => {
            app.queue_mesh_ping();
        }
        (KeyCode::Char('a'), _) if app.take == Take::Mesh => {
            app.queue_mesh_join();
        }
        (KeyCode::Char('x'), _) if app.take == Take::Mesh => {
            app.queue_mesh_leave();
        }
        (KeyCode::Char('r'), _) if app.take == Take::Mesh => {
            app.queue_mesh_refresh();
        }
        (KeyCode::Char('i'), _) | (KeyCode::Enter, _) => {
            if app.can_compose() {
                if matches!(app.take, Take::Horizon | Take::Harvest) {
                    app.take = Take::Now;
                }
                app.begin_compose();
            } else if !matches!(app.take, Take::Mesh) {
                app.composer_notice = Some(app.compose_blocked_reason());
            }
        }
        (KeyCode::Char('['), _) if app.take.splits_detail() => {
            app.nudge_split(-4);
        }
        (KeyCode::Char(']'), _) if app.take.splits_detail() => {
            app.nudge_split(4);
        }
        (KeyCode::Esc, _) if app.take != Take::Now => {
            app.take = Take::Now;
        }
        _ => {}
    }

    false
}

/// The calm list's keys. None lets the key fall through to the legacy takes
/// (1–7 switch views). No letter quits; Esc backs out one level.
fn handle_calm_key(app: &mut App, code: KeyCode) -> Option<()> {
    let detail = app.calm_detail;
    match code {
        KeyCode::Down | KeyCode::Char('j') if detail => {
            app.detail_scroll = app.detail_scroll.saturating_sub(1)
        }
        KeyCode::Up | KeyCode::Char('k') if detail => app.detail_scroll += 1,
        KeyCode::PageDown if detail => app.detail_scroll = app.detail_scroll.saturating_sub(10),
        KeyCode::PageUp if detail => app.detail_scroll += 10,
        KeyCode::Down | KeyCode::Char('j') => app.move_cursor(1),
        KeyCode::Up | KeyCode::Char('k') => app.move_cursor(-1),
        KeyCode::PageDown => app.move_cursor(8),
        KeyCode::PageUp => app.move_cursor(-8),
        KeyCode::Char('g') | KeyCode::Home if !detail => app.move_cursor(isize::MIN / 2),
        KeyCode::Char('G') | KeyCode::End if !detail => app.move_cursor(isize::MAX / 2),
        KeyCode::Enter if !detail && app.selected_agent().is_some() => {
            app.calm_detail = true;
            app.detail_scroll = 0;
        }
        KeyCode::Esc => {
            if detail {
                app.calm_detail = false;
            } else {
                app.filter.clear();
            }
        }
        KeyCode::Char('a') | KeyCode::Char('i') | KeyCode::Tab
            if app.selected_agent().is_some() =>
        {
            app.begin_compose()
        }
        KeyCode::Char('/') => {
            app.calm_detail = false;
            app.filter.clear();
            app.filtering = true;
        }
        KeyCode::Char('?') => app.help = true,
        KeyCode::Char('f') => {
            app.calm_detail = false;
            app.fleet_view = true;
        }
        KeyCode::Char('1'..='7') | KeyCode::BackTab => return None,
        _ => {}
    }
    Some(())
}

fn handle_mouse(app: &mut App, mouse: MouseEvent) -> bool {
    if app.help || app.composing {
        app.split_drag = false;
        sync_pointer(app, Pointer::Default);
        return false;
    }
    let hit = app.hit_at(mouse.column, mouse.row);
    match mouse.kind {
        MouseEventKind::Down(MouseButton::Left) => {
            if matches!(hit, Some(HitKind::Split)) {
                app.split_drag = true;
                app.set_split_from_col(mouse.column);
                sync_pointer(app, Pointer::EwResize);
            } else {
                app.split_drag = false;
                if let Some(kind) = hit {
                    app.apply_hit(kind);
                }
                sync_pointer(app, pointer_for_hit(hit));
            }
            true
        }
        MouseEventKind::Drag(MouseButton::Left) if app.split_drag => {
            app.set_split_from_col(mouse.column);
            sync_pointer(app, Pointer::EwResize);
            true
        }
        MouseEventKind::Up(MouseButton::Left) => {
            if app.split_drag {
                app.persist_split();
            }
            app.split_drag = false;
            sync_pointer(app, pointer_for_hit(hit));
            true
        }
        MouseEventKind::Moved => {
            if app.split_drag {
                app.set_split_from_col(mouse.column);
                sync_pointer(app, Pointer::EwResize);
                true
            } else {
                sync_pointer(app, pointer_for_hit(hit));
                false
            }
        }
        MouseEventKind::ScrollDown => {
            app.move_cursor(1);
            true
        }
        MouseEventKind::ScrollUp => {
            app.move_cursor(-1);
            true
        }
        _ => false,
    }
}

fn main() -> io::Result<()> {
    let args = parse_args();
    if args.probe {
        match fetch_recent() {
            Ok(events) => {
                println!("recent events: {}", events.len());
                for event in events.iter().rev().take(5) {
                    println!(
                        "{} {} {} {}",
                        event.source,
                        event.kind,
                        short_session(&event.session_id),
                        clean_summary(&event.summary)
                    );
                }
                return Ok(());
            }
            Err(err) => {
                eprintln!("{err}");
                std::process::exit(1);
            }
        }
    }

    if unsafe { libc::isatty(libc::STDIN_FILENO) } == 0 {
        eprintln!("scout-tui needs a real terminal (stdin is not a tty)");
        std::process::exit(1);
    }

    if std::env::var_os("COLORTERM").is_none() {
        std::env::set_var("COLORTERM", "truecolor");
    }

    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen, EnableMouseCapture)?;
    let _guard = TerminalGuard;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let rx = spawn_tail();
    let (mesh_tx, machines_rx) = spawn_machines();
    let providers_rx = spawn_providers();
    let (git_cwd_tx, git_rx) = spawn_git();
    let (ask_tx, ask_rx) = spawn_asker();
    let mut sent_cwds: Vec<String> = Vec::new();
    let mut app = App::new(args.take);
    if let Some(comp) = args.composition {
        app.set_composition(comp);
    }
    let mut done = false;
    let mut dirty = true;
    let mut tail_down = false;
    let mut last_draw = Instant::now();
    let mut live_until = 0u64;
    let mut was_animated = false;

    while !done {
        let mut ingested = false;
        loop {
            match rx.try_recv() {
                Ok(snap) => {
                    app.ingest(snap);
                    ingested = true;
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    if !tail_down {
                        tail_down = true;
                        app.error = Some("tail disconnected".into());
                        dirty = true;
                    }
                    break;
                }
            }
        }
        dirty |= ingested;

        dirty |= drain(&machines_rx, |snap| {
            app.set_machines(snap.machines, snap.error, snap.registry_ready, snap.notice)
        });
        dirty |= drain(&providers_rx, |snap| {
            app.set_plans(snap.plans, snap.error, snap.ready)
        });
        dirty |= drain(&git_rx, |snap| {
            app.set_git(snap.churn, snap.untracked, snap.roots, snap.error)
        });
        dirty |= drain(&ask_rx, |result| app.finish_ask(result));

        if let Some(action) = app.take_mesh_action() {
            if mesh_tx.send(action).is_err() {
                app.mesh_busy = false;
                app.mesh_notice = Some("mesh worker stopped".into());
                dirty = true;
            }
        }
        if let Some(request) = app.take_ask_request() {
            if ask_tx.send(request).is_err() {
                app.finish_ask(Err("ask worker stopped; draft kept".into()));
                dirty = true;
            }
        }

        // The git prober only looks where the fleet is actually working.
        if ingested {
            let cwds = app.session_cwds();
            if cwds != sent_cwds {
                let _ = git_cwd_tx.send(cwds.clone());
                sent_cwds = cwds;
            }
        }

        // Compute the expiry only on changes; do not rebuild the fleet every input poll.
        if dirty {
            live_until = app
                .agents()
                .iter()
                .filter(|a| a.live)
                .map(|a| app::event_ts_ms(a.last_ts).saturating_add(90_000))
                .max()
                .unwrap_or(0);
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let animated = app.composing
            || app.filtering
            || (app.take == Take::Now && !app.fleet_view && now < live_until);
        dirty |= animated != was_animated;
        was_animated = animated;
        if dirty || (animated && last_draw.elapsed() >= ANIMATION_TICK) {
            terminal.draw(|frame| draw::draw(frame, &mut app))?;
            dirty = false;
            last_draw = Instant::now();
        }

        if event::poll(INPUT_POLL)? {
            loop {
                match event::read()? {
                    Event::Key(key) if key.kind != KeyEventKind::Release => {
                        done = handle_key(&mut app, key, terminal.size()?.width) || done;
                        dirty = true;
                    }
                    Event::Mouse(mouse) if handle_mouse(&mut app, mouse) => dirty = true,
                    Event::Resize(_, _) => dirty = true,
                    _ => {}
                }
                if done || !event::poll(Duration::ZERO)? {
                    break;
                }
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use ratatui::backend::TestBackend;

    use super::*;

    fn add_agents(app: &mut App, count: usize) {
        for id in 0..count {
            app.ingest_event(feed::TailEvent {
                id: format!("event-{id}"),
                ts: 1_700_000_000_000 + id as i64,
                source: "codex".into(),
                session_id: format!("session-{id}"),
                kind: "assistant".into(),
                summary: format!("response {id}"),
                project: Some("openscout".into()),
                cwd: Some("/work/openscout".into()),
                raw: None,
            });
        }
    }

    #[test]
    fn no_letter_quits_and_esc_never_quits() {
        let mut app = App::new(Take::Now);
        add_agents(&mut app, 3);
        for c in ['q', 'Q', 'x'] {
            assert!(!handle_key(
                &mut app,
                KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE),
                80
            ));
        }
        assert_eq!(app.take, Take::Now);
        for _ in 0..5 {
            assert!(!handle_key(
                &mut app,
                KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE),
                80
            ));
        }
        assert!(handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL),
            80
        ));
    }

    #[test]
    fn esc_backs_out_one_level_at_a_time() {
        let mut app = App::new(Take::Now);
        add_agents(&mut app, 3);
        press(&mut app, KeyCode::Enter);
        assert!(app.calm_detail);
        press(&mut app, KeyCode::Char('a'));
        assert!(app.composing);
        press(&mut app, KeyCode::Char('h'));
        press(&mut app, KeyCode::Esc);
        assert!(!app.composing && app.calm_detail, "composer → session");
        assert_eq!(app.draft, "h", "Esc keeps the draft");
        press(&mut app, KeyCode::Esc);
        assert!(!app.calm_detail, "session → list");
        press(&mut app, KeyCode::Char('f'));
        assert!(app.fleet_view);
        press(&mut app, KeyCode::Esc);
        assert!(!app.fleet_view && app.take == Take::Now, "fleet → list");
        press(&mut app, KeyCode::Char('?'));
        assert!(app.help);
        press(&mut app, KeyCode::Esc);
        assert!(!app.help, "keys → list");
    }

    #[test]
    fn filter_types_moves_and_esc_clears() {
        let mut app = App::new(Take::Now);
        add_agents(&mut app, 12);
        press(&mut app, KeyCode::Char('/'));
        for c in "response 1".chars() {
            press(&mut app, KeyCode::Char(c));
        }
        assert_eq!(app.filter, "response 1");
        // "response 1", "response 10", "response 11"
        assert_eq!(app.agents().len(), 3);
        press(&mut app, KeyCode::Down);
        assert!(app.filtering, "arrows move without leaving the filter");
        press(&mut app, KeyCode::Enter);
        assert!(!app.filtering);
        assert_eq!(app.filter, "response 1", "Enter keeps the filter");
        press(&mut app, KeyCode::Esc);
        assert!(app.filter.is_empty(), "Esc clears it");
        press(&mut app, KeyCode::Char('/'));
        press(&mut app, KeyCode::Char('z'));
        press(&mut app, KeyCode::Esc);
        assert!(!app.filtering && app.filter.is_empty());
    }

    #[test]
    fn g_and_shift_g_jump_to_the_ends() {
        let mut app = App::new(Take::Now);
        add_agents(&mut app, 10);
        press(&mut app, KeyCode::Char('G'));
        let last = app.agents().last().unwrap().id.clone();
        assert_eq!(app.selected_agent().unwrap().id, last);
        press(&mut app, KeyCode::Char('g'));
        let first = app.agents().first().unwrap().id.clone();
        assert_eq!(app.selected_agent().unwrap().id, first);
        press(&mut app, KeyCode::PageDown);
        assert_eq!(app.selected_agent().unwrap().id, app.agents()[8].id);
    }

    #[test]
    fn selection_holds_when_another_session_jumps_ahead() {
        let mut app = App::new(Take::Now);
        add_agents(&mut app, 6);
        press(&mut app, KeyCode::Char('j'));
        press(&mut app, KeyCode::Char('j'));
        let held = app.selected_agent().unwrap().id;
        // The oldest session speaks again and moves to the top.
        app.ingest_event(feed::TailEvent {
            id: "late".into(),
            ts: 1_700_000_100_000,
            source: "codex".into(),
            session_id: "session-0".into(),
            kind: "assistant".into(),
            summary: "back again".into(),
            project: Some("openscout".into()),
            cwd: None,
            raw: None,
        });
        assert_eq!(app.agents()[0].id, "session-0");
        assert_eq!(app.selected_agent().unwrap().id, held);
        press(&mut app, KeyCode::Char('j'));
        let next = app.selected_agent().unwrap().id;
        let list = app.agents();
        let at = list.iter().position(|a| a.id == held).unwrap();
        assert_eq!(
            next,
            list[at + 1].id,
            "j moves from the held row, not a stale index"
        );
    }

    #[test]
    fn title_skips_command_skill_and_continuation_boilerplate() {
        assert!(app::prompt_title(
            "<command-message>scout</command-message> <command-name>/scout</command-name>"
        )
        .is_empty());
        assert!(app::prompt_title(
            "Base directory for this skill: /tmp/skill # enormous instructions"
        )
        .is_empty());
        assert!(
            app::prompt_title("This session is being continued from earlier. Summary: things")
                .is_empty()
        );
        let mut app = App::new(Take::Now);
        for (n, prompt) in [
            (1, "<command-message>scout</command-message>"),
            (2, "Review the TUI"),
            (3, "Continue"),
        ] {
            app.ingest_event(feed::TailEvent {
                id: format!("title-{n}"),
                ts: 1_700_000_000_000 + n,
                source: "grok".into(),
                session_id: "test".into(),
                kind: "user".into(),
                summary: prompt.into(),
                project: None,
                cwd: None,
                raw: None,
            });
        }
        assert_eq!(app.session_title("test"), "Review the TUI");
    }

    #[test]
    fn enter_queues_the_ask_without_blocking_or_dropping_the_draft() {
        let mut app = App::new(Take::Now);
        add_agents(&mut app, 1);
        app.begin_compose();
        app.draft = "Please continue with the review".into();

        assert!(!handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
            85,
        ));
        assert!(!app.composing);
        assert_eq!(app.draft, "Please continue with the review");
        assert!(!app.composer_ok);
        assert!(app.ask_busy());
        assert_eq!(app.composer_notice.as_deref(), Some("asking @codex·ion0…"));
        assert_eq!(
            app.take_ask_request(),
            Some(ask::AskRequest {
                session_id: "session-0".into(),
                handle: "@codex·ion0".into(),
                harness: "codex".into(),
                body: "Please continue with the review".into(),
            })
        );

        app.finish_ask(Err("broker unreachable".into()));
        assert!(!app.ask_busy());
        assert_eq!(app.draft, "Please continue with the review");
        assert_eq!(app.composer_notice.as_deref(), Some("broker unreachable"));
    }

    #[test]
    fn a_landed_ask_clears_only_the_draft_it_sent() {
        let mut app = App::new(Take::Now);
        add_agents(&mut app, 1);
        app.begin_compose();
        app.draft = "first".into();
        press(&mut app, KeyCode::Enter);
        assert!(app.take_ask_request().is_some());

        app.finish_ask(Ok("asked @codex·ion0".into()));
        assert!(app.composer_ok);
        assert!(app.draft.is_empty());

        app.begin_compose();
        app.draft = "second".into();
        press(&mut app, KeyCode::Enter);
        app.draft = "typed while it flew".into();
        app.finish_ask(Ok("asked @codex·ion0".into()));
        assert_eq!(app.draft, "typed while it flew");
    }

    #[test]
    fn enter_without_a_session_keeps_the_draft() {
        let mut app = App::new(Take::Now);
        app.begin_compose();
        app.draft = "Please continue with the review".into();

        assert!(!handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
            85,
        ));
        assert!(!app.composing);
        assert_eq!(app.draft, "Please continue with the review");
        assert!(!app.composer_ok);
        assert_eq!(app.composer_notice.as_deref(), Some("no session to ask"));
    }

    #[test]
    fn escape_cancels_and_clears_a_draft() {
        let mut app = App::new(Take::Twin);
        app.begin_compose();
        app.draft = "Never mind".into();

        assert!(!handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE),
            85,
        ));
        assert!(!app.composing);
        assert!(app.draft.is_empty());
        assert!(app.composer_notice.is_none());
    }

    #[test]
    fn enter_on_empty_horizon_does_not_compose() {
        let mut app = App::new(Take::Horizon);

        assert!(!handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
            85,
        ));
        assert!(!app.composing);
        assert_eq!(app.composer_notice.as_deref(), Some("no session to ask"));
    }

    #[test]
    fn enter_on_horizon_with_a_session_opens_now_compose() {
        let mut app = App::new(Take::Horizon);
        add_agents(&mut app, 1);
        press(&mut app, KeyCode::Enter);
        assert_eq!(app.take, Take::Now);
        assert!(app.composing);
        assert_eq!(app.selected_agent().unwrap().id, "session-0");
    }

    fn mesh_machine() -> app::Machine {
        app::Machine {
            name: "desk".into(),
            dns_name: "desk.tailnet".into(),
            scout: Some(app::ScoutNode {
                broker_url: "http://desk.tailnet:9".into(),
                web_url: String::new(),
                scope: "mesh".into(),
                capabilities: Vec::new(),
                last_seen_ms: 0,
            }),
            ..app::Machine::default()
        }
    }

    #[test]
    fn mesh_enter_pings_instead_of_opening_a_draft() {
        let mut app = App::new(Take::Mesh);
        app.set_machines(vec![mesh_machine()], None, true, None);

        press(&mut app, KeyCode::Enter);
        assert!(!app.composing);
        assert!(app.composer_notice.is_none());
        assert_eq!(app.mesh_notice.as_deref(), Some("pinging desk…"));
        assert_eq!(
            app.take_mesh_action(),
            Some(app::MeshAction::Ping {
                target: "http://desk.tailnet:9".into(),
                label: "desk".into(),
            })
        );
    }

    #[test]
    fn mesh_announce_and_withdraw_are_this_machine_actions() {
        let mut app = App::new(Take::Mesh);
        press(&mut app, KeyCode::Char('a'));
        assert_eq!(app.take_mesh_action(), Some(app::MeshAction::Join));
        app.mesh_busy = false;
        press(&mut app, KeyCode::Char('x'));
        assert_eq!(app.take_mesh_action(), Some(app::MeshAction::Leave));
        app.mesh_busy = false;
        press(&mut app, KeyCode::Char('r'));
        assert_eq!(app.take_mesh_action(), Some(app::MeshAction::Refresh));
    }

    #[test]
    fn twin_input_cycles_only_visible_columns_for_every_layout() {
        for width in [60, 85, 160] {
            for fleet_size in 0..=3 {
                let mut app = App::new(Take::Twin);
                add_agents(&mut app, fleet_size);
                let visible_cols = twin_visible_columns(width, fleet_size);
                let mut visited = vec![false; visible_cols];

                for _ in 0..visible_cols * 2 {
                    assert!(app.deck_focus < visible_cols);
                    visited[app.deck_focus] = true;
                    assert!(!handle_key(
                        &mut app,
                        KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE),
                        width,
                    ));
                }

                assert!(
                    visited.into_iter().all(|was_visited| was_visited),
                    "width={width}, fleet_size={fleet_size}"
                );
            }
        }
    }

    #[test]
    fn twin_input_clamps_stale_focus_before_navigation() {
        let mut app = App::new(Take::Twin);
        add_agents(&mut app, 3);
        app.deck_focus = 2;

        assert!(!handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('j'), KeyModifiers::NONE),
            85,
        ));
        assert_eq!(app.deck_focus, 1);

        app.deck_focus = 2;
        assert!(!handle_key(
            &mut app,
            KeyEvent::new(KeyCode::BackTab, KeyModifiers::SHIFT),
            60,
        ));
        assert_eq!(app.deck_focus, 0);
    }

    #[test]
    fn empty_wide_twin_render_and_input_share_one_focus_target() {
        let backend = TestBackend::new(160, 28);
        let mut terminal = Terminal::new(backend).expect("test terminal");
        let mut app = App::new(Take::Twin);
        app.deck_focus = 2;

        terminal
            .draw(|frame| draw::draw(frame, &mut app))
            .expect("empty 160x28 Twin should render");
        assert_eq!(twin_visible_columns(160, 0), 1);
        assert_eq!(app.deck_focus, 0);

        let rendered: String = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect();
        assert!(rendered.contains("No active sessions found."));

        assert!(!handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE),
            160,
        ));
        assert_eq!(app.deck_focus, 0);
    }

    fn sample_plan() -> app::Plan {
        app::Plan {
            id: "claude".into(),
            name: "Claude".into(),
            plan: "Max".into(),
            source: "Claude local status".into(),
            availability: "available".into(),
            confidence: "fresh".into(),
            burn_rate: "on track".into(),
            primary_roles: Vec::new(),
            failover: String::new(),
            windows: vec![app::QuotaWindow {
                label: "7d".into(),
                used: 26,
                reset: "4d 12h".into(),
                spark: vec![0.2, 0.26],
                pace: "on track".into(),
                confidence: "fresh".into(),
                source: "Claude local status".into(),
            }],
            status: None,
        }
    }

    fn render_quota(app: &mut App) -> String {
        let backend = TestBackend::new(120, 28);
        let mut terminal = Terminal::new(backend).expect("test terminal");
        terminal
            .draw(|frame| draw::draw(frame, app))
            .expect("quota should render");
        terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect()
    }

    fn press(app: &mut App, code: KeyCode) {
        assert!(!handle_key(
            app,
            KeyEvent::new(code, KeyModifiers::NONE),
            120,
        ));
    }

    #[test]
    fn grid_hjkl_moves_slot_focus_not_the_fleet_cursor() {
        let mut app = App::new(Take::Grid);
        add_agents(&mut app, 3);
        app.cursor = 1;
        assert_eq!(app.focused_slot, 0);

        press(&mut app, KeyCode::Char('l'));
        assert_eq!(app.focused_slot, 1);
        assert_eq!(app.cursor, 1);

        press(&mut app, KeyCode::Char('j'));
        assert_eq!(app.focused_slot, 4);
        assert_eq!(app.cursor, 1);

        press(&mut app, KeyCode::Char('h'));
        assert_eq!(app.focused_slot, 3);
        assert_eq!(app.cursor, 1);

        press(&mut app, KeyCode::Char('k'));
        assert_eq!(app.focused_slot, 0);
        assert_eq!(app.take, Take::Grid);
    }

    #[test]
    fn grid_tab_wraps_slots_and_g_cycles_composition() {
        let mut app = App::new(Take::Grid);
        press(&mut app, KeyCode::Tab);
        assert_eq!(app.focused_slot, 1);
        assert!(!handle_key(
            &mut app,
            KeyEvent::new(KeyCode::BackTab, KeyModifiers::SHIFT),
            120,
        ));
        assert_eq!(app.focused_slot, 0);

        press(&mut app, KeyCode::Char('g'));
        assert_eq!(app.composition, Composition::Review);
        assert_eq!(app.focused_slot, 0);
    }

    #[test]
    fn tab_cycles_the_spine_and_skips_twin_and_grid() {
        let mut app = App::new(Take::Now);
        // Tab asks on the calm list; the spine starts from the fleet.
        app.fleet_view = true;
        press(&mut app, KeyCode::Tab);
        assert_eq!(app.take, Take::Horizon);
        press(&mut app, KeyCode::Tab);
        assert_eq!(app.take, Take::Mesh);
        press(&mut app, KeyCode::Tab);
        assert_eq!(app.take, Take::Harvest);
        press(&mut app, KeyCode::Tab);
        assert_eq!(app.take, Take::Quota);
        press(&mut app, KeyCode::Tab);
        assert_eq!(app.take, Take::Now);
        assert!(!handle_key(
            &mut app,
            KeyEvent::new(KeyCode::BackTab, KeyModifiers::SHIFT),
            120,
        ));
        assert_eq!(app.take, Take::Quota);
    }

    #[test]
    fn harvest_jk_steps_trees_not_files() {
        let mut app = App::new(Take::Harvest);
        add_agents(&mut app, 3);
        assert_eq!(app.harvest_item_count(), 3);
        press(&mut app, KeyCode::Char('j'));
        assert_eq!(app.harvest_cursor, 1);
        let selected = app.selected_harvest_item().unwrap().0.session_id;
        assert_eq!(app.selected_agent().unwrap().id, selected);
        press(&mut app, KeyCode::Char('j'));
        assert_eq!(app.harvest_cursor, 2);
        press(&mut app, KeyCode::Char('k'));
        assert_eq!(app.harvest_cursor, 1);
    }

    #[test]
    fn harvest_enter_opens_now_compose_for_the_tree() {
        let mut app = App::new(Take::Harvest);
        add_agents(&mut app, 3);
        press(&mut app, KeyCode::Char('j'));
        let tree_id = app.selected_harvest_item().unwrap().0.session_id;
        press(&mut app, KeyCode::Enter);
        assert_eq!(app.take, Take::Now);
        assert!(app.composing);
        assert_eq!(app.selected_agent().unwrap().id, tree_id);
    }

    #[test]
    fn quota_take_renders_live_provider_windows() {
        let mut app = App::new(Take::Quota);
        app.set_plans(vec![sample_plan()], None, true);

        let rendered = render_quota(&mut app);
        assert!(rendered.contains("Claude"));
        assert!(rendered.contains("26%"));
        assert!(!rendered.contains("does not publish plan windows"));
        assert!(!rendered.contains("No provider quota feed."));
    }

    #[test]
    fn quota_take_names_an_empty_live_feed_instead_of_a_missing_api() {
        let mut app = App::new(Take::Quota);
        app.set_plans(Vec::new(), None, true);

        let rendered = render_quota(&mut app);
        assert!(rendered.contains("No provider quota windows yet."));
        assert!(!rendered.contains("does not publish plan windows"));
    }
}
