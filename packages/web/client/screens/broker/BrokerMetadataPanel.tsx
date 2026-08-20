import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import {
  brokerMetadataJson,
  brokerMetadataPayload,
  brokerMetadataSummary,
  formatMetadataScalar,
  type BrokerMetadataSummaryEntry,
} from "./broker-display.ts";

function MetadataScalarRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="sys-broker-metadata-row">
      <span className="sys-broker-metadata-key">{label}</span>
      <code className="sys-broker-metadata-value">{value}</code>
    </div>
  );
}

function MetadataTreeNode({
  label,
  value,
  depth = 0,
  defaultOpen = true,
}: {
  label: string;
  value: unknown;
  depth?: number;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen && depth < 2);

  if (value === null || value === undefined) {
    return <MetadataScalarRow label={label} value="—" />;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <MetadataScalarRow label={label} value="[]" />;
    }
    const compact = value.every((entry) => typeof entry !== "object" || entry === null);
    if (compact) {
      return (
        <MetadataScalarRow
          label={label}
          value={value.map((entry) => formatMetadataScalar(entry)).join(", ")}
        />
      );
    }
    return (
      <div className="sys-broker-metadata-group" style={{ marginLeft: depth * 12 }}>
        <button
          type="button"
          className="sys-broker-metadata-group-toggle"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
        >
          {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
          <span className="sys-broker-metadata-group-label">{label}</span>
          <span className="sys-broker-metadata-count">{value.length} items</span>
        </button>
        {open && (
          <div className="sys-broker-metadata-children">
            {value.map((entry, index) => (
              <MetadataTreeNode
                key={`${label}-${index}`}
                label={`[${index}]`}
                value={entry}
                depth={depth + 1}
                defaultOpen={depth < 1}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      return <MetadataScalarRow label={label} value="{}" />;
    }
    return (
      <div className="sys-broker-metadata-group" style={{ marginLeft: depth * 12 }}>
        <button
          type="button"
          className="sys-broker-metadata-group-toggle"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
        >
          {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
          <span className="sys-broker-metadata-group-label">{label}</span>
          <span className="sys-broker-metadata-count">{entries.length} fields</span>
        </button>
        {open && (
          <div className="sys-broker-metadata-children">
            {entries.map(([key, entry]) => (
              <MetadataTreeNode
                key={`${label}-${key}`}
                label={key}
                value={entry}
                depth={depth + 1}
                defaultOpen={depth < 1}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  return <MetadataScalarRow label={label} value={formatMetadataScalar(value)} />;
}

function MetadataSummaryGrid({ entries }: { entries: BrokerMetadataSummaryEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <div className="sys-broker-inspector-rows">
      {entries.map((entry) => (
        <div key={entry.key} className="sys-broker-inspector-row">
          <span className="sys-detail-label">{entry.key}</span>
          <code className="sys-detail-value">{entry.value}</code>
        </div>
      ))}
    </div>
  );
}

export function BrokerMetadataPanel({
  metadata,
  rawJson,
}: {
  metadata: Record<string, unknown> | null | undefined;
  rawJson: string;
}) {
  const summary = useMemo(() => brokerMetadataSummary(metadata), [metadata]);
  const payload = useMemo(() => brokerMetadataPayload(metadata), [metadata]);
  const [showRaw, setShowRaw] = useState(false);

  if (!metadata || Object.keys(metadata).length === 0) {
    return (
      <div className="sys-broker-metadata-empty">
        No metadata payload attached to this dispatch row.
      </div>
    );
  }

  return (
    <div className="sys-broker-metadata-panel">
      {summary.length > 0 && (
        <section className="sys-broker-metadata-section">
          <div className="sys-broker-metadata-section-head">
            <span className="sys-detail-label">Summary</span>
          </div>
          <MetadataSummaryGrid entries={summary} />
        </section>
      )}

      {payload !== null && (
        <section className="sys-broker-metadata-section">
          <div className="sys-broker-metadata-section-head">
            <span className="sys-detail-label">Payload</span>
          </div>
          <div className="sys-broker-metadata-tree">
            <MetadataTreeNode label="payload" value={payload} defaultOpen />
          </div>
        </section>
      )}

      <section className="sys-broker-metadata-section">
        <button
          type="button"
          className="sys-broker-metadata-raw-toggle"
          onClick={() => setShowRaw((current) => !current)}
          aria-expanded={showRaw}
        >
          {showRaw ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
          Raw JSON
        </button>
        {showRaw && <pre className="sys-broker-metadata-raw">{rawJson || brokerMetadataJson(metadata)}</pre>}
      </section>
    </div>
  );
}