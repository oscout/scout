//! THESIS: The TUI is a night instrument, not an attention inbox.
//! OWN-WORLD: Warm near-black room canvas (#0A0908), BONE primary text,
//! ASH machine details, PHOSPHOR live state, SIGNAL amber attention.
//! STORY: What is moving; last thought already on screen; draft a response.
//! FORM: Seven takes on one fleet (Now, Horizon, Twin, Mesh, Quota, Harvest, Grid).

mod app;
mod classify;
mod draw;
mod feed;
mod git;
mod http;
mod local_config;
mod machines;
mod providers;
mod theme;

use std::io::{self, Write};
use std::sync::mpsc::TryRecvError;
use std::time::Duration;

use crossterm::cursor::Show;
use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;

use app::{clean_summary, short_session, twin_visible_columns, App, Composition, Take};
use feed::{fetch_recent, spawn_tail};
use git::spawn_git;
use machines::spawn_machines;
use providers::spawn_providers;

struct TerminalGuard;

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        restore_terminal();
    }
}

fn restore_terminal() {
    let _ = disable_raw_mode();
    let mut out = io::stdout();
    let _ = execute!(out, LeaveAlternateScreen, Show);
    let _ = out.flush();
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

    if app.composing {
        match key.code {
            KeyCode::Esc => {
                app.cancel_compose();
            }
            KeyCode::Enter => {
                app.submit_compose_disabled();
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

    // Normal instrument key navigation
    match (key.code, key.modifiers) {
        (KeyCode::Char('q'), _) => return true,
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
                app.take = Take::Grid;
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
                app.take = app.take.next();
            }
        }
        (KeyCode::BackTab, _) => {
            if app.take == Take::Grid {
                app.move_slot_focus(-1);
            } else if app.take == Take::Twin {
                app.cycle_deck_focus(-1, visible_twin_cols);
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
            if matches!(app.take, Take::Now | Take::Twin) && app.selected_agent().is_some() {
                app.begin_compose();
            } else {
                app.composer_notice =
                    Some("Draft editor is available in Now or Twin; nothing was sent.".into());
            }
        }
        (KeyCode::Esc, _) if app.take != Take::Now => {
            app.take = Take::Now;
        }
        _ => {}
    }

    false
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

    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    let _guard = TerminalGuard;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let rx = spawn_tail();
    let (mesh_tx, machines_rx) = spawn_machines();
    let providers_rx = spawn_providers();
    let (git_cwd_tx, git_rx) = spawn_git();
    let mut sent_cwds: Vec<String> = Vec::new();
    let mut app = App::new(args.take);
    if let Some(comp) = args.composition {
        app.set_composition(comp);
    }
    let mut done = false;

    while !done {
        loop {
            match rx.try_recv() {
                Ok(snap) => app.ingest(snap),
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    app.error = Some("tail disconnected".into());
                    break;
                }
            }
        }

        loop {
            match machines_rx.try_recv() {
                Ok(snap) => {
                    app.set_machines(snap.machines, snap.error, snap.registry_ready, snap.notice)
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => break,
            }
        }

        if let Some(action) = app.take_mesh_action() {
            if mesh_tx.send(action).is_err() {
                app.mesh_busy = false;
                app.mesh_notice = Some("mesh worker stopped".into());
            }
        }

        loop {
            match providers_rx.try_recv() {
                Ok(snap) => app.set_plans(snap.plans, snap.error, snap.ready),
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => break,
            }
        }

        loop {
            match git_rx.try_recv() {
                Ok(snap) => app.set_git(snap.churn, snap.untracked, snap.roots, snap.error),
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => break,
            }
        }

        // The git prober only looks where the fleet is actually working.
        let cwds = app.session_cwds();
        if cwds != sent_cwds {
            let _ = git_cwd_tx.send(cwds.clone());
            sent_cwds = cwds;
        }

        terminal.draw(|frame| draw::draw(frame, &mut app))?;

        if event::poll(Duration::from_millis(60))? {
            if let Event::Key(key) = event::read()? {
                done = handle_key(&mut app, key, terminal.size()?.width);
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
    fn enter_never_discards_or_claims_to_send_a_draft() {
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
        assert_eq!(
            app.composer_notice.as_deref(),
            Some("Sending is not wired; draft was not sent.")
        );
    }

    #[test]
    fn escape_cancels_and_clears_a_draft() {
        let mut app = App::new(Take::Now);
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
    fn enter_outside_a_draft_view_does_not_capture_input() {
        let mut app = App::new(Take::Horizon);

        assert!(!handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
            85,
        ));
        assert!(!app.composing);
        assert_eq!(
            app.composer_notice.as_deref(),
            Some("Draft editor is available in Now or Twin; nothing was sent.")
        );
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
        assert_eq!(app.take, Take::Grid);
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
