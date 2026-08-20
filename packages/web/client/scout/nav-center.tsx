import { createElement, type ReactNode } from "react";
import type { Route } from "../lib/types.ts";
import type { TopNavKey } from "./topNavConfig.ts";

// Generic over the tab key so the scope shell (scope/nav.ts) can reuse the
// chrome with its own key set.
export type NavCenterItem<K extends string = TopNavKey> = {
  key: K;
  label: string;
  route: Route;
};

export type NavCenterConfig<K extends string = TopNavKey> = {
  className?: string;
  brandTag?: string;
  items: NavCenterItem<K>[];
  activeKey: K;
  breadcrumb?: string | null;
  navigate: (route: Route) => void;
};

export function renderNavCenter<K extends string = TopNavKey>({
  className = "scout-nav-tabs",
  brandTag,
  items,
  activeKey,
  breadcrumb,
  navigate,
}: NavCenterConfig<K>): ReactNode {
  return createElement("div", { className },
    brandTag && createElement("span", { className: "scout-nav-scope-tag" }, brandTag),
    items.map(({ key, label, route: tabRoute }) =>
      createElement("button", {
        key,
        className: `scout-nav-tab${activeKey === key ? " active" : ""}`,
        onClick: () => navigate(tabRoute),
      }, label),
    ),
    breadcrumb && createElement("span", { className: "scout-nav-slash" }, "/"),
    breadcrumb && createElement("span", { className: "scout-nav-crumb" }, breadcrumb),
  );
}
