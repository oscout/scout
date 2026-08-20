import { FileText, Maximize2, Minimize2, X } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  TextDocumentSurface,
  type TextDocument,
  type TextDocumentMode,
} from "./TextDocumentSurface.tsx";
import "./document-focus-viewer.css";

export type DocumentFocusKind = "ask" | "plan" | "doc" | "code";

export type DocumentFocusViewerAction = {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  title?: string;
  disabled?: boolean;
  hideLabel?: boolean;
};

export function DocumentFocusViewer({
  open = true,
  focusable = true,
  kind,
  document,
  title,
  eyebrow,
  subtitle,
  meta = [],
  mode,
  actions = [],
  state,
  error,
  notice,
  body,
  onClose,
}: {
  open?: boolean;
  focusable?: boolean;
  kind: DocumentFocusKind;
  document: TextDocument | null;
  title?: string;
  eyebrow?: string;
  subtitle?: string;
  meta?: string[];
  mode?: TextDocumentMode;
  actions?: DocumentFocusViewerAction[];
  state?: string | null;
  error?: string | null;
  notice?: string | null;
  body?: ReactNode;
  onClose?: () => void;
}) {
  const [focused, setFocused] = useState(false);
  const [layerStyle, setLayerStyle] = useState<CSSProperties>({});
  const layerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      setFocused(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    let frame: number | null = null;
    const layer = layerRef.current;
    const host = layer?.closest<HTMLElement>(".frame-scrollbar, .s-content") ?? null;

    const updateBounds = () => {
      if (!host) {
        setLayerStyle({});
        return;
      }
      const rect = host.getBoundingClientRect();
      setLayerStyle({
        "--doc-focus-layer-top": `${Math.max(0, rect.top)}px`,
        "--doc-focus-layer-right": `${Math.max(0, window.innerWidth - rect.right)}px`,
        "--doc-focus-layer-bottom": `${Math.max(0, window.innerHeight - rect.bottom)}px`,
        "--doc-focus-layer-left": `${Math.max(0, rect.left)}px`,
      } as CSSProperties);
    };

    const scheduleBounds = () => {
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
      frame = requestAnimationFrame(updateBounds);
    };

    updateBounds();
    const observer = host ? new ResizeObserver(scheduleBounds) : null;
    if (host) {
      observer?.observe(host);
    }
    window.addEventListener("resize", scheduleBounds);
    return () => {
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
      observer?.disconnect();
      window.removeEventListener("resize", scheduleBounds);
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (focused) {
          setFocused(false);
        } else {
          onClose?.();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focused, onClose, open]);

  if (!open) {
    return null;
  }

  const resolvedTitle = title ?? document?.title ?? "Document";
  const resolvedMode = mode ?? (document?.kind === "markdown" ? "preview" : "read");
  const canFocus = focusable && Boolean(document || body);

  return (
    <div
      ref={layerRef}
      className={`s-doc-focus-layer${focused ? " s-doc-focus-layer-focused" : ""}`}
      style={layerStyle}
    >
      {onClose && (
        <button
          type="button"
          className="s-doc-focus-scrim"
          aria-label="Dismiss document viewer"
          tabIndex={-1}
          onClick={onClose}
        />
      )}
      <section
        className={`s-doc-focus-viewer s-doc-focus-viewer-${kind}${focused ? " s-doc-focus-viewer-focused" : ""}`}
        aria-label={resolvedTitle}
        role="dialog"
        aria-modal="true"
      >
        <div className="s-doc-focus-viewer-head">
          <div className="s-doc-focus-viewer-title-wrap">
            <div className="s-doc-focus-viewer-icon" aria-hidden="true">
              <FileText size={15} strokeWidth={1.8} />
            </div>
            <div className="s-doc-focus-viewer-title-main">
              {eyebrow && <div className="s-doc-focus-viewer-eyebrow">{eyebrow}</div>}
              <h3 className="s-doc-focus-viewer-title">{resolvedTitle}</h3>
              {subtitle && <div className="s-doc-focus-viewer-subtitle">{subtitle}</div>}
            </div>
          </div>
          <div className="s-doc-focus-viewer-actions">
            {meta.length > 0 && (
              <div className="s-doc-focus-viewer-meta" aria-label="Document metadata">
                {meta.map((item) => (
                  <span key={item}>{item}</span>
                ))}
              </div>
            )}
            {actions.map((action) => (
              <button
                key={action.label}
                type="button"
                className={`s-doc-focus-viewer-action${action.hideLabel ? " s-doc-focus-viewer-action-icon" : ""}`}
                onClick={action.onClick}
                title={action.title ?? action.label}
                disabled={action.disabled}
                aria-label={action.hideLabel ? action.label : undefined}
              >
                {action.icon}
                {!action.hideLabel && <span>{action.label}</span>}
              </button>
            ))}
            {canFocus && (
              <button
                type="button"
                className="s-doc-focus-viewer-close"
                onClick={() => setFocused((current) => !current)}
                aria-label={focused ? "Exit focus mode" : "Enter focus mode"}
                title={focused ? "Exit focus mode" : "Focus"}
              >
                {focused
                  ? <Minimize2 aria-hidden="true" size={14} strokeWidth={1.8} />
                  : <Maximize2 aria-hidden="true" size={14} strokeWidth={1.8} />}
              </button>
            )}
            {onClose && (
              <button
                type="button"
                className="s-doc-focus-viewer-close"
                onClick={onClose}
                aria-label="Close document viewer"
                title="Close"
              >
                <X aria-hidden="true" size={14} strokeWidth={1.8} />
              </button>
            )}
          </div>
        </div>
        {state && !error && !document && !body && (
          <div className="s-doc-focus-viewer-state">{state}</div>
        )}
        {error && (
          <div className="s-doc-focus-viewer-state s-doc-focus-viewer-error">{error}</div>
        )}
        {!error && body && (
          <div className="s-doc-focus-viewer-body">{body}</div>
        )}
        {!error && !body && document && (
          <TextDocumentSurface
            document={document}
            mode={resolvedMode}
            showHeader={false}
            className="s-doc-focus-document"
          />
        )}
        {!error && notice && (
          <div className="s-doc-focus-viewer-notice">{notice}</div>
        )}
      </section>
    </div>
  );
}
