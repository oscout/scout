import "./scout-feature-flag-panel.css";

import { useEffect, useMemo } from "react";
import { normalizeOverride, useOptionalFeatureFlags, type FeatureFlagOverride } from "hudsonkit/flags";
import { X } from "lucide-react";

import { useFocusTrap } from "../lib/keyboard-nav.ts";
import {
  isScoutDevToolsAvailable,
  useScoutDevFlagControls,
} from "../lib/use-scout-dev-flags.ts";
import type { ScoutFlagBundle } from "../lib/scout-flags.ts";

const BUNDLE_LABELS: Record<ScoutFlagBundle, string> = {
  "light-prod": "Lean launch",
  "max-pro": "Max pro",
  "scope-instrument": "Scope",
};

function localSelectValue(value: FeatureFlagOverride): "default" | "on" | "off" {
  const normalized = normalizeOverride(value);
  if (normalized === true) return "on";
  if (normalized === false) return "off";
  return "default";
}

function inferAudienceOptions(
  rows: Array<{ requiredTier?: string | null }>,
  active: string,
): string[] {
  const values = new Set<string>([active]);
  for (const row of rows) {
    if (row.requiredTier) values.add(String(row.requiredTier));
  }
  return [...values];
}

export function ScoutFeatureFlagPanel({
  isOpen,
  onClose,
  audienceOptions,
}: {
  isOpen: boolean;
  onClose: () => void;
  audienceOptions?: readonly string[];
}) {
  const flags = useOptionalFeatureFlags();
  const { ref: panelRef, onKeyDown: onPanelKeyDown } = useFocusTrap<HTMLDivElement>(isOpen);
  const devTools = isScoutDevToolsAvailable();
  const { activeBundle, applyBundle, resetBundle } = useScoutDevFlagControls();
  const rows = useMemo(() => flags?.all() ?? [], [flags]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  if (!isOpen || !flags) return null;

  const audience = flags.audience();
  const localAudience = flags.layers.local?.audience ?? "";
  const options = audienceOptions ?? inferAudienceOptions(rows, audience.tier);

  return (
    <div className="scout-flag-backdrop" onClick={onClose}>
      <div
        {...panelRef}
        className="scout-flag-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="scout-flag-title"
        onKeyDown={onPanelKeyDown}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="scout-flag-head">
          <div className="scout-flag-head-copy">
            <h2 id="scout-flag-title" className="scout-flag-title">Feature flags</h2>
            <p className="scout-flag-subtitle">
              Audience <strong>{audience.tier}</strong> · local overrides apply instantly
            </p>
          </div>
          <button
            type="button"
            className="btn btn--ghost btn--sm btn--icon"
            aria-label="Close feature flags"
            onClick={onClose}
          >
            <X size={14} strokeWidth={1.8} />
          </button>
        </header>

        <div className="scout-flag-toolbar">
          <label className="scout-flag-toolbar-label" htmlFor="scout-flag-audience">
            Local audience
          </label>
          <select
            id="scout-flag-audience"
            className="scout-flag-select"
            value={localAudience}
            onChange={(event) => flags.setLocalAudienceOverride(event.target.value || null)}
          >
            <option value="">Default ({audience.tier})</option>
            {options.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>

          {devTools && (
            <div className="scout-flag-bundles">
              {(Object.keys(BUNDLE_LABELS) as ScoutFlagBundle[]).map((bundle) => (
                <button
                  key={bundle}
                  type="button"
                  className={`chip chip--mono chip--caps chip--sm${
                    activeBundle === bundle ? " chip--working" : " chip--ghost"
                  }`}
                  onClick={() => applyBundle(bundle)}
                >
                  {BUNDLE_LABELS[bundle]}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="scout-flag-list">
          {rows.map((row) => {
            const localValue = flags.layers.local?.flags?.[row.key];
            return (
              <div key={row.key} className="scout-flag-row">
                <div className="scout-flag-key">
                  <div className="scout-flag-key-name">{row.key}</div>
                  <div className="scout-flag-key-desc">
                    {row.definition?.description ?? row.definition?.label ?? row.reason}
                  </div>
                </div>

                <span className={`chip chip--mono chip--caps chip--sm ${
                  row.enabled ? "chip--success" : "chip--neutral"
                }`}>
                  {row.enabled ? "on" : "off"}
                </span>

                <span className="scout-flag-meta" title={`${row.layer} · ${row.reason}`}>
                  {row.layer}
                </span>

                <select
                  className="scout-flag-select"
                  aria-label={`Override ${row.key}`}
                  value={localSelectValue(localValue)}
                  onChange={(event) => {
                    const next = event.target.value;
                    flags.setLocalOverride(row.key, next === "default" ? null : next === "on");
                  }}
                >
                  <option value="default">default</option>
                  <option value="on">on</option>
                  <option value="off">off</option>
                </select>
              </div>
            );
          })}
        </div>

        <footer className="scout-flag-foot">
          <span className="scout-flag-count">{rows.length} flags</span>
          <button
            type="button"
            className="btn btn--ghost btn--sm btn--mono"
            onClick={resetBundle}
          >
            Reset flags
          </button>
        </footer>
      </div>
    </div>
  );
}
