import type { ReactNode } from "react";

export type EmptyStateProps = {
  title: string;
  body?: string | ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
};

/**
 * Empty / loading / error state card used across system surfaces.
 *
 * Renders the canonical `sys-panel sys-state-card` structure. Callers can
 * append modifier classes (e.g. `sys-state-card-error`) via `className`.
 */
export function EmptyState({ title, body, icon, action, className }: EmptyStateProps) {
  const composedClassName = className
    ? `sys-panel sys-state-card ${className}`
    : "sys-panel sys-state-card";
  return (
    <div className={composedClassName}>
      {icon}
      <h3 className="sys-state-title">{title}</h3>
      {body !== undefined && body !== null && (
        typeof body === "string" ? <p className="sys-state-body">{body}</p> : body
      )}
      {action && <div className="sys-inline-actions">{action}</div>}
    </div>
  );
}

export default EmptyState;
