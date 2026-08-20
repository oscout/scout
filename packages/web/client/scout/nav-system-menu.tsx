import { createElement, useEffect, useRef, useState, type ReactNode } from "react";
import { useOptionalFlag } from "hudsonkit/flags";
import { useScout } from "./Provider.tsx";
import {
  CORE_SYSTEM_MENU_ENTRIES,
  SYSTEM_OPS_ENTRIES,
  type SystemMenuEntry,
} from "./nav-system-menu-config.ts";
import { isSystemRoute } from "./topNavConfig.ts";
import "./nav-system-menu.css";

/** `system ▾` dropdown in the nav actions — home of the ops/retrieval cluster. */
export function SystemMenu(): ReactNode {
  const { route, navigate } = useScout();
  const opsEnabled = useOptionalFlag("ops.control", true);
  const meshOpsEnabled = useOptionalFlag("surface.mesh-ops", false);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onClickOutside = (event: MouseEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) {
        return;
      }
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onClickOutside, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onClickOutside, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const renderEntry = (entry: SystemMenuEntry) =>
    createElement("button", {
      key: entry.key,
      type: "button",
      role: "menuitem",
      className: `scout-nav-system-item${entry.active(route) ? " active" : ""}`,
      onClick: () => {
        setOpen(false);
        navigate(entry.route);
      },
    }, entry.label);

  return createElement("div", { className: "scout-nav-system", ref: rootRef },
    createElement("button", {
      type: "button",
      className: `scout-nav-action scout-nav-action--system${isSystemRoute(route) ? " active" : ""}`,
      "aria-haspopup": "menu",
      "aria-expanded": open,
      title: "System",
      onClick: () => setOpen((current) => !current),
    },
      createElement("span", null, "System"),
      createElement("span", { className: "scout-nav-system-caret", "aria-hidden": true }, "▾"),
    ),
    open && createElement("div", { className: "scout-nav-system-menu", role: "menu" },
      CORE_SYSTEM_MENU_ENTRIES.map(renderEntry),
      opsEnabled && createElement("div", { className: "scout-nav-system-divider", role: "separator" }),
      opsEnabled && SYSTEM_OPS_ENTRIES
        .filter((entry) => entry.capability !== "surface.mesh-ops" || meshOpsEnabled)
        .map(renderEntry),
    ),
  );
}
