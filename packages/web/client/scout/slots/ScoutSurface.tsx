import type { ReactNode } from "react";

/** Paints the Scout content area background (Hudson Frame is black chrome). */
export function ScoutSurface({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        background: "var(--bg)",
        color: "var(--ink)",
        minHeight: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div className="scout-surface-body">
        {children}
      </div>
    </div>
  );
}