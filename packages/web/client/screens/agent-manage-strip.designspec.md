# Agent profile — Manage strip redesign spec

Design pass for the four management actions (Switch profile · Repair registration · Hide stale / Retire · Open / edit config) on the Agent profile tab. **Spec only — for Codex to implement.**

- Component: `AgentManagementStrip` — `packages/web/client/screens/AgentsScreen.tsx:1362`
- Styles: `.s-profile-management*` — `packages/web/client/screens/agents-screen.css:431`
- Reference route: `…/agents/missionwriter.master.arachs-mac-mini-local?tab=profile`

Tokens in play (from `styles/tokens.css`): space 3xs 2 · 2xs 4 · xs 6 · sm 8 · md 10 · lg 12 · xl 14 · 2xl 16 · 3xl 20; text 2xs 9 · xs 10 · sm 11 · md 12; radius sm 4 · md 6 · lg 8. Colors `--ink --muted --dim --border --surface --bg --accent --green --amber --red`.

---

## 1. What's wrong in the screenshot (and why)

1. **Four equal bordered fill-boxes = a nested-card cluster.** Each `.s-profile-management-card` is `min-height:72px`, `border:1px`, `background: ink 3%`, `radius-md`. Four of them sitting on the profile surface reads as cards-on-a-card — exactly the look the brief rules out.
2. **Mixed click semantics behind identical chrome.** Box 1 (Switch profile) is a *container* whose inner pills are the buttons; boxes 2–4 are *themselves* buttons (`card--button`). Same box, two behaviors — the user can't tell what's clickable.
3. **Bulky two-line stack.** Every action carries a `title` + `detail` line, forcing 72px height and a lot of vertical spend on an operational console.
4. **Detail subtext is mostly filler/low-contrast** — "Refresh setup", "Remove from fleet", a dim config path. It competes with the titles and adds noise without adding signal.
5. **Destructive action is camouflaged.** Retire looks identical to Open config — no danger affordance on the one irreversible-ish control.
6. **The widest, most prominent slot is a dead control for single-profile agents** — Switch profile renders a *disabled* box showing the active harness. Prime real estate spent on "you can't do this here."
7. **State is illegible at a glance.** Whether the agent is normal / stale / retired / repairable is buried in the morphing button labels and a small right-aligned status string.

---

## 2. Target model: an operator toolbar, not a card row

Replace the 4-card grid with **one flush toolbar band**: a label rail on the left, inline low-chrome actions, and the destructive action pushed to the right and visually separated. At rest the controls are quiet text+icon; chrome (border/fill) appears only on hover/focus. This is dense, terminal-native, and removes every box.

### Desktop (≥1080px) — single row

```
MANAGE  active claude · ~/…/missionwriter/.scout/agent.json
┌───────────────────────────────────────────────────────────────────────────┐  ← hairline top rule only
  Profile [ claude · codex ]    ⟳ Repair    ⧉ Config              │  ⊘ Retire
└───────────────────────────────────────────────────────────────────────────┘  ← hairline bottom rule only
        └ segmented, current filled   └ neutral toolbar buttons   │   └ danger, right-aligned
```

- **No container border, no radius, no fill.** The band is defined by a single `border-top` hairline (and the existing section rhythm below it), not a box. Optional: a near-invisible `background: color-mix(in srgb, var(--ink) 2%, transparent)` if a faint group tint is wanted — but only one surface, flush, never floating/rounded.
- **One state line**, right of the `MANAGE` eyebrow, replaces all four per-card `detail` strings. It is the single authoritative state read (see §4).
- **Order = priority:** Profile → Repair → Config … then `margin-left:auto` gap … `│` divider … Retire.

### Mobile (<960px) — two compact rows, still all-visible

```
MANAGE · active claude
[ claude · codex ]                         ← profile control, full-width segmented (or static value)
⟳ Repair   ⧉ Config            ⊘ Retire     ← wrap row of icon+label chips, retire kept distinct
```

- Do **not** reuse the current `grid-template-columns: minmax(0,1fr)` single-column stack — that produces four full-width 72px slabs, the heaviest possible mobile form. Use `flex-wrap: wrap; gap: var(--space-xs)` with compact chips.
- Keep ≥44px touch targets via vertical padding / a transparent hit-area, while the *visual* height stays ~30px.
- Never collapse into a kebab/menu/drawer — all four stay on the tab.

---

## 3. Interaction model — switchable vs single-profile

The distinction must be communicated by **affordance, not a disabled button.** A greyed button reads as "temporarily off"; single-profile is *structural*.

- **Switchable** (`management.canSwitchHarness` && alternates exist):
  - Render a **segmented control** of harnesses. Current = filled segment (`accent 12%` bg, accent text); alternates = transparent + muted, clickable.
  - Click alternate → `switch` action with inline busy text ("Switching…") on that segment; the row is `aria-busy` while pending.
  - Switching restarts the agent — keep the existing behavior, but surface the consequence in the segment `title` ("Switch to codex — restarts the agent").
  - >2 alternates: keep current visible as a chip + a compact dropdown for the rest; current never hides.
- **Single-profile** (`!canSwitchHarness` or no alternates):
  - Render a **static value**, not a control: `Profile` (dim mono caps micro) + `claude` (ink). No border, no hover, `cursor: default`. Absence of affordance *is* the message. Optional `title="Single-profile agent"`.

---

## 4. Copy / label hierarchy by state

**State line** (shared, right of `MANAGE` — the one place state is named):

| State | State line | Dot |
|---|---|---|
| normal | `active claude` | — |
| repairable | `registration needs repair` | amber |
| stale local | `stale local registration` | amber |
| retired | `retired · replaced by missionwriter.codex` (link if `replacedByAgentId`) | dim |
| non-editable | append ` · runtime-defined` to the active line | — |

**Per-action labels** (tooltip carries the detail that used to be a second line):

- **Profile** — switchable: segmented `claude · codex`; single: static `Profile claude`.
- **Repair** — render only when `canRepair`. Label `Repair`; tooltip "Re-register with the broker." When not repairable, **omit it** (don't show a 0.48-opacity dead slot). Show disabled-with-reason only while a repair is mid-flight.
- **Config** — editable: `Open config`, tooltip = full path. Non-editable: `View config` (or disabled `Config`, tooltip "Runtime-defined — no editable config"). Never show a raw path as visible body text; it lives in the tooltip / state line.
- **Retire / stale** — single morphing danger control:
  - normal → `Retire` (danger affordance), tooltip "Remove from the visible fleet."
  - `staleLocalRegistration` → `Hide stale`, tooltip "Superseded local route — hide it." (lighter weight than Retire; it's hiding a dead entry, not retiring a live one.)
  - `retiredFromFleet` → `Retired ✓`, inert/dim; if `replacedByAgentId`, show `→ replacement` as the only live affordance.

Keep the existing `window.confirm` on Retire; Hide-stale can skip confirm (reversible-ish, just unhides).

---

## 5. CSS / layout guidance (implementation-ready)

**Strongest recommendation: drop the bespoke `s-profile-management-card*` classes and compose from existing primitives** (`primitives.css` already has `.btn`, `.btn--sm`, `.btn--mono`, `.btn--danger`, `.chip`, `.dot--warning`). That alone removes the card look and keeps the page consistent. New classes below only for the bits primitives don't cover.

```css
/* Container: a flush band, NOT a card. */
.s-manage {
  margin-top: var(--space-2xl);
  padding: var(--space-md) 0;
  border-top: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
  /* no background, no border-radius, no side/bottom border */
}
.s-manage-head {            /* MANAGE eyebrow + state line */
  display: flex; align-items: baseline; gap: var(--space-sm);
  margin-bottom: var(--space-sm);
}
.s-manage-label {           /* reuse label-md vibe */
  font-size: var(--text-2xs); letter-spacing: var(--tracking-xl);
  text-transform: uppercase; color: var(--dim);
}
.s-manage-state { font-size: var(--text-xs); color: var(--muted); min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.s-manage-bar {             /* the action row */
  display: flex; align-items: center; gap: var(--space-md); flex-wrap: wrap;
}

/* Toolbar button — quiet at rest, chrome on interaction. ~30px, single line. */
.s-manage-btn {
  display: inline-flex; align-items: center; gap: var(--space-2xs);
  height: 30px; padding: 0 var(--space-md);
  border: 1px solid transparent; border-radius: var(--radius-sm);
  background: transparent; color: var(--muted);
  font-size: var(--text-sm); line-height: 1; cursor: pointer;
  transition: background .12s, border-color .12s, color .12s;
}
.s-manage-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--ink) 5%, transparent);
  border-color: color-mix(in srgb, var(--border) 70%, transparent);
  color: var(--ink);
}
.s-manage-btn:focus-visible { outline: 1px solid color-mix(in srgb, var(--accent) 60%, transparent); outline-offset: 1px; }
.s-manage-btn .icon { color: var(--dim); width: 13px; height: 13px; }

/* Destructive — pushed right, separated, danger affordance. */
.s-manage-btn--danger { margin-left: auto; }
.s-manage-btn--danger:hover:not(:disabled) {
  color: var(--red);
  background: color-mix(in srgb, var(--red) 8%, transparent);
  border-color: color-mix(in srgb, var(--red) 30%, transparent);
}
/* optional divider before the danger action */
.s-manage-sep { width: 1px; align-self: stretch; margin: var(--space-3xs) 0;
  background: color-mix(in srgb, var(--border) 50%, transparent); }

/* Static (single-profile / inert) — a value, not a control. */
.s-manage-value { display: inline-flex; align-items: baseline; gap: var(--space-2xs);
  color: var(--muted); cursor: default; }
.s-manage-value-k { font-size: var(--text-2xs); letter-spacing: var(--tracking-md);
  text-transform: uppercase; color: var(--dim); }
.s-manage-value-v { font-size: var(--text-sm); color: var(--ink); }

/* Segmented profile switch — hairline group, current filled. */
.s-manage-seg { display: inline-flex; border: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
  border-radius: var(--radius-sm); overflow: hidden; height: 28px; }
.s-manage-seg button { height: 100%; padding: 0 var(--space-sm); border: 0; background: transparent;
  color: var(--muted); font-size: var(--text-sm); cursor: pointer; }
.s-manage-seg button[aria-pressed="true"] {
  background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--accent); }
.s-manage-seg button + button { border-left: 1px solid color-mix(in srgb, var(--border) 60%, transparent); }
```

Responsive — align to the page's existing breakpoints (1080 / 959):

```css
@media (max-width: 1080px) {
  .s-manage-bar { gap: var(--space-sm); }       /* still one wrapping row */
}
@media (max-width: 959px) {
  .s-manage-bar { gap: var(--space-xs); }
  .s-manage-seg { width: 100%; flex-basis: 100%; }   /* profile control to its own row */
  .s-manage-seg button { flex: 1; }
  .s-manage-btn { height: 32px; padding-top: 7px; padding-bottom: 7px; } /* ≥44px hit area via padding */
  .s-manage-btn--danger { margin-left: 0; }     /* let it wrap; stays last + danger-tinted */
  .s-manage-sep { display: none; }
}
```

Net change: `min-height:72px` cards → `~30px` toolbar buttons; four borders+fills → zero at rest; two-line stacks → one line + tooltip + one shared state line. Same actions, ~60% less vertical space, no card-on-card.

---

## 6. Build checklist for Codex

1. Replace the `.s-profile-management-grid` of `.s-profile-management-card`s with the `.s-manage` band (label + state line + single `.s-manage-bar`).
2. Profile: branch on `canSwitchHarness && alternates.length` → `.s-manage-seg` (switchable) vs `.s-manage-value` (single). No disabled button for single-profile.
3. Repair: render only when `canRepair`; otherwise omit.
4. Config: `Open config` / `View config`; move the path into `title`, not visible body.
5. Retire: `.s-manage-btn--danger`, `margin-left:auto`, label morphs Retire / Hide stale / Retired by state; keep confirm on Retire.
6. Collapse all four `detail` strings into the single `.s-manage-state` line per §4.
7. Reuse `primitives.css` `.btn--sm`/`.btn--danger`/`.chip`/`.dot--warning` where they already fit instead of new classes.
8. Verify at ≥1080, 960–1080, and <960; confirm 44px touch targets and that no action is ever hidden behind a menu.

Everything here keeps the actions immediately visible and operator-grade; it only removes the card weight and the mixed-affordance ambiguity.
