/**
 * RuntimePicker — harness · model · effort as a single composer chip.
 *
 * Converged with the studio atom (`design/studio/components/RuntimePicker.tsx`):
 * one control whose collapsed state is the argument — the harness is a mark,
 * not a word; once the glyph is there, writing its name beside it is redundant.
 * The resting chip is `◈ Opus 5 · MEDIUM ⌄` and everything else lives one
 * click away. Effort carries a tone as well as a word, because it is ordinal
 * and the eye should be able to skip reading it.
 *
 * Data lives in `lib/runtime-catalog.ts`, never here. Harness→model→effort
 * reconciliation, effort capability and the free-text escape hatch are catalog
 * semantics; a consumer that swaps the catalog inherits all of them. Callers
 * build the catalog from live data (`runtimeCatalogFromRunnerOptions` /
 * `runtimeCatalogFromCapabilities`) and hold the selection as one
 * `RuntimeValue`:
 *
 *   <RuntimePicker catalog={catalog} value={v} onChange={setV} />
 *   <RuntimePicker catalog={catalog} status="loading" onRetry={refetch} />
 *
 * The panel uses three labelled bands so the runtime reads as one decision
 * with three parts, rather than as an unlabeled two-column browser. Keyboard:
 * manual activation, not selection-follows-focus. Arrows move the cursor,
 * Enter/Space commits. This is deliberate — picking a harness resets the
 * model, so arrowing past `codex` on the way to `grok` must not silently throw
 * away the model you already chose.
 */

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { HarnessMark } from "../HarnessMark.tsx";
import {
  describeRuntime,
  effortsFor,
  harnessFor,
  matchPreset,
  modelsFor,
  orderModelsWithShortlist,
  reconcileRuntime,
  resolveModel,
  runtimeListOriginLabel,
  searchRuntimeOptions,
  seedRuntime,
  valueForPreset,
  type PinnedRuntimeOption,
  type RuntimeCatalog,
  type RuntimeOption,
  type RuntimePreset,
  type RuntimeValue,
} from "../../lib/runtime-catalog.ts";
import "./runtime-picker.css";

export type RuntimeStatus = "ready" | "loading" | "error";

export type RuntimePickerProps = {
  /** Controlled value. Omit to let the picker hold its own state. */
  value?: RuntimeValue;
  /** Seed for uncontrolled use. Missing fields are filled from the catalog. */
  defaultValue?: Partial<RuntimeValue>;
  onChange?: (next: RuntimeValue) => void;
  /** Built from live data — see `runtimeCatalogFromRunnerOptions`. */
  catalog: RuntimeCatalog;
  /** Catalog lifecycle. `loading` and `error` are real states for live data. */
  status?: RuntimeStatus;
  statusMessage?: string;
  onRetry?: () => void;
  onRefreshModels?: () => void;
  refreshingModels?: boolean;
  catalogStatus?: string;
  catalogWarning?: string;
  disabled?: boolean;
  /**
   * Force the effort band on or off. Default follows the harness: a harness
   * with no effort transport doesn't grow a dial that goes nowhere.
   */
  showEffort?: boolean;
  /** `"auto"` shows the model filter once the list outgrows a glance. */
  searchable?: boolean | "auto";
  className?: string;
};

const SEARCH_THRESHOLD = 6;

/**
 * The panel is the editor; the chip is the readout. The editor is allowed to
 * be wider than the thing that opened it — that is the whole point of opening
 * it — and buying that width gives the live harness and model catalogs room to
 * wrap without turning the picker into a tall menu.
 */
const PANEL_W = 400;

/**
 * Cap on the model name in the collapsed chip, in ch (the chip is mono, so
 * ch is exact). There is no reserved minimum — the chip hugs its content at
 * rest; the cap only keeps a pasted model id from stretching the toolbar.
 */
const MODEL_CH_MAX = 14;
/**
 * First-paint guess at the panel's height, used only until the real panel has
 * rendered once and `scrollHeight` can be read — a live catalog makes it
 * taller than this, and the estimate is never a bound.
 */
const PANEL_H_ESTIMATE = 300;
/** The panel never shrinks below this — past it, the bands scroll instead. */
const PANEL_MIN_H = 160;
const GAP = 8;

/** WKWebView-safe viewport height: the visible area, not the layout one. */
function viewportHeight(): number {
  return window.visualViewport?.height ?? window.innerHeight;
}

/**
 * Which side of the chip the panel opens on, and how tall it may grow.
 *
 * Up where the real panel fits above, down where it only fits below, and
 * otherwise on whichever side has more room with the height capped — a panel
 * that cannot fit whole gets `maxHeight` and scrolls its bands rather than
 * running off the edge of the viewport.
 */
export function resolvePanelPlacement(input: {
  rectTop: number;
  rectBottom: number;
  viewportHeight: number;
  panelHeight: number;
  gap: number;
}): { placement: "up" | "down"; maxHeight: number } {
  const roomAbove = input.rectTop - input.gap * 2;
  const roomBelow = input.viewportHeight - input.rectBottom - input.gap * 2;
  // Composer toolbars sit at the foot of the screen, so prefer upward.
  const placement: "up" | "down" =
    input.panelHeight <= roomAbove
      ? "up"
      : input.panelHeight <= roomBelow
        ? "down"
        : roomAbove >= roomBelow ? "up" : "down";
  return {
    placement,
    maxHeight: Math.max(PANEL_MIN_H, placement === "up" ? roomAbove : roomBelow),
  };
}

// ── Roving focus ─────────────────────────────────────────────────────────────

type Group = "preset" | "harness" | "model" | "effort";
const GROUP_ORDER: Group[] = ["preset", "harness", "model", "effort"];

/**
 * Every band lays its options left-to-right. Horizontal arrows move within a
 * band; vertical arrows cross between Harness, Model and Effort.
 */
const ORIENTATION: Record<Group, "vertical" | "horizontal"> = {
  preset: "horizontal",
  harness: "horizontal",
  model: "horizontal",
  effort: "horizontal",
};

export interface PanelCtx {
  value: RuntimeValue;
  catalog: RuntimeCatalog;
  set: (patch: Partial<RuntimeValue>) => void;
  applyPreset: (preset: RuntimePreset) => void;
  status: RuntimeStatus;
  statusMessage?: string;
  onRetry?: () => void;
  harnesses: RuntimeOption[];
  presets: RuntimePreset[];
  models: RuntimeOption[];
  modelsPinned: PinnedRuntimeOption[];
  modelsRest: RuntimeOption[];
  efforts: RuntimeOption[] | null;
  harnessLabel: string;
  searchable: boolean;
  query: string;
  setQuery: (next: string) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
  cell: (group: Group, index: number) => CellProps;
  onSearchKeyDown: (event: React.KeyboardEvent) => void;
}

interface CellProps {
  ref: (el: HTMLElement | null) => void;
  tabIndex: number;
  onKeyDown: (event: React.KeyboardEvent) => void;
  onFocus: () => void;
}

function Chevron() {
  return (
    <svg
      className="s-rt-chip-chevron"
      width="8"
      height="5"
      viewBox="0 0 8 5"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M1 1.2 4 4 7 1.2"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ── Effort ladder ────────────────────────────────────────────────────────────

function EffortLadder({ ctx }: { ctx: PanelCtx }) {
  const { efforts, value, set } = ctx;
  if (!efforts) return null;
  const active = Math.max(
    0,
    efforts.findIndex((step) => step.value === value.effort),
  );
  return (
    <div className="s-rt-ladder" role="radiogroup" aria-label="Reasoning effort">
      {efforts.map((effort, i) => {
        const isCurrent = i === active;
        return (
          <button
            key={effort.value}
            type="button"
            role="radio"
            aria-checked={isCurrent}
            title={effort.note}
            onClick={() => set({ effort: effort.value })}
            {...ctx.cell("effort", i)}
            className="s-rt-step"
          >
            <span
              className="s-rt-step-bar"
              data-state={
                isCurrent ? "current" : i < active ? "filled" : "empty"
              }
            />
            <span className="s-rt-step-label">{effort.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Named, not hidden. A harness with no effort transport gets one line saying
 * so — an absent control with no explanation reads as a bug in the picker.
 */
function EffortAbsent({ harnessLabel }: { harnessLabel: string }) {
  return (
    <p className="s-rt-effort-absent">
      {harnessLabel} has no effort control.
    </p>
  );
}

// ── Bands ────────────────────────────────────────────────────────────────────

function BandHeading({ children }: { children: string }) {
  return <h3 className="s-rt-label">{children}</h3>;
}

/** Filter, not a combobox: the list it filters is always on screen. */
function SearchField({ ctx }: { ctx: PanelCtx }) {
  return (
    <div className="s-rt-search">
      <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true" className="s-rt-search-icon">
        <circle cx="5" cy="5" r="3.4" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <path d="M7.6 7.6 10.5 10.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
      <input
        ref={ctx.searchRef}
        type="text"
        value={ctx.query}
        onChange={(event) => ctx.setQuery(event.target.value)}
        onKeyDown={ctx.onSearchKeyDown}
        placeholder="Filter models"
        aria-label="Filter models"
        spellCheck={false}
        autoComplete="off"
        className="s-rt-search-input"
      />
      {ctx.query ? (
        <button
          type="button"
          onClick={() => {
            ctx.setQuery("");
            ctx.searchRef.current?.focus();
          }}
          aria-label="Clear filter"
          className="s-rt-search-clear"
        >
          clear
        </button>
      ) : null}
    </div>
  );
}

/** Loading, error and empty share one slot so the panel never changes height. */
function ModelStatus({ ctx }: { ctx: PanelCtx }) {
  if (ctx.status === "loading") {
    return (
      <div className="s-rt-status" aria-busy role="status">
        <span className="s-rt-sr">Loading models</span>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            aria-hidden
            className="s-rt-skel"
            style={{ animationDelay: `${i * 90}ms` }}
          />
        ))}
      </div>
    );
  }
  if (ctx.status === "error") {
    return (
      <div role="alert" className="s-rt-status s-rt-status--error">
        <span className="s-rt-status-message">
          {ctx.statusMessage ?? "Model catalog unavailable."}
        </span>
        {ctx.onRetry ? (
          <button type="button" onClick={ctx.onRetry} className="s-rt-retry">
            Retry
          </button>
        ) : null}
      </div>
    );
  }
  return (
    <p className="s-rt-empty">
      {ctx.query.trim() ? `No model matches “${ctx.query.trim()}”.` : "No models listed."}
    </p>
  );
}

/**
 * One named `<harness>[/<model>[/<effort>]]` tuple per chip — the whole
 * runtime decision in one press. The band renders only when the resolved
 * layers produced presets; absent entirely otherwise.
 */
export function PresetOptions({ ctx }: { ctx: PanelCtx }) {
  if (!ctx.presets.length) return null;
  const matched = matchPreset(ctx.catalog, ctx.value);
  return (
    <div className="s-rt-options" role="group" aria-label="Presets">
      {ctx.presets.map((preset, index) => {
        const on = matched?.id === preset.id;
        const harnessLabel =
          harnessFor(ctx.catalog, preset.harness)?.label ?? preset.harness;
        return (
          <button
            key={preset.id}
            type="button"
            aria-pressed={on}
            onClick={() => ctx.applyPreset(preset)}
            data-on={on || undefined}
            title={
              `${preset.harness}/${preset.model ?? "default"}/${preset.effort ?? ""} · ` +
              runtimeListOriginLabel(preset.origin, harnessLabel, "preset")
            }
            {...ctx.cell("preset", index)}
            className="s-rt-opt s-rt-preset-opt"
          >
            <HarnessMark
              harness={preset.harness || "unknown"}
              size={13}
              className="s-rt-opt-mark"
              title={null}
            />
            <span>{preset.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function ModelOptions({ ctx }: { ctx: PanelCtx }) {
  if (ctx.status !== "ready" || ctx.models.length === 0) return <ModelStatus ctx={ctx} />;
  const renderOption = (
    model: RuntimeOption,
    index: number,
    pinnedOrigin?: PinnedRuntimeOption["pinnedOrigin"],
  ) => {
    const on = model.value === ctx.value.model;
    const modelDisabled = model.disabled ?? false;
    return (
      <button
        key={model.value || "default"}
        type="button"
        role="option"
        aria-selected={on}
        /* Kept in the list but unselectable — and still focusable, so the
           reason stays reachable by keyboard and assistive technology. */
        aria-disabled={modelDisabled || undefined}
        onClick={() => {
          if (!modelDisabled) ctx.set({ model: model.value });
        }}
        data-on={on || undefined}
        data-disabled={modelDisabled || undefined}
        data-pinned={pinnedOrigin ? "" : undefined}
        title={
          pinnedOrigin
            ? runtimeListOriginLabel(pinnedOrigin, ctx.harnessLabel)
            : model.note
        }
        {...ctx.cell("model", index)}
        style={{ animationDelay: `${Math.min(index, 6) * 16}ms` }}
        className="s-rt-opt s-rt-model-opt"
      >
        {model.label}
      </button>
    );
  };
  return (
    <div
      key={ctx.value.harness}
      role="listbox"
      aria-label="Model"
      className="s-rt-models"
    >
      {ctx.modelsPinned.map((model, index) => renderOption(model, index, model.pinnedOrigin))}
      {ctx.modelsPinned.length > 0 && ctx.modelsRest.length > 0 ? (
        <span className="s-rt-models-rule" role="separator" />
      ) : null}
      {ctx.modelsRest.map((model, index) =>
        renderOption(model, ctx.modelsPinned.length + index))}
    </div>
  );
}

// ── Root ─────────────────────────────────────────────────────────────────────

export function RuntimePicker({
  value: controlledValue,
  defaultValue,
  onChange,
  catalog,
  status = "ready",
  statusMessage,
  onRetry,
  onRefreshModels,
  refreshingModels = false,
  catalogStatus,
  catalogWarning,
  disabled = false,
  showEffort,
  searchable = "auto",
  className,
}: RuntimePickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [uncontrolled, setUncontrolled] = useState<RuntimeValue>(() =>
    seedRuntime(catalog, defaultValue),
  );
  const value = controlledValue ?? uncontrolled;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const panelId = useId();

  const set = useCallback(
    (patch: Partial<RuntimeValue>) => {
      const next = reconcileRuntime(catalog, value, patch);
      if (controlledValue === undefined) setUncontrolled(next);
      onChange?.(next);
      // A new harness means a new list; a stale filter would hide all of it.
      if (patch.harness !== undefined && patch.harness !== value.harness) setQuery("");
    },
    [catalog, controlledValue, onChange, value],
  );

  /**
   * A preset is the whole tuple in one commit — reconcile it against the
   * current value so an effort the ladder lacks clamps, then take the same
   * commit path as `set`.
   */
  const applyPreset = useCallback(
    (preset: RuntimePreset) => {
      const next = valueForPreset(catalog, preset, value);
      if (controlledValue === undefined) setUncontrolled(next);
      onChange?.(next);
      if (next.harness !== value.harness) setQuery("");
    },
    [catalog, controlledValue, onChange, value],
  );

  const harnesses = catalog.harnesses;
  const presets = catalog.presets ?? [];
  const allModels = useMemo(
    () => modelsFor(catalog, value.harness),
    [catalog, value.harness],
  );
  /**
   * A model the catalog has never heard of is still about to run, so it joins
   * the list rather than being silently replaced by "Default" on screen.
   */
  const withCustom = useMemo(() => {
    const custom = resolveModel(catalog, value);
    if (custom.note !== "custom") return allModels;
    return [...allModels, custom];
  }, [allModels, catalog, value]);
  /**
   * Pin-first, never hide: shortlisted models for this harness lead, then a
   * divider, then the rest of the list in catalog order. The filter applies
   * to both halves so a query still narrows the whole band.
   */
  const { pinned, rest } = useMemo(
    () => orderModelsWithShortlist(withCustom, catalog.shortlist, value.harness),
    [withCustom, catalog.shortlist, value.harness],
  );
  const modelsPinned = useMemo(
    () => searchRuntimeOptions(pinned, query) as PinnedRuntimeOption[],
    [pinned, query],
  );
  const modelsRest = useMemo(
    () => searchRuntimeOptions(rest, query),
    [rest, query],
  );
  const models = useMemo(
    () => [...modelsPinned, ...modelsRest],
    [modelsPinned, modelsRest],
  );
  const catalogEfforts = effortsFor(catalog, value.harness, value.model);
  const efforts = showEffort === false ? null : showEffort === true
    ? (catalogEfforts ?? catalog.efforts)
    : catalogEfforts;
  const isSearchable =
    searchable === "auto" ? withCustom.length > SEARCH_THRESHOLD : searchable;

  const description = describeRuntime(catalog, value);
  /**
   * An exact preset match reads as its name — the operator chose "Fusion",
   * not a coincidental tuple — while effort stays the live value's own rung.
   */
  const chipModelLabel = matchPreset(catalog, value)?.label ?? description.modelLabel;

  // ── Roving focus ───────────────────────────────────────────────────────────

  const cells = useRef(new Map<string, HTMLElement>());
  const [cursor, setCursor] = useState<{ group: Group; index: number }>({
    group: "model",
    index: 0,
  });

  const counts = useMemo<Record<Group, number>>(
    () => ({
      preset: presets.length,
      harness: harnesses.length,
      model: status === "ready" ? models.length : 0,
      effort: efforts?.length ?? 0,
    }),
    [efforts?.length, harnesses.length, models.length, presets.length, status],
  );

  const selectedIndex = useCallback(
    (group: Group) => {
      if (group === "preset") {
        const hit = matchPreset(catalog, value);
        return Math.max(0, presets.findIndex((p) => p.id === hit?.id));
      }
      if (group === "harness") {
        return Math.max(0, harnesses.findIndex((h) => h.value === value.harness));
      }
      if (group === "model") {
        return Math.max(0, models.findIndex((m) => m.value === value.model));
      }
      return Math.max(0, efforts?.findIndex((e) => e.value === value.effort) ?? 0);
    },
    [catalog, efforts, harnesses, models, presets, value],
  );

  const focusCell = useCallback((group: Group, index: number) => {
    setCursor({ group, index });
    cells.current.get(`${group}:${index}`)?.focus();
  }, []);

  const focusGroup = useCallback(
    (from: Group, direction: 1 | -1) => {
      const start = GROUP_ORDER.indexOf(from);
      for (let i = start + direction; i >= 0 && i < GROUP_ORDER.length; i += direction) {
        const group = GROUP_ORDER[i];
        if (counts[group] > 0) {
          focusCell(group, Math.min(selectedIndex(group), counts[group] - 1));
          return true;
        }
      }
      return false;
    },
    [counts, focusCell, selectedIndex],
  );

  const cell = useCallback(
    (group: Group, index: number): CellProps => ({
      ref: (el: HTMLElement | null) => {
        const key = `${group}:${index}`;
        if (el) cells.current.set(key, el);
        else cells.current.delete(key);
      },
      // Exactly one stop per group, so Tab walks groups and arrows walk options.
      tabIndex: cursor.group === group && cursor.index === index ? 0 : -1,
      onFocus: () => setCursor({ group, index }),
      onKeyDown: (event: React.KeyboardEvent) => {
        const vertical = ORIENTATION[group] === "vertical";
        const nextKey = vertical ? "ArrowDown" : "ArrowRight";
        const prevKey = vertical ? "ArrowUp" : "ArrowLeft";
        const nextGroupKey = vertical ? "ArrowRight" : "ArrowDown";
        const prevGroupKey = vertical ? "ArrowLeft" : "ArrowUp";
        const count = counts[group];
        if (count === 0) return;

        // In the model band, the filter is the control immediately above the
        // options. Up reaches it before crossing into the harness band.
        if (group === "model" && event.key === "ArrowUp" && isSearchable) {
          event.preventDefault();
          setCursor({ group, index });
          searchRef.current?.focus();
        } else if (event.key === nextKey) {
          event.preventDefault();
          focusCell(group, (index + 1) % count);
        } else if (event.key === prevKey) {
          event.preventDefault();
          focusCell(group, (index - 1 + count) % count);
        } else if (event.key === nextGroupKey) {
          event.preventDefault();
          focusGroup(group, 1);
        } else if (event.key === prevGroupKey) {
          event.preventDefault();
          focusGroup(group, -1);
        } else if (event.key === "Home") {
          event.preventDefault();
          focusCell(group, 0);
        } else if (event.key === "End") {
          event.preventDefault();
          focusCell(group, count - 1);
        }
      },
    }),
    [counts, cursor, focusCell, focusGroup, isSearchable],
  );

  const onSearchKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "ArrowDown" && counts.model > 0) {
        event.preventDefault();
        focusCell("model", 0);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        focusGroup("model", -1);
      } else if (event.key === "Enter" && counts.model === 1) {
        // One survivor means the filter already made the choice.
        event.preventDefault();
        const only = models[0];
        if (!only.disabled) set({ model: only.value });
      } else if (event.key === "Escape" && query) {
        // Stage one clears the filter; an empty filter lets the panel close.
        event.preventDefault();
        event.stopPropagation();
        setQuery("");
      }
    },
    [counts.model, focusCell, focusGroup, models, query, set],
  );

  // ── Placement ──────────────────────────────────────────────────────────────

  /**
   * The panel renders in a portal on `position: fixed`.
   *
   * It has to: the composer shell clips to its rounded corners, and this
   * control lives in that shell's `tools` slot. An absolutely positioned panel
   * inside it gets cut off at the composer's edge. Portalling also means the
   * picker doesn't care what it is dropped into later.
   */
  const [anchor, setAnchor] = useState<{
    left: number;
    top: number;
    placement: "up" | "down";
    maxHeight: number;
  } | null>(null);

  const measure = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    // The real panel height once it has rendered; the estimate before that.
    const panelHeight = panelRef.current?.scrollHeight ?? PANEL_H_ESTIMATE;
    const { placement, maxHeight } = resolvePanelPlacement({
      rectTop: rect.top,
      rectBottom: rect.bottom,
      viewportHeight: viewportHeight(),
      panelHeight,
      gap: GAP,
    });
    const width = Math.min(PANEL_W, window.innerWidth - GAP * 2);
    const left = Math.min(
      Math.max(GAP, rect.right - width),
      Math.max(GAP, window.innerWidth - width - GAP),
    );
    const next = {
      left,
      top: placement === "up" ? rect.top - GAP : rect.bottom + GAP,
      placement,
      maxHeight,
    };
    // Measure→render→measure is a loop unless an identical reading is a no-op.
    setAnchor((current) =>
      current
        && current.left === next.left
        && current.top === next.top
        && current.placement === next.placement
        && current.maxHeight === next.maxHeight
        ? current
        : next);
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    measure();
    const onReflow = () => measure();
    window.addEventListener("scroll", onReflow, true);
    window.addEventListener("resize", onReflow);
    // The panel's own height is an input to placement: a harness switch or a
    // filtered list changes it, so re-measure when the box changes size.
    // `anchor` is a dep because the panel only exists once an anchor does.
    const observer =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(onReflow) : null;
    if (panelRef.current) observer?.observe(panelRef.current);
    return () => {
      window.removeEventListener("scroll", onReflow, true);
      window.removeEventListener("resize", onReflow);
      observer?.disconnect();
    };
  }, [open, anchor, measure]);

  // ── Open / close ───────────────────────────────────────────────────────────

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      // The panel is portalled, so it isn't inside rootRef — check both.
      if (rootRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close(true);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);

  /**
   * Land on the model, not on the panel container. Model is what changes;
   * harness and effort are usually already right. Focusing the box itself
   * would make the first arrow press do nothing.
   */
  useEffect(() => {
    if (!open) return;
    const group: Group = counts.model > 0 ? "model" : "harness";
    const index = Math.min(selectedIndex(group), Math.max(0, counts[group] - 1));
    setCursor({ group, index });
    const frame = requestAnimationFrame(() => {
      const target = cells.current.get(`${group}:${index}`);
      if (target) target.focus();
      else panelRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
    // Deliberately keyed on `open` alone — re-running as the list filters would
    // yank focus out of the search field on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Reset the filter between openings; a stale one hides the list on reopen.
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  // A disabled control that still has a panel open is a trap.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const ctx: PanelCtx = {
    value,
    catalog,
    set,
    applyPreset,
    status,
    statusMessage,
    onRetry,
    harnesses,
    presets,
    models,
    modelsPinned,
    modelsRest,
    efforts,
    harnessLabel: description.harnessLabel,
    searchable: isSearchable,
    query,
    setQuery,
    searchRef,
    cell,
    onSearchKeyDown,
  };

  return (
    <div
      ref={rootRef}
      className={className ? `s-rt-root ${className}` : "s-rt-root"}
      style={{ position: "relative", display: "inline-flex" }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`s-rt-chip${disabled ? " s-rt-chip--disabled" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={description.summary}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <HarnessMark
          harness={value.harness || "unknown"}
          size={12}
          className="s-rt-chip-mark"
          title={null}
        />
        {/* Model and effort share a baseline, not a centre line: mixed-case
            mono against all-caps micro type centres badly — the two runs have
            different cap heights and x-heights. The mark and chevron stay
            centred; only the type sits on the baseline. */}
        <span className="s-rt-chip-type">
          <span
            className="s-rt-chip-model"
            style={{ maxWidth: `${MODEL_CH_MAX}ch` }}
          >
            {/* Keyed so a changed model cross-fades in place rather than
                swapping between two frames. The chip hugs the new width —
                the fade is what softens that. */}
            <span key={chipModelLabel} className="s-rt-chip-model-text">
              {chipModelLabel}
            </span>
          </span>
          {efforts && description.effortLabel ? (
            <>
              <span aria-hidden className="s-rt-chip-divider" />
              <span className="s-rt-chip-effort" data-effort={value.effort}>
                {description.effortLabel}
              </span>
            </>
          ) : null}
        </span>
        <Chevron />
      </button>

      {open && anchor
        ? createPortal(
            <div
              ref={panelRef}
              id={panelId}
              role="dialog"
              aria-label="Runtime"
              tabIndex={-1}
              data-placement={anchor.placement}
              className="s-rt-panel"
              style={{
                left: anchor.left,
                width: Math.min(PANEL_W, window.innerWidth - GAP * 2),
                maxHeight: anchor.maxHeight,
                ...(anchor.placement === "up"
                  ? { bottom: viewportHeight() - anchor.top }
                  : { top: anchor.top }),
              }}
            >
              <div className="s-rt-panel-body">
                {presets.length ? (
                  <section className="s-rt-band" style={{ animationDelay: "10ms" }}>
                    <BandHeading>Presets</BandHeading>
                    <PresetOptions ctx={ctx} />
                  </section>
                ) : null}

                <section className="s-rt-band" style={{ animationDelay: "20ms" }}>
                  <BandHeading>Harness</BandHeading>
                  <div className="s-rt-options" role="radiogroup" aria-label="Harness">
                    {harnesses.map((harness, index) => {
                      const on = harness.value === value.harness;
                      const harnessDisabled = harness.disabled ?? false;
                      return (
                        <button
                          key={harness.value || "default"}
                          type="button"
                          role="radio"
                          aria-checked={on}
                          aria-disabled={harnessDisabled || undefined}
                          onClick={() => {
                            if (!harnessDisabled) ctx.set({ harness: harness.value });
                          }}
                          data-on={on || undefined}
                          data-disabled={harnessDisabled || undefined}
                          title={harness.note}
                          {...ctx.cell("harness", index)}
                          className="s-rt-opt s-rt-harness-opt"
                        >
                          <HarnessMark
                            harness={harness.value || "unknown"}
                            size={13}
                            className="s-rt-opt-mark"
                            title={null}
                          />
                          <span>{harness.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </section>

                <section className="s-rt-band" style={{ animationDelay: "45ms" }}>
                  <BandHeading>Model</BandHeading>
                  {onRefreshModels ? (
                    <div className="s-rt-status">
                      <span className="s-rt-status-message">{catalogStatus ?? "Model catalog"}</span>
                      <button type="button" className="s-rt-retry" onClick={onRefreshModels} disabled={refreshingModels}>
                        {refreshingModels ? "Refreshing…" : "Refresh models"}
                      </button>
                    </div>
                  ) : null}
                  {catalogWarning ? <p className="s-rt-band-note" role="status">{catalogWarning}</p> : null}
                  {isSearchable ? <SearchField ctx={ctx} /> : null}
                  <ModelOptions ctx={ctx} />
                  {description.model.note ? (
                    <p className="s-rt-band-note">{description.model.note}</p>
                  ) : null}
                </section>

                <section className="s-rt-band" style={{ animationDelay: "70ms" }}>
                  <BandHeading>Effort</BandHeading>
                  <div className="s-rt-effort">
                    {efforts ? (
                      <EffortLadder ctx={ctx} />
                    ) : (
                      <EffortAbsent harnessLabel={description.harnessLabel} />
                    )}
                  </div>
                </section>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

// ── Re-exports ───────────────────────────────────────────────────────────────
//
// The catalog is the atom's other half. Re-exporting it here means a consumer
// has one import path to remember, and `MessageComposer/index.ts` keeps its
// single surface.

export {
  RUNTIME_DEFAULT_VALUE,
  RUNTIME_EFFORTS,
  describeRuntime,
  effortsFor,
  matchPreset,
  modelsFor,
  orderModelsWithShortlist,
  reconcileRuntime,
  resolveModel,
  runtimeCatalogFromRunnerOptions,
  runtimeListOriginLabel,
  searchRuntimeOptions,
  seedRuntime,
  supportsEffort,
  valueForPreset,
} from "../../lib/runtime-catalog.ts";
export type {
  PinnedRuntimeOption,
  RuntimeCatalog,
  RuntimeDescription,
  RuntimeEffort,
  RuntimeHarness,
  RuntimeOption,
  RuntimePreset,
  RuntimePresetOrigin,
  RuntimeShortlistEntry,
  RuntimeShortlistOrigin,
  RuntimeValue,
} from "../../lib/runtime-catalog.ts";
