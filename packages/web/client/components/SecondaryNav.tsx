import type { Route } from "../lib/types.ts";
import "./secondary-nav.css";

export type SecondaryNavItem = {
  id: string;
  label: string;
  route: Route;
  active: (route: Route) => boolean;
};

export type SecondaryNavGroup = {
  label?: string;
  items: SecondaryNavItem[];
};

export function SecondaryNav({
  ariaLabel,
  activeRoute,
  groups,
  navigate,
  className = "",
}: {
  ariaLabel: string;
  activeRoute: Route;
  groups: SecondaryNavGroup[];
  navigate: (route: Route) => void;
  className?: string;
}) {
  return (
    <nav className={`s-secondary-nav${className ? ` ${className}` : ""}`} aria-label={ariaLabel}>
      {groups.map((group, index) => (
        <div key={group.label ?? index} className="s-secondary-nav-group">
          {group.label && <span className="s-secondary-nav-label">{group.label}</span>}
          <div className="s-secondary-nav-switch">
            {group.items.map((item) => {
              const active = item.active(activeRoute);
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={active}
                  className={`s-secondary-nav-button${active ? " s-secondary-nav-button--active" : ""}`}
                  onClick={() => navigate(item.route)}
                >
                  {item.label}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}
