import type { ReactNode } from "react";

/** Wraps center content with a secondary nav bar — Scout product screens use this by default. */
export function SecondaryNavShell({
  subnav,
  children,
  scrollBody = false,
}: {
  subnav: ReactNode;
  children: ReactNode;
  scrollBody?: boolean;
}) {
  return (
    <div className="s-secondary-nav-shell">
      <div className="s-secondary-nav-bar">{subnav}</div>
      <div className={`s-secondary-nav-body${scrollBody ? " s-secondary-nav-body--scroll" : ""}`}>
        {children}
      </div>
    </div>
  );
}