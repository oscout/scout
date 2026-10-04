import { Radio, RotateCw } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import {
  allowCompanionScope,
  disallowCompanionScope,
  isCompanionScopeId,
  type CompanionScopeKind,
} from "../../lib/companion-host.ts";
import { useCompanionHostState } from "./useCompanionHostState.ts";
import "./companion-surface.css";

type Option = { kind: CompanionScopeKind; id: string; label: string; title: string };

/**
 * Let this work, its agent, or its project surface on the desktop companion.
 * Default off: nothing surfaces until the operator ticks a box here. A grant
 * only lets items appear in the companion's quiet "surfaced" list with a
 * badge for asks; it never shows the panel, takes focus, or grants anything
 * else. Rendered only inside the Scout app, like CompanionPinButton.
 */
export function CompanionSurfaceButton({
  workId,
  workTitle,
  agentId,
  agentName,
  projectRoot,
  projectName,
  className,
}: {
  workId: string;
  workTitle?: string | null;
  agentId?: string | null;
  agentName?: string | null;
  projectRoot?: string | null;
  projectName?: string | null;
  className: string;
}) {
  const host = useCompanionHostState();
  const state = host.state;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!host.available) return null;

  // The first read failed: say so, and let the operator try again.
  if (!state && host.error) {
    return (
      <button type="button" className={className} onClick={host.retry} title={host.error}>
        <RotateCw aria-hidden="true" size={13} />
        <span>Companion unavailable · Retry</span>
      </button>
    );
  }

  const options: Option[] = [
    { kind: "work", id: workId, label: "This work", title: workTitle?.trim() || workId },
  ];
  if (agentId && isCompanionScopeId("agent", agentId)) {
    options.push({ kind: "agent", id: agentId, label: "Its agent", title: agentName?.trim() || agentId });
  }
  if (projectRoot && isCompanionScopeId("project", projectRoot)) {
    options.push({
      kind: "project",
      id: projectRoot,
      label: "Its project",
      title: projectName?.trim() || projectRoot.split("/").filter(Boolean).pop() || projectRoot,
    });
  }

  const granted = (option: Option) =>
    state?.scopes.some((scope) => scope.kind === option.kind && scope.id === option.id) ?? false;
  const anyGranted = options.some(granted);

  const toggle = (option: Option) => {
    setBusy(true);
    (granted(option)
      ? disallowCompanionScope(option.kind, option.id)
      : allowCompanionScope(option.kind, option.id, option.title))
      .then(host.apply)
      .catch(host.fail)
      .finally(() => setBusy(false));
  };

  return (
    <div className="co-surface" ref={rootRef}>
      <button
        type="button"
        className={className}
        onClick={() => setOpen((value) => !value)}
        disabled={state === null}
        aria-expanded={open}
        aria-controls={menuId}
        data-on={anyGranted ? "" : undefined}
        title="Choose what may surface progress and asks on the desktop companion"
      >
        <Radio aria-hidden="true" size={13} />
        <span>{anyGranted ? "Surfacing" : "Surface on companion"}</span>
      </button>
      {open && (
        <div className="co-surface-menu" id={menuId} role="group" aria-label="Allowed to surface on the companion">
          <p className="co-surface-lede">Allow to appear on the companion</p>
          {options.map((option) => (
            <label key={`${option.kind}:${option.id}`} className="co-surface-option">
              <input
                type="checkbox"
                checked={granted(option)}
                disabled={busy}
                onChange={() => toggle(option)}
              />
              <span className="co-surface-kind">{option.label}</span>
              <span className="co-surface-name" title={option.id}>{option.title}</span>
            </label>
          ))}
          <p className="co-surface-hint">
            Progress and asks show in a quiet list with a badge. Nothing pops open or takes focus.
          </p>
          {host.error && <p className="co-surface-error" role="alert">{host.error}</p>}
        </div>
      )}
    </div>
  );
}
