import type { DragEvent, KeyboardEvent } from "react";

export function ScopeLaneDragHandle({
  laneId,
  grabbed,
  onKeyMove,
  onDragStart,
  onDragEnd,
}: {
  laneId: string;
  grabbed?: boolean;
  onKeyMove?: (direction: "before" | "after") => void;
  onDragStart?: (laneId: string) => void;
  onDragEnd?: () => void;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (!event.altKey || !onKeyMove) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      onKeyMove("before");
      return;
    }
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      onKeyMove("after");
    }
  };

  const handleDragStart = (event: DragEvent<HTMLSpanElement>) => {
    event.stopPropagation();
    const transfer = event.dataTransfer;
    if (!transfer) return;
    transfer.setData("text/plain", laneId);
    transfer.effectAllowed = "move";
    const col = event.currentTarget.closest("[data-lane-id]");
    if (col instanceof HTMLElement) {
      transfer.setDragImage(col, Math.min(48, col.clientWidth / 2), 18);
      col.classList.add("is-dragging");
    }
    onDragStart?.(laneId);
  };

  const handleDragEnd = (event: DragEvent<HTMLSpanElement>) => {
    const col = event.currentTarget.closest("[data-lane-id]");
    col?.classList.remove("is-dragging");
    onDragEnd?.();
  };

  return (
    <span
      className="scope-lane__drag"
      role="button"
      tabIndex={0}
      draggable
      aria-grabbed={grabbed ? "true" : "false"}
      aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown"
      aria-label="Drag to reorder lane. Drop in a gutter for a new column. Alt+arrow keys also move."
      title="Drag to reorder · drop in gutters for a new column"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={onKeyDown}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      ⠿
    </span>
  );
}