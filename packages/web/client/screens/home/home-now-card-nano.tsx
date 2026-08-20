import type { LanePopGroup } from "../ops/AgentLaneCard.tsx";

export function HomeNowNanoStat({
  value,
  label,
  group,
}: {
  value: number;
  label: string;
  group?: LanePopGroup;
}) {
  const hasPop = Boolean(group && group.rows.length > 0);
  return (
    <span className={`s-now-card-nano${hasPop ? " s-now-card-nano--pop" : ""}`}>
      <span className="s-now-card-nano-val">{value}</span>
      <span className="s-now-card-nano-label">{label}</span>
      {hasPop ? (
        <span className="s-now-card-nano-pop" role="tooltip">
          <span className="s-now-card-nano-pop-h">
            <span className="s-now-card-nano-pop-title">{label}</span>
            <span className="s-now-card-nano-pop-count">
              {group!.more > 0 ? `top ${group!.rows.length} · ${value}` : value}
            </span>
          </span>
          <span className="s-now-card-nano-pop-list">
            {group!.rows.map((row, index) => (
              <span
                className="s-now-card-nano-pop-row"
                key={`${index}:${row.full || row.text}`}
                title={row.full ?? row.text}
              >
                <span className={`s-now-card-nano-mark s-now-card-nano-mark--${row.tone}`}>
                  {row.mark}
                </span>
                <span className="s-now-card-nano-pop-text">{row.text}</span>
              </span>
            ))}
            {group!.more > 0 ? (
              <span className="s-now-card-nano-pop-more">+{group!.more} more</span>
            ) : null}
          </span>
        </span>
      ) : null}
    </span>
  );
}

export function HomeNowFilesPanel({
  label,
  group,
}: {
  label: string;
  group: LanePopGroup;
}) {
  if (group.rows.length === 0) return null;
  return (
    <div className="s-now-card-files" aria-label={label}>
      <div className="s-now-card-files-head">
        <span className="s-now-card-files-title">{label}</span>
        <span className="s-now-card-files-count">{group.rows.length + group.more}</span>
      </div>
      <div className="s-now-card-files-list">
        {group.rows.map((row, index) => (
          <span
            className="s-now-card-files-row"
            key={`${index}:${row.full || row.text}`}
            title={row.full ?? row.text}
          >
            <span className={`s-now-card-nano-mark s-now-card-nano-mark--${row.tone}`}>
              {row.mark}
            </span>
            <span className="s-now-card-files-text">{row.text}</span>
          </span>
        ))}
        {group.more > 0 ? (
          <span className="s-now-card-files-row s-now-card-files-row--more">
            +{group.more} more
          </span>
        ) : null}
      </div>
    </div>
  );
}