import { SlidePanel } from "../../components/SlidePanel/SlidePanel.tsx";
import type { ObserveEvent } from "../../lib/types.ts";
import type { AgentLane } from "../../screens/ops/agent-lanes-model.ts";
import { buildScopeLaneHeader } from "./lane-present.ts";
import { ScopeLaneDetailView } from "./ScopeLaneDetailView.tsx";

export type ScopeLaneTraceTarget = {
  lane: AgentLane;
  event: ObserveEvent;
};

export function ScopeLaneTraceSheet({
  target,
  onClose,
}: {
  target: ScopeLaneTraceTarget;
  onClose: () => void;
}) {
  const { lane, event } = target;
  const header = buildScopeLaneHeader(lane);

  return (
    <SlidePanel
      open
      onClose={onClose}
      side="right"
      owner="scope.lane-trace"
      layer="elevated"
      resizable
      defaultSize={980}
      minSize={560}
      maxSize={1280}
      scrollLock
      ariaLabel={`${header.source} ${header.sessionRef} trace`}
      className="scope-lane-trace-sheet"
      data-scope-presentation
    >
      <div className="scope-lane-trace-sheet__toolbar">
        <button
          type="button"
          className="scope-lane-trace-sheet__close"
          onClick={onClose}
          aria-label="Close"
        >
          ×
        </button>
      </div>
      <ScopeLaneDetailView lane={lane} event={event} />
    </SlidePanel>
  );
}