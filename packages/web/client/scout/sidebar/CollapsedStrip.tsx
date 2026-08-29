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
 *
 * When `onClick` is provided the pill renders as a button (the collapsed
 * rail's "section icon is the expander" pattern): on hover the little mark
 * dash swaps to a › glyph, so the affordance reads without any extra chrome.
 */
export function CollapsedStripLabel({
  children,
  count,
  tone = "default",
  title,
  onClick,
}: {
  children: string;
  /** Optional tabular count under the name (e.g. unread / item total). */
  count?: number | string;
  tone?: CollapsedLabelTone;
  title?: string;
  onClick?: () => void;
}) {
  const classes = [
    "collapsed-strip-label",
    tone !== "default" && `collapsed-strip-label--${tone}`,
    count != null && "collapsed-strip-label--has-count",
    onClick && "collapsed-strip-label--button",
  ]
    .filter(Boolean)
    .join(" ");
  const inner = (
    <>
      <span className="collapsed-strip-label-mark" aria-hidden />
      {onClick ? (
        <span className="collapsed-strip-label-expand" aria-hidden>
          ›
        </span>
      ) : null}
      <span className="collapsed-strip-label-text">{children}</span>
      {count != null ? (
        <span className="collapsed-strip-label-count">{count}</span>
      ) : null}
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        className={classes}
        title={title ?? children}
        aria-label={title ?? children}
        onClick={onClick}
      >
        {inner}
      </button>
    );
  }
  return (
    <div className={classes} title={title ?? children}>
      {inner}
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
  onLabelClick,
  children,
}: {
  label: string;
  emptyMark?: string;
  showLabel?: boolean;
  labelTone?: CollapsedLabelTone;
  labelCount?: number | string;
  /** Makes the label pill the rail's expander (click → expand). */
  onLabelClick?: () => void;
  children: ReactNode;
}) {
  const empty = !children || (Array.isArray(children) && children.length === 0);
  const caption = showLabel ? (
    <CollapsedStripLabel
      tone={labelTone}
      count={labelCount}
      onClick={onLabelClick}
      title={onLabelClick ? `Expand ${label}` : undefined}
    >
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
  avatarNode,
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
  avatarNode?: ReactNode;
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
      {avatarNode ? (
        <span className="collapsed-chip-avatar-wrap">
          {avatarNode}
        </span>
      ) : ava ? (
        <span
          className="collapsed-chip-ava"
          style={
            avaColor
              ? ({ "--ava-color": avaColor } as CSSProperties)
              : undefined
          }
        >
          {ava}
        </span>
      ) : (
        <span
          className={`collapsed-chip-glyph${typeof glyph === "string" && glyph.length > 1 ? " collapsed-chip-glyph--long" : ""}`}
        >
          {glyph}
        </span>
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
