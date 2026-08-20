import type { ReactNode } from "react";

export function Viewer({
  className,
  children,
}: {
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={className ? `rd-viewer ${className}` : "rd-viewer"} data-scout-theme>
      {children}
    </div>
  );
}

export function Center({ children }: { children: ReactNode }) {
  return (
    <div className="rd-center">
      <div className="rd-center-card">{children}</div>
    </div>
  );
}
