/**
 * Minified right-rail body while the inspector is collapsed.
 *
 * Icon stack only. Expanding is the band toggle's job — it sits in the
 * inspector's 44px header band in both states (see CollapsedRail). These chips
 * are a preview of what is behind the rail, and clicking one opens it.
 */
import {
  Activity,
  FolderOpen,
  MessageSquare,
  Users,
} from "lucide-react";
import type { Route } from "../../lib/types.ts";
import {
  CollapsedChip,
  CollapsedStrip,
} from "./CollapsedStrip.tsx";

export function InspectorCollapsedBody({
  route,
  onExpand,
}: {
  route: Route;
  onExpand: () => void;
}) {
  const isMessages = route.view === "messages" || route.view === "conversation";

  if (isMessages) {
    return (
      <CollapsedStrip label="Context" showLabel={false} emptyMark="·">
        <CollapsedChip
          title="Conversation"
          tone="neutral"
          glyph={<MessageSquare size={14} strokeWidth={1.7} aria-hidden />}
          onClick={onExpand}
        />
        <CollapsedChip
          title="Members"
          tone="neutral"
          glyph={<Users size={14} strokeWidth={1.7} aria-hidden />}
          onClick={onExpand}
        />
        <CollapsedChip
          title="Workspace"
          tone="neutral"
          glyph={<FolderOpen size={14} strokeWidth={1.7} aria-hidden />}
          onClick={onExpand}
        />
        <CollapsedChip
          title="Activity"
          tone="neutral"
          glyph={<Activity size={14} strokeWidth={1.7} aria-hidden />}
          onClick={onExpand}
        />
      </CollapsedStrip>
    );
  }

  return (
    <CollapsedStrip label="Context" showLabel={false} emptyMark="·">
      <CollapsedChip
        title="Expand context"
        tone="neutral"
        glyph={<MessageSquare size={14} strokeWidth={1.7} aria-hidden />}
        onClick={onExpand}
      />
    </CollapsedStrip>
  );
}
