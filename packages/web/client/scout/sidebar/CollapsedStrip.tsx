/**
 * Shared minimized side-rail chip stack primitives.
 */
import type { CSSProperties, ReactNode } from "react";
import "./collapsed-strip.css";

export type CollapsedChipTone = "default" | "channel" | "neutral" | "attention" | "unread";
export type CollapsedLabelTone = "default" | "accent" | "attention" | "live";

/**
 * Compact section label for the 48px collapsed rail — pill + mono caption,
 * optional count. Use inside `CollapsedStrip` or alone.
 */
export function CollapsedStripLabel({
  children,
  count,
  tone = "default",
  title,
}: {
  children: string;
  /** Optional tabular count under the name (e.g. unread / item total). */
  count?: number | string;
  tone?: CollapsedLabelTone;
  title?: string;
}) {
  return (
    <div
      className={[
        "collapsed-strip-label",
        tone !== "default" && `collapsed-strip-label--${tone}`,
        count != null && "collapsed-strip-label--has-count",
      ]
        .filter(Boolean)
        .join(" ")}
      title={title ?? children}
    >
      <span className="collapsed-strip-label-mark" aria-hidden />
      <span className="collapsed-strip-label-text">{children}</span>
      {count != null ? (
        <span className="collapsed-strip-label-count">{count}</span>
      ) : null}
    </div>
  );
}

export function CollapsedStrip({
  label,
  emptyMark = "·",
  /** When true (default), render a pill caption above the chips. */
  showLabel = true,
  labelTone = "default",
  labelCount,
  children,
}: {
  label: string;
  emptyMark?: string;
  showLabel?: boolean;
  labelTone?: CollapsedLabelTone;
  labelCount?: number | string;
  children: ReactNode;
}) {
  const empty = !children || (Array.isArray(children) && children.length === 0);
  const caption = showLabel ? (
    <CollapsedStripLabel tone={labelTone} count={labelCount}>
      {label}
    </CollapsedStripLabel>
  ) : null;

  if (empty) {
    return (
      <div className="collapsed-strip collapsed-strip--empty" aria-hidden>
        {caption}
        <span className="collapsed-strip-empty-mark">{emptyMark}</span>
      </div>
    );
  }
  return (
    <div className="collapsed-strip" role="list" aria-label={label}>
      {caption}
      {children}
    </div>
  );
}

export function CollapsedStripRule() {
  return <div className="collapsed-strip-rule" aria-hidden />;
}

export function CollapsedChip({
  title,
  active,
  tone = "default",
  ava,
  avaColor,
  glyph,
  dot,
  pinned,
  onClick,
}: {
  title: string;
  active?: boolean;
  tone?: CollapsedChipTone;
  ava?: string;
  avaColor?: string;
  glyph?: ReactNode;
  dot?: "unread" | "attention" | "live" | null;
  pinned?: boolean;
  onClick: () => void;
}) {
  const classes = [
    "collapsed-chip",
    tone === "channel" && "collapsed-chip--channel",
    tone === "neutral" && "collapsed-chip--neutral",
    tone === "attention" && "collapsed-chip--attention",
    tone === "unread" && "collapsed-chip--unread",
    active && "collapsed-chip--active",
    pinned && "collapsed-chip--pinned",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type="button"
      role="listitem"
      className={classes}
      title={title}
      aria-label={title}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
    >
      {ava ? (
        <span
          className="collapsed-chip-ava"
          style={avaColor ? ({ background: avaColor } satisfies CSSProperties) : undefined}
        >
          {ava}
        </span>
      ) : (
        <span className="collapsed-chip-glyph">{glyph}</span>
      )}
      {dot ? (
        <span
          className={[
            "collapsed-chip-dot",
            dot === "attention" && "collapsed-chip-dot--attention",
            dot === "live" && "collapsed-chip-dot--live",
          ]
            .filter(Boolean)
            .join(" ")}
          aria-hidden
        />
      ) : null}
      {pinned ? <span className="collapsed-chip-pin" aria-hidden /> : null}
    </button>
  );
}

/** Prefer a distinguishing letter when many items share a prefix. */
export function chipInitial(label: string): string {
  const base = label.trim();
  const parts = base.split(/[\s/_-]+/).filter(Boolean);
  if (parts.length >= 2) {
    const last = parts[parts.length - 1]!;
    if (/^\d+$/.test(last) && parts.length >= 3) {
      return (parts[parts.length - 2]![0] ?? "?").toUpperCase();
    }
    return (last[0] ?? "?").toUpperCase();
  }
  return (base[0] ?? "?").toUpperCase();
}
