import { renderWithMentions } from "../lib/mentions.tsx";
import { workTone } from "../lib/status-tone.ts";
import { timeAgo } from "../lib/time.ts";
import { useScout } from "../scout/Provider.tsx";
import { openContent } from "../scout/slots/openContent.ts";
import type { Route, WorkItem } from "../lib/types.ts";
import { StatusPill } from "./StatusPill.tsx";

function stateLabel(state: string): string {
  switch (state) {
    case "review":
      return "In review";
    case "waiting":
      return "Waiting";
    case "working":
      return "Working";
    case "done":
      return "Done";
    default:
      return state.replace(/_/g, " ");
  }
}

function attentionLabel(attention: WorkItem["attention"]): string | null {
  switch (attention) {
    case "badge":
      return "Noteworthy";
    case "interrupt":
      return "Blocked signal";
    default:
      return null;
  }
}

type WorkListProps = {
  items: WorkItem[];
  navigate: (route: Route) => void;
  emptyTitle: string;
  emptyDetail?: string;
  onDismissAttention?: (work: WorkItem) => void;
  dismissingId?: string | null;
};

export function WorkList({
  items,
  navigate,
  emptyTitle,
  emptyDetail,
}: WorkListProps) {
  const { route } = useScout();
  if (items.length === 0) {
    const placeholderRows = [
      {
        titleWidth: "56%",
        metaWidths: ["18%", "14%", "16%"],
        summaryWidth: "74%",
      },
      {
        titleWidth: "48%",
        metaWidths: ["16%", "20%", "12%"],
        summaryWidth: "62%",
      },
    ];

    return (
      <div className="s-work-empty-state">
        <div className="s-work-empty-copy">
          <p className="s-work-empty-kicker">Quiet for now</p>
          <p className="s-work-empty-title">{emptyTitle}</p>
          {emptyDetail && <p className="s-work-empty-detail">{emptyDetail}</p>}
        </div>
        <div className="s-work-empty-skeleton" aria-hidden="true">
          {placeholderRows.map((row, index) => (
            <div key={index} className="s-work-empty-row">
              <div className="s-work-empty-row-header">
                <span className="s-work-empty-line s-work-empty-line-title" style={{ width: row.titleWidth }} />
                <span className="s-work-empty-pill" />
              </div>
              <div className="s-work-empty-row-meta">
                {row.metaWidths.map((width) => (
                  <span key={width} className="s-work-empty-line s-work-empty-line-meta" style={{ width }} />
                ))}
              </div>
              <span className="s-work-empty-line s-work-empty-line-summary" style={{ width: row.summaryWidth }} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="s-work-list">
      {items.map((work) => {
        const clickable = Boolean(work.id) || Boolean(work.conversationId);
        const attention = attentionLabel(work.attention);
        const ownerLabel = work.ownerName ?? work.ownerId ?? "Unassigned";

        const onClick = work.id
          ? () => openContent(navigate, { view: "work", workId: work.id }, { returnTo: route })
          : work.conversationId
          ? () => openContent(navigate, { view: "conversation", conversationId: work.conversationId! }, { returnTo: route })
          : undefined;

        return (
          <div
            key={work.id}
            className={`s-work-row${clickable ? " s-work-row-clickable" : ""}`}
            onClick={onClick}
          >
            <div className="s-work-row-header">
              <div className="s-work-row-title-wrap">
                <span className="s-work-row-title">{work.title}</span>
                {work.priority && <span className="s-badge">{work.priority}</span>}
              </div>
              <StatusPill tone={workTone(work)} variant="pill">{work.currentPhase}</StatusPill>
            </div>
            <div className="s-work-row-meta">
              <span>{ownerLabel}</span>
              <span>{stateLabel(work.state)}</span>
              {work.activeChildWorkCount > 0 && (
                <span>{work.activeChildWorkCount} child{work.activeChildWorkCount === 1 ? "" : "ren"}</span>
              )}
              {work.activeFlightCount > 0 && (
                <span>{work.activeFlightCount} flight{work.activeFlightCount === 1 ? "" : "s"}</span>
              )}
              {attention && <span>{attention}</span>}
              <span>{timeAgo(work.lastMeaningfulAt)}</span>
            </div>
            {work.lastMeaningfulSummary && (
              <p className="s-work-row-summary">{renderWithMentions(work.lastMeaningfulSummary)}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}
