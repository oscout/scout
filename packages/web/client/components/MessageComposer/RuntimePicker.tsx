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
 * The panel is the rail treatment: harness as a left rail with a travelling
 * marker, model list column, effort footer. Keyboard: manual activation, not
 * selection-follows-focus. Arrows move the cursor, Enter/Space commits. This
 * is deliberate — picking a harness resets the model, so arrowing past
 * `codex` on the way to `grok` must not silently throw away the model you
 * already chose.
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
  modelsFor,
  reconcileRuntime,
  resolveModel,
  searchRuntimeOptions,
  seedRuntime,
  type RuntimeCatalog,
  type RuntimeOption,
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

const ROW_H = 34;
/**
 * The panel is the editor; the chip is the readout. The editor is allowed to
 * be wider than the thing that opened it — that is the whole point of opening
 * it — and buying that width is what lets the chip stop resizing to fit its
 * content. The rail takes the extra room in the model column, where real
 * model ids (`claude-opus-5-20991231`) actually live.
 */
const PANEL_W = 460;

/**
 * Cap on the model name in the collapsed chip, in ch (the chip is mono, so
 * ch is exact). There is no reserved minimum — the chip hugs its content at
 * rest; the cap only keeps a pasted model id from stretching the toolbar.
 */
const MODEL_CH_MAX = 14;
/** Enough headroom to open upward; below this the panel flips down. */
const PANEL_H_ESTIMATE = 300;
const GAP = 8;

// ── Roving focus ─────────────────────────────────────────────────────────────

type Group = "harness" | "model" | "effort";
const GROUP_ORDER: Group[] = ["harness", "model", "effort"];

/**
 * Arrows move along a group's own axis and cross to the neighbouring group on
 * the perpendicular axis. In the rail the harness and model lists stack
 * vertically and the effort ladder lies flat, so the same key means "next
 * option" in one and "next group" in the other.
 */
const ORIENTATION: Record<Group, "vertical" | "horizontal"> = {
  harness: "vertical",
  model: "vertical",
  effort: "horizontal",
};

interface PanelCtx {
  value: RuntimeValue;
  set: (patch: Partial<RuntimeValue>) => void;
  status: RuntimeStatus;
  statusMessage?: string;
  onRetry?: () => void;
  harnesses: RuntimeOption[];
  models: RuntimeOption[];
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

// ── Rows ─────────────────────────────────────────────────────────────────────

function ModelRow({
  option,
  selected,
  index,
  ctx,
}: {
  option: RuntimeOption;
  selected: boolean;
  index: number;
  ctx: PanelCtx;
}) {
  const disabled = option.disabled ?? false;
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      /* Kept in the list but unselectable — and still focusable, so the reason
         (a `note` like "not installed") stays reachable by keyboard. */
      aria-disabled={disabled || undefined}
      onClick={() => {
        if (!disabled) ctx.set({ model: option.value });
      }}
      data-on={selected || undefined}
      data-disabled={disabled || undefined}
      {...ctx.cell("model", index)}
      // Capped so a long catalog does not end with rows still arriving after
      // the pointer has already reached them.
      style={{ animationDelay: `${Math.min(index, 6) * 16}ms` }}
      className="s-rt-row s-rt-model-row"
    >
      <span aria-hidden className="s-rt-dot" />
      <span className="s-rt-row-label">{option.label}</span>
      {option.note ? <span className="s-rt-note">{option.note}</span> : null}
    </button>
  );
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

function ModelList({ ctx }: { ctx: PanelCtx }) {
  if (ctx.status !== "ready" || ctx.models.length === 0) return <ModelStatus ctx={ctx} />;
  return (
    <div
      key={ctx.value.harness}
      role="listbox"
      aria-label="Model"
      className="s-rt-models"
    >
      {ctx.models.map((model, index) => (
        <ModelRow
          key={model.value || "default"}
          option={model}
          index={index}
          selected={model.value === ctx.value.model}
          ctx={ctx}
        />
      ))}
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

  const harnesses = catalog.harnesses;
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
  const models = useMemo(
    () => searchRuntimeOptions(withCustom, query),
    [withCustom, query],
  );
  const catalogEfforts = effortsFor(catalog, value.harness, value.model);
  const efforts = showEffort === false ? null : showEffort === true
    ? (catalogEfforts ?? catalog.efforts)
    : catalogEfforts;
  const isSearchable =
    searchable === "auto" ? withCustom.length > SEARCH_THRESHOLD : searchable;

  const description = describeRuntime(catalog, value);

  // ── Roving focus ───────────────────────────────────────────────────────────

  const cells = useRef(new Map<string, HTMLElement>());
  const [cursor, setCursor] = useState<{ group: Group; index: number }>({
    group: "model",
    index: 0,
  });

  const counts = useMemo<Record<Group, number>>(
    () => ({
      harness: harnesses.length,
      model: status === "ready" ? models.length : 0,
      effort: efforts?.length ?? 0,
    }),
    [efforts?.length, harnesses.length, models.length, status],
  );

  const selectedIndex = useCallback(
    (group: Group) => {
      if (group === "harness") {
        return Math.max(0, harnesses.findIndex((h) => h.value === value.harness));
      }
      if (group === "model") {
        return Math.max(0, models.findIndex((m) => m.value === value.model));
      }
      return Math.max(0, efforts?.findIndex((e) => e.value === value.effort) ?? 0);
    },
    [efforts, harnesses, models, value],
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

        if (event.key === nextKey) {
          event.preventDefault();
          focusCell(group, (index + 1) % count);
        } else if (event.key === prevKey) {
          event.preventDefault();
          // With a filter above the list, Up from the first row belongs to it.
          if (group === "model" && index === 0 && isSearchable) {
            setCursor({ group, index: 0 });
            searchRef.current?.focus();
            return;
          }
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
    [counts.model, focusCell, models, query, set],
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
  } | null>(null);

  const measure = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const roomAbove = rect.top;
    const roomBelow = window.innerHeight - rect.bottom;
    // Composer toolbars sit at the foot of the screen, so prefer upward.
    const placement: "up" | "down" =
      roomAbove >= PANEL_H_ESTIMATE || roomAbove >= roomBelow ? "up" : "down";
    const left = Math.min(
      Math.max(GAP, rect.right - PANEL_W),
      Math.max(GAP, window.innerWidth - PANEL_W - GAP),
    );
    setAnchor({
      left,
      top: placement === "up" ? rect.top - GAP : rect.bottom + GAP,
      placement,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    measure();
    const onReflow = () => measure();
    window.addEventListener("scroll", onReflow, true);
    window.addEventListener("resize", onReflow);
    return () => {
      window.removeEventListener("scroll", onReflow, true);
      window.removeEventListener("resize", onReflow);
    };
  }, [open, measure]);

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

  const activeHarness = Math.max(
    0,
    harnesses.findIndex((harness) => harness.value === value.harness),
  );

  const ctx: PanelCtx = {
    value,
    set,
    status,
    statusMessage,
    onRetry,
    harnesses,
    models,
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
            <span key={description.modelLabel} className="s-rt-chip-model-text">
              {description.modelLabel}
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
                width: PANEL_W,
                ...(anchor.placement === "up"
                  ? { bottom: window.innerHeight - anchor.top }
                  : { top: anchor.top }),
              }}
            >
              <div className="s-rt-rail">
                <div className="s-rt-rail-main">
                  {/* Harness rail — one marker travels, rows don't each grow a
                      border. */}
                  <div
                    className="s-rt-harnesses"
                    role="radiogroup"
                    aria-label="Harness"
                  >
                    <span
                      aria-hidden
                      className="s-rt-marker"
                      style={{
                        height: ROW_H - 10,
                        transform: `translateY(${activeHarness * ROW_H + 5}px)`,
                      }}
                    />
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
                          style={{ height: ROW_H }}
                          data-on={on || undefined}
                          data-disabled={harnessDisabled || undefined}
                          title={harnessDisabled ? harness.note : undefined}
                          {...ctx.cell("harness", index)}
                          className="s-rt-harness"
                        >
                          <HarnessMark
                            harness={harness.value || "unknown"}
                            size={14}
                            className="s-rt-opt-mark"
                            title={null}
                          />
                          <span className="s-rt-harness-label">{harness.label}</span>
                        </button>
                      );
                    })}
                  </div>

                  {/* Models — re-keyed on harness so the swap animates. */}
                  <div className="s-rt-models-col">
                    {isSearchable ? <SearchField ctx={ctx} /> : null}
                    <ModelList ctx={ctx} />
                  </div>
                </div>

                <div className="s-rt-effort-foot">
                  {efforts ? (
                    <EffortLadder ctx={ctx} />
                  ) : (
                    <EffortAbsent harnessLabel={description.harnessLabel} />
                  )}
                </div>
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
  modelsFor,
  reconcileRuntime,
  resolveModel,
  runtimeCatalogFromRunnerOptions,
  searchRuntimeOptions,
  seedRuntime,
  supportsEffort,
} from "../../lib/runtime-catalog.ts";
export type {
  RuntimeCatalog,
  RuntimeDescription,
  RuntimeEffort,
  RuntimeHarness,
  RuntimeOption,
  RuntimeValue,
} from "../../lib/runtime-catalog.ts";
