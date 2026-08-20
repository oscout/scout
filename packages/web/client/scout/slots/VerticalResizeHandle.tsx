import { useCallback, type MouseEvent } from "react";

interface VerticalResizeHandleProps {
  onResizeStart: (event: MouseEvent<HTMLDivElement>) => void;
}

export function VerticalResizeHandle({ onResizeStart }: VerticalResizeHandleProps) {
  const handleMouseDown = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      onResizeStart(event);
    },
    [onResizeStart],
  );

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      onMouseDown={handleMouseDown}
      className="group relative flex h-[7px] shrink-0 cursor-ns-resize items-center justify-center"
    >
      <div className="absolute inset-x-0 top-0 h-px bg-[var(--scout-chrome-border-soft)] transition-colors group-hover:bg-[var(--scout-chrome-ink-faint)]" />
      <div className="flex flex-row gap-[3px] opacity-0 transition-opacity group-hover:opacity-100">
        <div className="h-[3px] w-[3px] rounded-full bg-[var(--scout-chrome-ink-faint)]" />
        <div className="h-[3px] w-[3px] rounded-full bg-[var(--scout-chrome-ink-faint)]" />
        <div className="h-[3px] w-[3px] rounded-full bg-[var(--scout-chrome-ink-faint)]" />
      </div>
    </div>
  );
}
