import { useEffect, useState } from "react";
import { GO_SHORTCUTS } from "../lib/go-shortcuts.ts";
import { isEditableTarget, useFocusTrap } from "../lib/keyboard-nav.ts";
import {
  NEW_CHAT_LEGACY_SHORTCUT_KEYS,
  NEW_CHAT_SHORTCUT_KEYS,
  NEW_TASK_ACTION_LABEL,
} from "../lib/new-chat-shortcut.ts";
import "./keyboard-help.css";

type KeyChord = readonly string[];
type Binding = { chords: readonly KeyChord[]; label: string };
type Group = { title: string; bindings: Binding[] };

const chord = (...keys: string[]): KeyChord => keys;

const GROUPS: Group[] = [
  {
    title: "App shell",
    bindings: [
      { chords: [NEW_CHAT_SHORTCUT_KEYS, NEW_CHAT_LEGACY_SHORTCUT_KEYS], label: NEW_TASK_ACTION_LABEL },
      { chords: [chord("⌘", "K")], label: "Command palette" },
      { chords: [chord("⌘", "["), chord("⌘", "B")], label: "Toggle sidebar / left panel" },
      { chords: [chord("⌘", "]")], label: "Toggle right panel" },
      { chords: [chord("⌘", "⇧", "]")], label: "Toggle inspector overlay" },
      { chords: [chord("Ctrl", "`")], label: "Toggle terminal drawer" },
      { chords: [chord("⌘", "J")], label: "Toggle assistant drawer" },
    ],
  },
  {
    title: "Navigation",
    bindings: GO_SHORTCUTS.map((shortcut) => ({
      chords: [chord("g", shortcut.key)],
      label: shortcut.label,
    })),
  },
  {
    title: "Global",
    bindings: [
      { chords: [chord("?")], label: "Toggle this help" },
      { chords: [chord("Esc")], label: "Close dialog / clear search" },
      { chords: [chord("Tab"), chord("⇧", "Tab")], label: "Move focus" },
      { chords: [chord("[")], label: "Focus previous pane" },
      { chords: [chord("]")], label: "Focus next pane" },
    ],
  },
  {
    title: "Lists",
    bindings: [
      { chords: [chord("↓"), chord("j")], label: "Next item" },
      { chords: [chord("↑"), chord("k")], label: "Previous item" },
      { chords: [chord("g"), chord("Home")], label: "First item" },
      { chords: [chord("G"), chord("End")], label: "Last item" },
      { chords: [chord("Enter")], label: "Open / activate" },
    ],
  },
  {
    title: "Search",
    bindings: [
      { chords: [chord("/")], label: "Focus filter input" },
      { chords: [chord("↓")], label: "From filter → first match" },
      { chords: [chord("Esc")], label: "Clear filter (while focused)" },
    ],
  },
  {
    title: "Composers",
    bindings: [
      { chords: [chord("Enter"), chord("⇧", "Enter")], label: "Insert line break" },
      { chords: [chord("⌘", "Enter"), chord("Ctrl", "Enter")], label: "Send message" },
    ],
  },
  {
    title: "Capture routing",
    bindings: [
      { chords: [chord("Drop")], label: "Drop screenshot/video anywhere" },
      { chords: [chord("⌘", "V")], label: "Paste image into route composer" },
      { chords: [chord("Existing chat"), chord("New session")], label: "Choose delivery in composer" },
    ],
  },
  {
    title: "Dispatch",
    bindings: [
      { chords: [chord("↓"), chord("j")], label: "Next ledger row" },
      { chords: [chord("↑"), chord("k")], label: "Previous ledger row" },
      { chords: [chord("Enter")], label: "Inspect row / open dialogue thread" },
      { chords: [chord("←"), chord("→")], label: "Switch dispatch tabs" },
      { chords: [chord("Esc")], label: "Clear inspector selection" },
    ],
  },
  {
    title: "Agent lanes",
    bindings: [
      { chords: [chord("↓"), chord("j")], label: "Next lane" },
      { chords: [chord("↑"), chord("k")], label: "Previous lane" },
      { chords: [chord("Enter"), chord("i")], label: "Inspect lane" },
      { chords: [chord("1", "…", "4")], label: "Switch trace window (5m → 24h)" },
      { chords: [chord("o")], label: "Open session (detail sheet)" },
      { chords: [chord("t")], label: "Open traces (detail sheet)" },
      { chords: [chord("p")], label: "Agent profile (detail sheet)" },
      { chords: [chord("Esc")], label: "Close detail sheet" },
    ],
  },
  {
    title: "Tail · Atop",
    bindings: [
      { chords: [chord("/")], label: "Open filter (Tail)" },
      { chords: [chord("G")], label: "Jump to live (Tail)" },
      { chords: [chord("j"), chord("k")], label: "Walk rows (Atop)" },
    ],
  },
  {
    title: "Session scrubber",
    bindings: [
      { chords: [chord("←"), chord("→")], label: "Seek ±1%" },
      { chords: [chord("⇧", "←"), chord("⇧", "→")], label: "Seek ±5%" },
      { chords: [chord("Home"), chord("End")], label: "Jump to start / end" },
    ],
  },
];

export function KeyboardHelpOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { ref, onKeyDown } = useFocusTrap<HTMLDivElement>(open);
  if (!open) return null;
  return (
    <div className="kb-help-backdrop" onClick={onClose} role="presentation">
      <div
        ref={ref}
        className="kb-help-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="kb-help-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        tabIndex={-1}
      >
        <header className="kb-help-head">
          <h2 id="kb-help-title" className="kb-help-title">Keyboard shortcuts</h2>
          <button
            type="button"
            className="kb-help-close"
            onClick={onClose}
            aria-label="Close (Esc)"
          >
            ✕
          </button>
        </header>
        <div className="kb-help-grid">
          {GROUPS.map((g) => (
            <section key={g.title} className="kb-help-group">
              <h3 className="kb-help-group-title">{g.title}</h3>
              <dl className="kb-help-list">
                {g.bindings.map((b, i) => (
                  <div key={`${g.title}-${i}`} className="kb-help-row">
                    <dt className="kb-help-keys">
                      {b.chords.map((keys, chordIndex) => (
                        <span key={`${chordIndex}-${keys.join("+")}`} className="kb-help-chord-wrap">
                          {chordIndex > 0 && <span className="kb-help-or">or</span>}
                          <span className="kb-help-chord">
                            {keys.map((key, keyIndex) => (
                              <kbd key={`${key}-${keyIndex}`} className="kb-help-kbd">{key}</kbd>
                            ))}
                          </span>
                        </span>
                      ))}
                    </dt>
                    <dd className="kb-help-label">{b.label}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <footer className="kb-help-foot">
          Press <kbd className="kb-help-kbd">?</kbd> to toggle · <kbd className="kb-help-kbd">Esc</kbd> to close
        </footer>
      </div>
    </div>
  );
}

export function useKeyboardHelp() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) {
        e.preventDefault();
        setOpen(false);
        return;
      }
      if (e.key !== "?") return;
      if (isEditableTarget(e.target)) return;
      e.preventDefault();
      setOpen((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  return { open, setOpen };
}
