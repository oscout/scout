import { ChevronDown, ChevronRight, MessageSquare } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useScout } from "../../scout/Provider.tsx";
import { openContent } from "../../scout/slots/openContent.ts";
import { api } from "../../lib/api.ts";
import { useBrokerEvents } from "../../lib/sse.ts";
import { fullTimestamp, timeAgo } from "../../lib/time.ts";
import type { WorkDetail, WorkTimelineItem } from "../../lib/types.ts";

const TIMELINE_LIMIT = 5;

export function WorkInspector() {
  const { route, navigate } = useScout();
  const workId = route.view === "work" ? route.workId : null;
  const [detail, setDetail] = useState<WorkDetail | null>(null);

  const load = useCallback(async () => {
    if (!workId) {
      setDetail(null);
      return;
    }
    try {
      setDetail(await api<WorkDetail>(`/api/work/${encodeURIComponent(workId)}`));
    } catch {
      setDetail(null);
    }
  }, [workId]);

  useEffect(() => {
    void load();
  }, [load]);
  useBrokerEvents(() => {
    if (!workId) {
      return;
    }
    void load();
  });

  if (route.view !== "work") return null;

  if (!detail) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-sm font-mono uppercase tracking-[0.15em] text-[var(--scout-chrome-ink-ghost)]">
        Loading work item…
      </div>
    );
  }

  const stateColor = stateToColor(detail.state);
  const signal = signalLabel(detail.attention);
  const ownerLabel = detail.ownerName ?? detail.ownerId ?? "Unassigned";
  const nextMoveLabel = detail.nextMoveOwnerName ?? detail.nextMoveOwnerId ?? null;
  const showNextMove =
    nextMoveLabel !== null &&
    (detail.ownerId ?? null) !== (detail.nextMoveOwnerId ?? null) &&
    nextMoveLabel !== ownerLabel;

  const routingCount =
    1 +
    (showNextMove ? 1 : 0) +
    (detail.priority ? 1 : 0) +
    2 + // children, flights
    (detail.parentId ? 1 : 0) +
    (detail.conversationId ? 1 : 0);

  return (
    <div className="flex flex-col h-full overflow-y-auto frame-scrollbar text-sm">
      <div
        className="sticky top-0 z-10 border-b border-[var(--scout-chrome-border-soft)] bg-black/55 px-4 py-2 backdrop-blur"
      >
        <div className="flex items-center gap-2">
          <span className={`h-1.5 w-1.5 rounded-full ${stateColor.dot}`} />
          <span className={`font-mono text-xs uppercase tracking-[0.15em] ${stateColor.text}`}>
            {stateLabel(detail.state)}
          </span>
          <span className="min-w-0 flex-1 truncate text-xs text-[var(--scout-chrome-ink-faint)]">
            <span className="text-[var(--scout-chrome-ink)]">{ownerLabel}</span>
            {showNextMove && (
              <>
                <span className="px-1 text-[var(--scout-chrome-ink-ghost)]">→</span>
                <span className="text-[var(--scout-chrome-ink)]">{nextMoveLabel}</span>
              </>
            )}
          </span>
          {signal && (
            <span className="shrink-0 rounded border border-amber-400/30 bg-amber-400/10 px-1.5 py-0.5 font-mono text-2xs uppercase tracking-[0.12em] text-amber-300/90">
              {signal}
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-4 p-4">
        <Section label="Case facts">
          <Row label="Phase" value={detail.currentPhase} />
          <Row label="Acceptance" value={detail.acceptanceState.replace(/_/g, " ")} />
          {detail.priority && <Row label="Priority" value={detail.priority} />}
        </Section>

        <Section label="Timeline">
          {detail.timeline.length === 0 ? (
            <div className="text-xs text-[var(--scout-chrome-ink-faint)]">No activity yet.</div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {detail.timeline.slice(0, TIMELINE_LIMIT).map((item) => (
                <TimelineEntry
                  key={item.id}
                  item={item}
                  onOpen={
                    item.conversationId
                      ? () => openContent(navigate, { view: "conversation", conversationId: item.conversationId! }, { returnTo: route })
                      : undefined
                  }
                />
              ))}
            </div>
          )}
        </Section>

        <Section label="Routing" collapsible defaultOpen={false} count={routingCount}>
          <Row label="Owner" value={ownerLabel} />
          {showNextMove && nextMoveLabel && <Row label="Next move" value={nextMoveLabel} />}
          {detail.priority && <Row label="Priority" value={detail.priority} />}
          <Row label="Children" value={`${detail.activeChildWorkCount}`} />
          <Row label="Flights" value={`${detail.activeFlightCount}`} />
          {detail.lastMeaningfulAt && (
            <Row label="Last update" value={timeAgo(detail.lastMeaningfulAt)} />
          )}
          {(detail.conversationId || detail.parentId) && (
            <div className="mt-2 flex flex-col gap-1.5">
              {detail.conversationId && (
                <InspectorActionButton
                  label="Open thread"
                  onClick={() => openContent(navigate, { view: "conversation", conversationId: detail.conversationId! }, { returnTo: route })}
                />
              )}
              {detail.parentId && detail.parentTitle && (
                <InspectorActionButton
                  label={detail.parentTitle}
                  eyebrow="Parent"
                  onClick={() => openContent(navigate, { view: "work", workId: detail.parentId! }, { returnTo: route })}
                />
              )}
            </div>
          )}
        </Section>

        <Section label="Record" collapsible defaultOpen={false}>
          <Row label="Case ID" value={detail.id} />
          <Row label="Created" value={fullTimestamp(detail.createdAt)} />
          <Row label="Updated" value={fullTimestamp(detail.updatedAt)} />
          <Row label="Last activity" value={fullTimestamp(detail.lastMeaningfulAt)} />
        </Section>

        {detail.lastMeaningfulSummary && (
          <Section label="Hudson context" collapsible defaultOpen={false}>
            <div className="text-sm italic leading-relaxed text-[var(--scout-chrome-ink-soft)]">
              {detail.lastMeaningfulSummary}
            </div>
            <div className="mt-2 flex gap-1.5">
              <span className="rounded border border-[var(--scout-chrome-border-soft)] px-1.5 py-0.5 font-mono text-2xs uppercase tracking-[0.12em] text-[var(--scout-chrome-ink-faint)]">
                Plan
              </span>
              <span className="rounded border border-[var(--scout-chrome-border-soft)] px-1.5 py-0.5 font-mono text-2xs uppercase tracking-[0.12em] text-[var(--scout-chrome-ink-faint)]">
                Docs
              </span>
              <span className="rounded border border-[var(--scout-chrome-border-soft)] px-1.5 py-0.5 font-mono text-2xs uppercase tracking-[0.12em] text-[var(--scout-chrome-ink-faint)]">
                Code
              </span>
            </div>
          </Section>
        )}
      </div>
    </div>
  );
}

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

function signalLabel(attention: WorkDetail["attention"]): string | null {
  switch (attention) {
    case "badge":
      return "Noteworthy";
    case "interrupt":
      return "Blocked";
    default:
      return null;
  }
}

function stateToColor(state: string): { dot: string; text: string } {
  if (/complete|done|finished/i.test(state))
    return { dot: "bg-emerald-400", text: "text-emerald-300/90" };
  if (/fail|error/i.test(state))
    return { dot: "bg-red-400", text: "text-red-300/90" };
  if (/block|wait|pause/i.test(state))
    return { dot: "bg-amber-400", text: "text-amber-300/90" };
  if (/active|working|in[_-]?progress/i.test(state))
    return { dot: "bg-cyan-400", text: "text-cyan-300/90" };
  return {
    dot: "bg-[var(--scout-chrome-ink-faint)]",
    text: "text-[var(--scout-chrome-ink)]",
  };
}

function Section({
  label,
  children,
  collapsible = false,
  defaultOpen = true,
  count,
}: {
  label: string;
  children: React.ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  count?: number;
}) {
  const [open, setOpen] = useState(defaultOpen);

  if (!collapsible) {
    return (
      <div className="flex flex-col">
        <div className="mb-1.5 text-2xs font-mono uppercase tracking-[0.15em] text-[var(--scout-chrome-ink-faint)]">
          {label}
        </div>
        {children}
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1.5 text-left text-2xs font-mono uppercase tracking-[0.15em] text-[var(--scout-chrome-ink-faint)] hover:text-[var(--scout-chrome-ink)]"
      >
        {open ? (
          <ChevronDown aria-hidden="true" size={10} strokeWidth={2} />
        ) : (
          <ChevronRight aria-hidden="true" size={10} strokeWidth={2} />
        )}
        <span>{label}</span>
        {typeof count === "number" && count > 0 && (
          <span className="rounded border border-[var(--scout-chrome-border-soft)] px-1 py-0 font-mono text-3xs tracking-[0.1em] text-[var(--scout-chrome-ink-faint)]">
            {count}
          </span>
        )}
      </button>
      {open && <div className="mt-1.5">{children}</div>}
    </div>
  );
}

function InspectorActionButton({
  label,
  eyebrow,
  onClick,
}: {
  label: string;
  eyebrow?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center justify-between gap-2 rounded border border-[var(--scout-chrome-border-soft)] bg-white/[0.025] px-2 py-1.5 text-left hover:border-cyan-400/25 hover:bg-cyan-400/10"
    >
      <span className="min-w-0">
        {eyebrow && (
          <span className="block font-mono text-2xs uppercase tracking-[0.14em] text-[var(--scout-chrome-ink-faint)]">
            {eyebrow}
          </span>
        )}
        <span className="block truncate font-mono text-xs text-[var(--scout-chrome-ink)]">
          {label}
        </span>
      </span>
      <MessageSquare aria-hidden="true" size={11} strokeWidth={1.8} className="shrink-0 text-cyan-300/75" />
    </button>
  );
}

function TimelineEntry({
  item,
  onOpen,
}: {
  item: WorkTimelineItem;
  onOpen?: () => void;
}) {
  const content = (
    <>
      <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${timelineDotClass(item)}`} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2">
          <span className="font-mono text-2xs text-[var(--scout-chrome-ink-faint)]">{timeAgo(item.at)}</span>
          <span className="shrink-0 rounded border border-[var(--scout-chrome-border-soft)] px-1 py-0.5 font-mono text-3xs uppercase tracking-[0.12em] text-[var(--scout-chrome-ink-faint)]">
            {timelineKindLabel(item)}
          </span>
        </span>
        <span className="mt-0.5 block truncate text-xs font-semibold text-[var(--scout-chrome-ink-strong)]">
          {item.actorName ?? "system"}
        </span>
        {item.title && (
          <span className="mt-0.5 block truncate text-xs leading-snug text-[var(--scout-chrome-ink)]">
            {item.title}
          </span>
        )}
        {item.summary && (
          <span
            className="mt-0.5 block text-xs leading-relaxed text-[var(--scout-chrome-ink-faint)]"
            style={{ display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2, overflow: "hidden" }}
          >
            {item.summary}
          </span>
        )}
      </span>
    </>
  );

  const wrapperClass = "flex gap-2 border-t border-[var(--scout-chrome-border-soft)] pt-1.5 first:border-t-0 first:pt-0";
  const tooltip = fullTimestamp(item.at);

  if (!onOpen) {
    return (
      <div className={wrapperClass} title={tooltip}>
        {content}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      title={tooltip}
      className={`${wrapperClass} text-left hover:text-cyan-300/90`}
    >
      {content}
    </button>
  );
}

function timelineKindLabel(item: WorkTimelineItem): string {
  switch (item.kind) {
    case "flight_started":
      return "flight started";
    case "flight_completed":
      return item.detailKind ? `flight ${item.detailKind}` : "flight ended";
    case "message":
      return "message";
    case "collaboration_event":
    default:
      return item.title ?? item.detailKind ?? "event";
  }
}

function timelineDotClass(item: WorkTimelineItem): string {
  if (item.kind === "message") return "bg-cyan-400";
  if (item.kind === "flight_started") return "bg-lime-400";
  if (item.kind === "flight_completed") {
    return item.detailKind?.includes("fail") ? "bg-red-400" : "bg-emerald-400";
  }
  if (item.detailKind?.includes("interrupt") || item.detailKind?.includes("block")) return "bg-amber-400";
  return "bg-[var(--scout-chrome-ink-faint)]";
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between py-0.5 gap-2">
      <span className="shrink-0 text-xs font-mono uppercase tracking-wider text-[var(--scout-chrome-ink-faint)]">
        {label}
      </span>
      <span className="truncate text-sm font-mono text-[var(--scout-chrome-ink)]">
        {value}
      </span>
    </div>
  );
}
