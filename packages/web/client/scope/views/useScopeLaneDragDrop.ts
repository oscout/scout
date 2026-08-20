import {
  useCallback,
  useEffect,
  useRef,
  type DragEvent as ReactDragEvent,
  type RefObject,
} from "react";

const SLOT_EDGE = 0.22;
const SPLIT_TOP = 0.46;
const ROW_Y_TOLERANCE = 14;
const GRID_GAP = 12;

export type ScopeLaneDropMode = "reorder" | "stack" | null;

export type ScopeLaneDropState = {
  mode: ScopeLaneDropMode;
  before: boolean;
  slotIndex: number;
  stackBand: number;
  targetAgentId: string | null;
};

type PreviewRect = {
  top: number;
  left: number;
  width: number;
  height: number;
};

type DropIntent = {
  mode: "reorder" | "stack";
  before: boolean;
  slotIndex: number;
  stackBand?: number;
  targetAgentId?: string | null;
  label?: string;
  previewColumn?: boolean;
  stackPreview?: PreviewRect;
  slot: HTMLElement;
  col?: HTMLElement | null;
};

const EMPTY_DROP: ScopeLaneDropState = {
  mode: null,
  before: true,
  slotIndex: -1,
  stackBand: 0,
  targetAgentId: null,
};

function slotIndexFromEl(slot: HTMLElement, wrap: HTMLElement): number {
  return [...wrap.querySelectorAll(".scope-lane-space")].indexOf(slot);
}

function slotAgentIds(slot: HTMLElement): string[] {
  return [...slot.querySelectorAll("[data-lane-id]")]
    .map((col) => col.getAttribute("data-lane-id"))
    .filter((id): id is string => Boolean(id));
}

function firstColInSlot(slot: HTMLElement | null): HTMLElement | null {
  return slot?.querySelector("[data-lane-id]") ?? null;
}

function pickRowSlots(slots: HTMLElement[], clientY: number): HTMLElement[] {
  const anchored = slots.filter((slot) => {
    const rect = slot.getBoundingClientRect();
    return clientY >= rect.top - ROW_Y_TOLERANCE && clientY <= rect.bottom + ROW_Y_TOLERANCE;
  });
  if (!anchored.length) return [];
  const rowTop = anchored[0]!.getBoundingClientRect().top;
  return slots.filter((slot) => Math.abs(slot.getBoundingClientRect().top - rowTop) <= ROW_Y_TOLERANCE);
}

function laneDropIntent(fields: Partial<DropIntent> & Pick<DropIntent, "mode" | "slotIndex" | "slot">): DropIntent {
  return {
    before: false,
    stackBand: 0,
    targetAgentId: null,
    label: "",
    previewColumn: false,
    col: null,
    ...fields,
  };
}

function resolveLaneColumnInsert(wrap: HTMLElement, clientX: number, clientY: number): DropIntent | null {
  const slots = [...wrap.querySelectorAll<HTMLElement>(".scope-lane-space")];
  if (!slots.length) return null;

  const rowSlots = pickRowSlots(slots, clientY);
  if (!rowSlots.length) return null;

  const rowTop = rowSlots[0]!.getBoundingClientRect().top;
  const rowBottom = Math.max(...rowSlots.map((slot) => slot.getBoundingClientRect().bottom));
  if (clientY < rowTop - ROW_Y_TOLERANCE || clientY > rowBottom + ROW_Y_TOLERANCE) {
    return null;
  }

  const firstRect = rowSlots[0]!.getBoundingClientRect();
  const firstIdx = slotIndexFromEl(rowSlots[0]!, wrap);
  const leadGutter = Math.max(GRID_GAP * 3, firstRect.width * SLOT_EDGE);

  if (clientX <= firstRect.left + leadGutter) {
    return laneDropIntent({
      mode: "reorder",
      before: true,
      slotIndex: firstIdx,
      slot: rowSlots[0]!,
      col: firstColInSlot(rowSlots[0]!),
      label: "new column",
      previewColumn: true,
    });
  }

  for (let index = 0; index < rowSlots.length; index += 1) {
    const slot = rowSlots[index]!;
    const rect = slot.getBoundingClientRect();
    const slotIndex = slotIndexFromEl(slot, wrap);
    const next = rowSlots[index + 1];
    const tailGutter = Math.max(GRID_GAP * 3, rect.width * SLOT_EDGE);

    if (next) {
      const nextRect = next.getBoundingClientRect();
      const gapStart = rect.right - tailGutter * 0.4;
      const gapEnd = nextRect.left + tailGutter * 0.4;
      if (clientX >= gapStart && clientX <= gapEnd) {
        const gapMid = (rect.right + nextRect.left) / 2;
        if (clientX < gapMid) {
          return laneDropIntent({
            mode: "reorder",
            before: false,
            slotIndex,
            slot,
            col: firstColInSlot(slot),
            label: "new column",
            previewColumn: true,
          });
        }
        const nextIdx = slotIndexFromEl(next, wrap);
        return laneDropIntent({
          mode: "reorder",
          before: true,
          slotIndex: nextIdx,
          slot: next,
          col: firstColInSlot(next),
          label: "new column",
          previewColumn: true,
        });
      }
      continue;
    }

    if (clientX >= rect.right - tailGutter) {
      return laneDropIntent({
        mode: "reorder",
        before: false,
        slotIndex,
        slot,
        col: firstColInSlot(slot),
        label: "new column",
        previewColumn: true,
      });
    }
  }

  return null;
}

function laneDropTargetOnCol(
  clientX: number,
  clientY: number,
  col: HTMLElement,
  wrap: HTMLElement,
  dragLaneId: string,
  stackMax: number,
): DropIntent | null {
  const slot = col.closest<HTMLElement>(".scope-lane-space");
  if (!slot) return null;

  const colRect = col.getBoundingClientRect();
  const slotRect = slot.getBoundingClientRect();
  const slotIndex = slotIndexFromEl(slot, wrap);
  const slotIds = slotAgentIds(slot);
  const relY = (clientY - colRect.top) / colRect.height;
  const relXInCol = (clientX - colRect.left) / colRect.width;
  const relXInSlot = (clientX - slotRect.left) / slotRect.width;

  // Match Scope local: top band is column-relative, not slot-relative.
  if (relY < SPLIT_TOP) {
    if (relXInSlot < SLOT_EDGE) {
      return laneDropIntent({
        mode: "reorder",
        before: true,
        slotIndex,
        slot,
        col,
        label: "new column",
        previewColumn: true,
      });
    }
    if (relXInSlot > 1 - SLOT_EDGE) {
      return laneDropIntent({
        mode: "reorder",
        before: false,
        slotIndex,
        slot,
        col,
        label: "new column",
        previewColumn: true,
      });
    }
    const before = relXInCol < 0.5;
    return laneDropIntent({
      mode: "reorder",
      before,
      slotIndex,
      slot,
      col,
      label: "new column",
      previewColumn: true,
    });
  }

  const slotOrient = slot.dataset.orient || "row";
  if (stackMax <= 1) {
    const before = relXInCol < 0.5;
    return laneDropIntent({
      mode: "reorder",
      before,
      slotIndex,
      slot,
      col,
      label: "new column",
      previewColumn: true,
    });
  }
  if (slotOrient === "column" && slotIds.length >= stackMax && !slotIds.includes(dragLaneId)) {
    const before = relXInCol < 0.5;
    return laneDropIntent({
      mode: "reorder",
      before,
      slotIndex,
      slot,
      col,
      label: "new column",
      previewColumn: true,
    });
  }

  const stack = resolveStackInsert(slot, clientY);
  return laneDropIntent({
    mode: "stack",
    stackBand: stack.band,
    targetAgentId: col.getAttribute("data-lane-id"),
    slotIndex,
    slot,
    col,
    label: stack.label,
    stackPreview: stack.preview,
  });
}

function slotStackZonePreview(slotRect: DOMRect): PreviewRect {
  const stackTop = slotRect.top + slotRect.height * SPLIT_TOP;
  return {
    top: stackTop,
    left: slotRect.left,
    width: slotRect.width,
    height: Math.max(24, slotRect.bottom - stackTop),
  };
}

function isBottomStackBand(band: number, laneCount: number): boolean {
  if (laneCount <= 1) return band >= 1;
  return band >= laneCount;
}

function resolveStackInsert(slot: HTMLElement, clientY: number): {
  band: number;
  label: string;
  preview: PreviewRect;
} {
  const slotRect = slot.getBoundingClientRect();
  const lanes = [...slot.querySelectorAll<HTMLElement>("[data-lane-id]")];

  if (!lanes.length) {
    return {
      band: 0,
      label: "stack",
      preview: slotStackZonePreview(slotRect),
    };
  }

  if (lanes.length === 1) {
    const laneRect = lanes[0]!.getBoundingClientRect();
    const stackTop = laneRect.top + laneRect.height * SPLIT_TOP;
    const mid = laneRect.top + laneRect.height * 0.5;
    const band = clientY < mid ? 0 : 1;
    const preview = band === 0
      ? {
          top: stackTop,
          left: slotRect.left,
          width: slotRect.width,
          height: Math.max(18, mid - stackTop),
        }
      : slotStackZonePreview(slotRect);
    return {
      band,
      label: band === 0 ? "stack above" : "stack below",
      preview,
    };
  }

  let band = lanes.length;
  for (let index = 0; index < lanes.length; index += 1) {
    const laneRect = lanes[index]!.getBoundingClientRect();
    if (clientY < laneRect.top + laneRect.height / 2) {
      band = index;
      break;
    }
  }

  let preview: PreviewRect;
  if (isBottomStackBand(band, lanes.length)) {
    preview = slotStackZonePreview(slotRect);
  } else if (band === 0) {
    const laneRect = lanes[0]!.getBoundingClientRect();
    preview = {
      top: laneRect.top,
      left: slotRect.left,
      width: slotRect.width,
      height: Math.max(18, laneRect.height * 0.5),
    };
  } else {
    const above = lanes[band - 1]!.getBoundingClientRect();
    const below = lanes[band]!.getBoundingClientRect();
    const gapMid = (above.bottom + below.top) / 2;
    preview = {
      top: gapMid - 10,
      left: slotRect.left,
      width: slotRect.width,
      height: 20,
    };
  }

  const label = band === 0
    ? "stack top"
    : isBottomStackBand(band, lanes.length)
      ? "stack bottom"
      : "stack between";

  return { band, label, preview };
}

function laneDropTarget(
  clientX: number,
  clientY: number,
  wrap: HTMLElement,
  dragLaneId: string,
  stackMax: number,
): DropIntent | null {
  const hit = document.elementFromPoint(clientX, clientY);
  if (hit && wrap.contains(hit)) {
    const col = hit.closest<HTMLElement>("[data-lane-id]");
    const colId = col?.getAttribute("data-lane-id");
    if (col && colId && colId !== dragLaneId && !col.classList.contains("is-dragging")) {
      return laneDropTargetOnCol(clientX, clientY, col, wrap, dragLaneId, stackMax);
    }
  }
  return resolveLaneColumnInsert(wrap, clientX, clientY);
}

function columnWidth(wrap: HTMLElement): number {
  const slot = wrap.querySelector<HTMLElement>(".scope-lane-space");
  return slot?.getBoundingClientRect().width || 360;
}

function dropPreviewKey(target: DropIntent): string {
  return [
    target.mode,
    target.slotIndex,
    target.before,
    target.stackBand,
    target.targetAgentId,
    target.label,
    target.previewColumn,
    target.col?.getAttribute("data-lane-id"),
  ].join("|");
}

function showDropPreview(
  indicator: HTMLElement,
  wrap: HTMLElement,
  target: DropIntent,
  stackMax: number,
) {
  const wrapRect = wrap.getBoundingClientRect();
  const slotRect = target.slot.getBoundingClientRect();

  if (target.mode === "stack") {
    const preview = target.stackPreview ?? slotStackZonePreview(slotRect);
    const bottomStack = target.label === "stack below" || target.label === "stack bottom";
    indicator.hidden = false;
    indicator.className = `scope-lane-drop is-band${bottomStack ? " is-bottom-stack" : ""}`;
    indicator.dataset.mode = "stack";
    indicator.dataset.label = target.label || "";
    indicator.style.transform = `translate(${preview.left - wrapRect.left + wrap.scrollLeft}px, ${preview.top - wrapRect.top + wrap.scrollTop}px)`;
    indicator.style.width = `${preview.width}px`;
    indicator.style.height = `${preview.height}px`;
    return;
  }

  if (target.previewColumn) {
    const colW = columnWidth(wrap);
    const slots = [...wrap.querySelectorAll<HTMLElement>(".scope-lane-space")];
    const rowSlots = pickRowSlots(slots, slotRect.top + slotRect.height / 2);
    const rowRects = (rowSlots.length ? rowSlots : [target.slot]).map((entry) => entry.getBoundingClientRect());
    const colH = Math.max(...rowRects.map((rect) => rect.height), slotRect.height);
    const rowTop = Math.min(...rowRects.map((rect) => rect.top));
    const x = Math.max(
      0,
      target.before
        ? slotRect.left - wrapRect.left + wrap.scrollLeft - colW - GRID_GAP / 2
        : slotRect.right - wrapRect.left + wrap.scrollLeft + GRID_GAP / 2,
    );
    indicator.hidden = false;
    indicator.className = "scope-lane-drop is-column";
    indicator.dataset.mode = "column";
    indicator.dataset.label = target.label || "";
    indicator.style.transform = `translate(${x}px, ${rowTop - wrapRect.top + wrap.scrollTop}px)`;
    indicator.style.width = `${colW}px`;
    indicator.style.height = `${colH}px`;
    return;
  }

  const orient = target.slot.dataset.orient || "row";
  let x: number;
  let y: number;
  let width: number;
  let height: number;
  if (orient === "column") {
    x = slotRect.left - wrapRect.left + wrap.scrollLeft;
    y = (target.before ? slotRect.top : slotRect.bottom) - wrapRect.top + wrap.scrollTop - 2;
    width = slotRect.width;
    height = 3;
  } else {
    x = (target.before ? slotRect.left : slotRect.right) - wrapRect.left + wrap.scrollLeft - 2;
    y = slotRect.top - wrapRect.top + wrap.scrollTop;
    width = 3;
    height = slotRect.height;
  }
  indicator.hidden = false;
  indicator.className = "scope-lane-drop is-line";
  indicator.dataset.mode = "reorder";
  indicator.dataset.label = target.label || "";
  indicator.style.transform = `translate(${x}px, ${y}px)`;
  indicator.style.width = `${width}px`;
  indicator.style.height = `${height}px`;
}

function clearDropUi(
  wrap: HTMLElement | null,
  indicator: HTMLElement | null,
  options: { keepIndicator?: boolean } = {},
) {
  if (!options.keepIndicator && indicator) {
    indicator.hidden = true;
    indicator.className = "scope-lane-drop";
    delete indicator.dataset.label;
    delete indicator.dataset.mode;
    indicator.style.transform = "";
    indicator.style.width = "";
    indicator.style.height = "";
  }
  if (!wrap) return;
  wrap.querySelectorAll(".scope-lane-space").forEach((slot) => {
    delete (slot as HTMLElement).dataset.dropZone;
  });
  wrap.querySelectorAll("[data-lane-id].is-drop-target").forEach((col) => {
    col.classList.remove("is-drop-target");
    delete (col as HTMLElement).dataset.dropZone;
    delete (col as HTMLElement).dataset.dropLabel;
  });
}

export function useScopeLaneDragDrop({
  stackMax,
  onReorder,
  onStack,
  indicatorRef,
}: {
  stackMax: number;
  onReorder: (fromId: string, slotIndex: number, before: boolean) => void;
  onStack: (fromId: string, slotIndex: number, stackBand: number) => void;
  indicatorRef: RefObject<HTMLDivElement | null>;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const dragLaneIdRef = useRef<string | null>(null);
  const dropStateRef = useRef<ScopeLaneDropState>(EMPTY_DROP);
  const previewKeyRef = useRef("");

  const setDraggingShell = useCallback((active: boolean) => {
    scrollRef.current?.closest(".scope-lanes")?.classList.toggle("is-dragging", active);
  }, []);

  const onDragStart = useCallback((laneId: string) => {
    dragLaneIdRef.current = laneId;
    previewKeyRef.current = "";
    dropStateRef.current = EMPTY_DROP;
    setDraggingShell(true);
  }, [setDraggingShell]);

  const onDragEnd = useCallback(() => {
    dragLaneIdRef.current = null;
    previewKeyRef.current = "";
    dropStateRef.current = EMPTY_DROP;
    clearDropUi(scrollRef.current, indicatorRef.current);
    setDraggingShell(false);
  }, [indicatorRef, setDraggingShell]);

  const onDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    const dragLaneId = dragLaneIdRef.current;
    if (!dragLaneId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";

    const wrap = scrollRef.current;
    const indicator = indicatorRef.current;
    if (!wrap || !indicator) return;

    const target = laneDropTarget(event.clientX, event.clientY, wrap, dragLaneId, stackMax);
    if (!target) {
      if (previewKeyRef.current) {
        previewKeyRef.current = "";
        clearDropUi(wrap, indicator);
      }
      return;
    }

    const key = dropPreviewKey(target);
    if (key === previewKeyRef.current) return;

    const keepIndicator = Boolean(previewKeyRef.current && target.mode === "reorder");
    previewKeyRef.current = key;
    dropStateRef.current = {
      mode: target.mode,
      before: target.before,
      slotIndex: target.slotIndex,
      stackBand: target.stackBand ?? 0,
      targetAgentId: target.targetAgentId ?? null,
    };

    clearDropUi(wrap, indicator, { keepIndicator });
    if (target.col) {
      target.col.classList.add("is-drop-target");
      target.col.dataset.dropZone = target.mode;
      if (target.label) target.col.dataset.dropLabel = target.label;
    }
    target.slot.dataset.dropZone = target.mode;
    showDropPreview(indicator, wrap, target, stackMax);
  }, [indicatorRef, stackMax]);

  const onDrop = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const fromId = event.dataTransfer.getData("text/plain") || dragLaneIdRef.current;
    const dropState = dropStateRef.current;
    if (!fromId || dropState.slotIndex < 0 || !dropState.mode) {
      onDragEnd();
      return;
    }

    if (dropState.mode === "stack") {
      onStack(fromId, dropState.slotIndex, dropState.stackBand);
    } else {
      onReorder(fromId, dropState.slotIndex, dropState.before);
    }

    onDragEnd();
  }, [onDragEnd, onReorder, onStack]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !dragLaneIdRef.current) return;
      onDragEnd();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDragEnd]);

  return {
    scrollRef,
    onDragStart,
    onDragEnd,
    scrollDragProps: {
      onDragEnter: (event: ReactDragEvent<HTMLDivElement>) => {
        if (dragLaneIdRef.current) event.preventDefault();
      },
      onDragOver,
      onDrop,
    },
  };
}