# Spec: `<DataTable>` consolidation for the Scout web UI

**Date:** 2026-05-15
**Author:** ranger.mission-control-ux.mini (handing off to codex)
**Status:** spec — ready for implementation
**Scope:** `packages/web/client` only

## Background

The web UI currently has four table flavors with overlapping concerns:

| Surface | CSS class | Resize | Sort | Hover-card | Notes |
| --- | --- | --- | --- | --- | --- |
| `AtopView` | `.s-atop-table` | yes (`useResizableColumns`) | yes (custom) | no | Recently fixed: sort target split from `<th>`, resize handle widened to 12px, faint indicator always visible, `width: max-content` so resize doesn't redistribute siblings. |
| `SessionsScreen` | `.s-atop-table` (shared) | yes (same hook) | no | no | Inherits the fixes above for free. |
| `OpsAgentsView` | `.s-ops-agents-table` | no | no | yes (`useAgentHoverCard`) | Panel-family surface: `surface 96%` bg, `ink 7%` border, 12px radius, inner-top highlight. |
| `RunsView` | `.s-runs-table` | no | no | no | Hand-rolled, third style. |
| `SettingsScreen` peers | `.sys-peers-table` | no | no | no | Tiny one-off; out of scope. |

The patterns are good in isolation but inconsistent across the app. The right time to consolidate is now, before a fifth table appears.

## Goal

Ship a single `<DataTable>` component that all current and future tabular surfaces use, owning:

- Column header structure (sort button, resize handle, sortability indicator).
- Sticky `<th>` and a panel-family surface treatment that matches `.sys-panel` / `.agent-card`.
- Optional resize via `useResizableColumns`.
- Optional sort with sane defaults (numeric/time desc, text asc).
- Optional hover-card integration via `useAgentHoverCard` for agent-bearing rows.
- Optional row click handler.
- A predictable empty state.

Each consuming screen supplies column defs and row renderers. Visual + interaction behavior lives in the shared component.

## Non-goals

- Do not redesign data shape, filters, or screen-level toolbars. Tables only.
- Do not change `SettingsScreen` peers table (sized differently, separate concerns).
- Do not introduce a runtime CSS-in-JS or a heavy table lib. Keep it plain CSS in
  `client/components/DataTable/data-table.css` plus a small TS module.
- Do not add column hide/show, multi-sort, or grouping in this pass. Single-sort
  with a stable secondary tiebreak is enough.

## Component shape

New files:

```
client/components/DataTable/
  DataTable.tsx
  data-table.css
  useDataTable.ts          (optional — only if sort/resize state grows beyond one component)
```

### API sketch

```ts
export type ColumnAlign = "left" | "right";
export type ColumnKind = "text" | "number" | "time" | "custom";

export type DataTableColumn<Row, K extends string = string> = {
  key: K;
  label: string;
  tip?: string;
  align?: ColumnAlign;            // default by kind: number/time → right, text → left
  kind?: ColumnKind;              // drives default sort direction + alignment
  sortable?: boolean;             // default true unless kind === "custom"
  resizable?: boolean;            // default true
  defaultWidth: number;
  minWidth?: number;
  maxWidth?: number;
  cls?: string;                   // extra class for the column's <td>/<th>
  render: (row: Row) => React.ReactNode;
  /** Optional accessor for sort comparison. Falls back to render output via String(). */
  sortValue?: (row: Row) => string | number | null;
};

export type DataTableProps<Row, K extends string = string> = {
  rows: Row[];
  columns: DataTableColumn<Row, K>[];
  /** Stable id per row — keys React reconciliation and hover anchors. */
  rowId: (row: Row) => string;
  /** localStorage key for resize state; omit to skip persistence. */
  storageKey?: string;
  /** Initial sort. Direction defaults from column.kind. */
  initialSort?: { key: K; dir?: 1 | -1 };
  /** Secondary tiebreak applied after the active sort. */
  secondarySort?: (a: Row, b: Row) => number;
  /** Callback for row click; omit to make rows non-interactive. */
  onRowClick?: (row: Row) => void;
  /**
   * Optional hover-card integration. When provided, each row is bound with
   * `bindings(rowId)` and the row gets active/pinned classes via `state(rowId)`.
   * Caller renders the card itself (e.g. via useAgentHoverCard().card).
   */
  rowBindings?: (id: string) => Record<string, unknown>;
  rowState?: (id: string) => { isActive: boolean; isPinned: boolean };
  /** Empty state. */
  empty?: { title: string; body?: string };
  /** Optional row className modifier. */
  rowClassName?: (row: Row) => string | undefined;
  /** Optional dense/comfortable density. Default "comfortable". */
  density?: "compact" | "comfortable";
  className?: string;
  ariaLabel?: string;
};
```

Return: a single React component that renders the wrap + table + thead + tbody.

### Internal behavior

1. **Resize** — consume `useResizableColumns({ storageKey, columns })`. Apply via
   `getColumnProps` to each `<th>` (inline width/minWidth/maxWidth). Drop the
   `<span>` handle inside the `<th>` as the LAST child. Table is
   `width: max-content; min-width: 100%`. Wrap is `overflow: auto`. No per-class
   widths in the CSS — widths come exclusively from the hook.
2. **Sort target separation** — the `<th>` itself has no `onClick`. Inside it,
   render `<button class="dt-th-sort">` with the label + arrow. Resize handle
   sits at `right: 0` with `z-index: 2`. Cursor on the th is default.
3. **Sort arrow** — always render the arrow span. Idle: faint `↕`. Active: bright
   `↑`/`↓` in accent. First click defaults: `kind: "text"` → asc, `kind: "number" | "time"` → desc.
4. **Hover card bindings** — when `rowBindings` is provided, spread its return
   onto the `<tr>`. When `rowState(id).isActive`, add `dt-row--active`. When
   `isPinned`, add `dt-row--pinned`. Row click also calls `onRowClick` if both
   are supplied; caller decides whether to navigate or pin.
5. **Density** — `comfortable` defaults to 8px vertical padding, 12px horizontal;
   `compact` to 6px / 10px.
6. **Accessibility** — `<table>` carries `aria-label`, headers expose
   `aria-sort` (none/ascending/descending), resize handles are `role="separator"`
   (already in the hook), focusable rows get `tabIndex={0}`.

## Visual contract

The shared visual must read as one material across the app. Tokens are scoped to
`[data-scout-theme]`. CSS goes in `client/components/DataTable/data-table.css`.

- Wrap (`.dt-wrap`): `background: color-mix(in srgb, var(--surface) 96%, transparent)`,
  `border: 1px solid color-mix(in srgb, var(--ink) 7%, transparent)`,
  `border-radius: 12px`,
  inner top highlight: `box-shadow: inset 0 1px 0 color-mix(in srgb, var(--ink) 5%, transparent)`,
  `overflow: auto`.
- Header (`.dt-table thead th`): sticky top, `background: color-mix(in srgb, var(--surface) 98%, transparent)`,
  `border-bottom: 1px solid color-mix(in srgb, var(--ink) 7%, transparent)`,
  uppercase 9.5px label, letter-spacing 0.14em, color `var(--muted)`.
- Sort button (`.dt-th-sort`): `display: inline-flex`, fills `calc(100% - 14px)`,
  leaves a clear lane for the resize handle. Idle arrow color
  `color-mix(in srgb, var(--ink) 22%, transparent)`. Active arrow `var(--accent)`.
- Body cells (`.dt-table tbody td`): `padding: 8px 12px` (comfortable) /
  `6px 10px` (compact), `border-bottom: 1px solid color-mix(in srgb, var(--ink) 4%, transparent)`,
  numeric/time cells right-aligned with `font-variant-numeric: tabular-nums`.
- Row hover / `dt-row--active`: `background: color-mix(in srgb, var(--ink) 5%, transparent)`,
  text color `var(--ink)`.
- Row pinned (`dt-row--pinned`): `background: color-mix(in srgb, var(--accent) 6%, transparent)`.
  No vertical accent bar.
- Resize handle: reuse the existing
  `client/components/ResizableTable/resizable-columns.css` styles — already
  finalized at 12px hit-target with a faint indicator at rest.

## Migration sequence

Ship in four atomic PR-sized commits, in this order:

1. **Add the component**
   - `client/components/DataTable/DataTable.tsx` + `data-table.css`.
   - No callers yet. Type-check clean.

2. **Port `OpsAgentsView`**
   - Hardest because it already has the panel-family treatment + hover card.
   - Use `useAgentHoverCard({ agents, orderedIds, navigate, selectMode: "preview" })`
     in the parent, pass `bindings` + `state` into `<DataTable>`. Render
     `hover.card` after the table.
   - Drop bespoke styles in `ops-agents.css` for `.s-ops-agents-table*` and
     `.s-ops-agents-row*`. Keep ancillary chrome (rail, hero, stats) styles.
   - Acceptance: hover/pin/keyboard behavior identical to today; visuals
     identical or better.

3. **Port `AtopView`**
   - The current best-in-class for sort + resize. Migrate column defs to
     `DataTableColumn[]`, drop the inline `<AgentTable>` component (keep the
     status-promotion secondary sort via `secondarySort` prop).
   - Hover card: AtopView is process/session-keyed, NOT agent-keyed. Do NOT
     wire `useAgentHoverCard` here in this pass — sessions need their own
     detail card (out of scope).
   - Drop `s-atop-table*` styles that overlap with `dt-*` — keep filter bar,
     summary, and harness chip styles.

4. **Port `SessionsScreen`**
   - Trivial port — it already shares CSS with Atop. Drop the manual `<table>`
     and the `useResizableColumns` call in favor of `<DataTable>`. No sort
     needed (`columns[*].sortable = false`).
   - Skip RunsView for this pass unless time permits — it's a different shape
     (flights/work items, not agents/sessions).

Each step ends in a working state: type-check passes, the affected screen
renders, the previous visual + interaction contract is preserved or improved.

## Acceptance criteria

- `bunx tsc --noEmit` returns zero new errors in `client/`.
- `/ops/atop`: column resize is free (no recenter), sort target is the inner
  button only, faint `↕` on idle columns, bright `↑`/`↓` on the active column,
  resize edge faintly visible at rest, status-promotion secondary sort
  preserved.
- `/sessions`: resize works as on Atop, no regressions in filtering/keyboard
  selection.
- `/ops/agents`: hover card, click-to-pin, arrow-key scan, `o` to open, Esc to
  clear — all identical to today. Visual surface unchanged.
- No vertical accent strip on pinned rows on any surface.
- No bespoke `width:` declarations on `.s-atop-col-*` / `.s-ops-agents-col-*` —
  widths come from the hook.

## Constraints / known traps

- **CSS variables resolve only inside `[data-scout-theme]`**. The hover card
  already portals into that wrapper (`useAgentHoverCard` does
  `document.querySelector("[data-scout-theme]") ?? document.body`). Keep this
  pattern for anything that uses `color-mix(... var(--surface) ...)` outside
  the normal tree.
- Table must be `table-layout: fixed`. Without it, body cells drift relative
  to header cells under `table-layout: auto`.
- Wrap must be `width: max-content; min-width: 100%`. `width: 100%` causes the
  "resize redistributes siblings" problem.
- Sort button must own `padding`; the `<th>` must not. Hit-area is the button,
  not the cell. The resize handle has `z-index: 2` so it wins on the right
  edge.
- Body mention parsing: when you `scout send` follow-up status, use `--to ...`
  and never inline `@names` in the body. (See
  `feedback_scout_in_body_at_strip.md`.)

## References

Current source files for reference, not for copy-paste:

- `client/screens/AtopView.tsx` — the gold-standard sort + resize.
- `client/components/ResizableTable/useResizableColumns.ts` — keep using.
- `client/components/ResizableTable/resizable-columns.css` — keep using.
- `client/components/useAgentHoverCard.tsx` — hover/pin/portal pattern.
- `client/components/AgentDetailCard.tsx` — visual reference for surface tone.
- `client/screens/ops-agents.css` — visual reference for panel-family surface.
- `client/screens/system-surfaces-redesign.css` — `.sys-panel` baseline.

## Out of scope for this pass

- `RunsView` port (different domain shape, defer to follow-up).
- `SettingsScreen` peers table (small, separate context).
- Session-keyed hover card (needs a `SessionDetailCard` + `useSessionHoverCard` — separate spec).
- Column visibility toggles, multi-sort, virtualization, infinite scroll.

## How to report back

Reply in the same DM. Include:

- Branch + commit list.
- Screenshots or short notes for `/ops/atop`, `/sessions`, `/ops/agents` after
  the port.
- Any spec drift (with reason) or constraints that turned out wrong.
