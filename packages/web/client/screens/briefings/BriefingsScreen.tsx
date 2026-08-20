import { useCallback, useEffect, useState } from "react";
import { EmptyState } from "../../components/EmptyState.tsx";
import { api } from "../../lib/api.ts";
import { timeAgo } from "../../lib/time.ts";
import type { Route } from "../../lib/types.ts";
import "../system-surfaces-redesign.css";
import "./briefings.css";

type BriefingKind = "fleet-home" | "tour";

type BriefingSummary = {
  id: string;
  kind: BriefingKind;
  title: string;
  summary: string;
  recommendation: string | null;
  preparedAt: number;
  ttlMs: number;
  observationCount: number;
  createdAt: number;
};

const KIND_LABEL: Record<BriefingKind, string> = {
  "fleet-home": "fleet",
  tour: "tour",
};

export function BriefingsScreen({ navigate }: { navigate: (r: Route) => void }) {
  const [items, setItems] = useState<BriefingSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await api<{ briefings: BriefingSummary[] }>(
        "/api/briefings?limit=50",
      );
      setItems(response.briefings);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load briefings");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="sys-surface-page sys-surface-page-wide">
      <div className="sys-page-head">
        <div className="sys-page-title-group">
          <h2 className="sys-page-title">Briefings</h2>
          <p className="sys-page-subtitle">
            Scoutbot's archived fleet briefs — what it told you, when, and what
            it saw. Rolling 100.
          </p>
        </div>
        <div className="sys-page-actions">
          <button
            type="button"
            className="s-btn"
            disabled={refreshing}
            onClick={() => void load()}
          >
            {refreshing ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>

      {error ? (
        <EmptyState title="Couldn't load briefings" body={error} />
      ) : items === null ? (
        <div className="briefings-placeholder">Loading briefings...</div>
      ) : items.length === 0 ? (
        <EmptyState
          title="No briefings yet"
          body="Scoutbot writes here when it generates a fleet brief — either on Home or via tour. Briefs land in this archive automatically."
        />
      ) : (
        <ul className="briefings-list">
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="briefing-row"
                onClick={() => navigate({ view: "briefings", briefingId: item.id })}
              >
                <div className="briefing-row-head">
                  <span className={`briefing-kind briefing-kind-${item.kind}`}>
                    {KIND_LABEL[item.kind]}
                  </span>
                  <span className="briefing-row-title">{item.title}</span>
                  <span className="briefing-row-time">
                    {timeAgo(item.preparedAt)}
                  </span>
                </div>
                <div className="briefing-row-summary">{item.summary}</div>
                <div className="briefing-row-meta">
                  <span>{item.observationCount} observations</span>
                  {item.recommendation ? <span>· {item.recommendation}</span> : null}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
