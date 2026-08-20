import "./knowledge-search.css";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Copy,
  ExternalLink,
  FileJson,
  Loader2,
  MessageSquareText,
  RadioTower,
  X,
} from "lucide-react";

import { api } from "../../lib/api.ts";
import {
  buildConversationExcerpt,
  facetText,
  firstFileRef,
  firstTranscriptRef,
  highlightParts,
  matchExplanation,
  pathLabel,
  previewRecordKindLabel,
  previewRecordPriority,
  scoreMatchKind,
  sourceReference,
  transcriptSessionId,
  transcriptTailQuery,
  type KnowledgeSourcePreview,
  type KnowledgeSourcePreviewRecord,
} from "../../lib/knowledge-search.ts";
import { useScout } from "../../scout/Provider.tsx";

function HighlightedText({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlightParts(text, query).map((part, index) =>
        part.match ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>,
      )}
    </>
  );
}

function recordText(record: KnowledgeSourcePreviewRecord): string {
  return record.renderedText || record.summary || record.raw;
}

function ConversationTurn({
  record,
  role,
  query,
  expanded,
  onToggle,
}: {
  record: KnowledgeSourcePreviewRecord;
  role: string;
  query: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const bodyRef = useRef<HTMLParagraphElement>(null);
  const [canExpand, setCanExpand] = useState(false);
  const text = recordText(record);

  const measureOverflow = useCallback(() => {
    const body = bodyRef.current;
    if (!body || expanded) return;
    setCanExpand(body.scrollHeight > body.clientHeight + 1);
  }, [expanded]);

  useEffect(() => {
    measureOverflow();
    const body = bodyRef.current;
    if (!body || expanded || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measureOverflow);
    observer.observe(body);
    return () => observer.disconnect();
  }, [expanded, measureOverflow, query, text]);

  return (
    <article className={`ks-excerpt-turn${record.matched ? " ks-excerpt-turn--matched" : ""}`}>
      <header>
        <span>{String(record.index).padStart(4, "0")}</span>
        <strong>{role}</strong>
        {record.matched ? <em>match</em> : null}
      </header>
      <p ref={bodyRef} className={expanded ? "is-expanded" : undefined}>
        <HighlightedText text={text} query={query} />
      </p>
      {canExpand ? (
        <button
          type="button"
          className="ks-excerpt-turn-expand"
          aria-expanded={expanded}
          onClick={onToggle}
        >
          {expanded ? "Collapse turn" : "Show full turn"}
        </button>
      ) : null}
    </article>
  );
}

export function KnowledgeSearchInspector() {
  const {
    selectedKnowledgeHit,
    selectedKnowledgeQuery,
    clearKnowledgeHit,
    openFilePreview,
    navigate,
  } = useScout();
  const [loadedPreview, setLoadedPreview] = useState<{
    hitId: string;
    value: KnowledgeSourcePreview;
  } | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rawOpen, setRawOpen] = useState(false);
  const [referenceCopied, setReferenceCopied] = useState(false);
  const [expandedFolds, setExpandedFolds] = useState<Record<number, boolean>>({});
  const [expandedTurns, setExpandedTurns] = useState<Record<number, boolean>>({});
  const preview = loadedPreview && loadedPreview.hitId === selectedKnowledgeHit?.id
    ? loadedPreview.value
    : null;

  const transcript = selectedKnowledgeHit ? firstTranscriptRef(selectedKnowledgeHit) : null;
  const fileRef = selectedKnowledgeHit ? firstFileRef(selectedKnowledgeHit) : null;
  const project = selectedKnowledgeHit ? facetText(selectedKnowledgeHit, "project") : "";
  const harness = selectedKnowledgeHit ? facetText(selectedKnowledgeHit, "harness") : "";
  const activeQuery = selectedKnowledgeQuery.trim();
  const sessionId = transcriptSessionId(transcript);
  const tailQuery = transcriptTailQuery(transcript);
  const sourcePath = transcript?.path ?? fileRef?.path;
  const reference = selectedKnowledgeHit ? sourceReference(selectedKnowledgeHit) : "";

  const primaryMatchedRecord = useMemo(() =>
    preview?.records
      .filter((record) => record.matched)
      .sort((left, right) => {
        const priority = previewRecordPriority(left) - previewRecordPriority(right);
        if (priority !== 0) return priority;
        return (right.matchCount ?? 0) - (left.matchCount ?? 0);
      })
      .at(0) ?? null,
    [preview],
  );

  const excerpt = useMemo(
    () => buildConversationExcerpt(preview?.records ?? [], {
      contextRadius: 4,
      maxTurns: 6,
      centerRecordIndex: primaryMatchedRecord?.index,
    }),
    [preview, primaryMatchedRecord?.index],
  );

  const excerptRange = useMemo((): [number, number] | null => {
    const indexes = excerpt.flatMap((block) =>
      block.kind === "turn"
        ? [block.record.index]
        : block.records.map((record) => record.index)
    );
    return indexes.length > 0 ? [Math.min(...indexes), Math.max(...indexes)] : null;
  }, [excerpt]);

  const firstOpenRecord = preview?.records.find((record) => record.matched)?.index
    ?? transcript?.recordRange?.[0];

  useEffect(() => {
    setExpandedFolds({});
    setExpandedTurns({});
    setReferenceCopied(false);
    setRawOpen(false);
  }, [selectedKnowledgeHit?.id]);

  useEffect(() => {
    let cancelled = false;
    const loadPreview = async () => {
      setLoadedPreview(null);
      setError(null);
      if (!selectedKnowledgeHit || !transcript) {
        setLoadingPreview(false);
        return;
      }
      setLoadingPreview(true);
      try {
        const response = await api<KnowledgeSourcePreview>("/api/knowledge/source-preview", {
          method: "POST",
          body: JSON.stringify({
            sourceRef: transcript,
            contextRecords: 4,
            maxRecords: 80,
            q: activeQuery,
          }),
        });
        if (!cancelled) setLoadedPreview({ hitId: selectedKnowledgeHit.id, value: response });
      } catch (err) {
        if (!cancelled) {
          setLoadedPreview(null);
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoadingPreview(false);
      }
    };
    void loadPreview();
    return () => {
      cancelled = true;
    };
  }, [selectedKnowledgeHit?.id, transcript?.recordRange?.[0], transcript?.recordRange?.[1], activeQuery]);

  const openSourceFile = useCallback(() => {
    const source = transcript ?? fileRef;
    if (!source) return;
    openFilePreview(pathLabel(source.path));
  }, [transcript, fileRef, openFilePreview]);

  const copyReference = useCallback(async () => {
    if (!reference) return;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(reference);
      } else if (typeof document !== "undefined") {
        const textarea = document.createElement("textarea");
        textarea.value = reference;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      setReferenceCopied(true);
      window.setTimeout(() => setReferenceCopied(false), 1600);
    } catch {
      // Copy is a convenience; swallow failures so the panel stays usable.
    }
  }, [reference]);

  return (
    <div className="ks-inspector">
      {error ? <div className="ks-inspector-error" role="alert">{error}</div> : null}

      <section className="ks-preview-panel" aria-label="Selected search result preview">
        {!selectedKnowledgeHit ? (
          <div className="ks-inspector-empty">
            <FileJson size={18} aria-hidden="true" />
            <strong>Select a result</strong>
            <span>Pick a match to see the conversation moment, jump to the session, or open the file.</span>
            <span className="ks-inspector-empty-hint">Use <kbd>j</kbd>/<kbd>k</kbd> to walk the list, <kbd>↵</kbd> to pick, <kbd>⌘↵</kbd> to open the session.</span>
          </div>
        ) : (
          <>
            <header className="ks-preview-head">
              <div>
                <span className="ks-panel-eyebrow">Result</span>
                <h2>{selectedKnowledgeHit.title}</h2>
              </div>
              <button
                type="button"
                aria-label="Clear selected result"
                onClick={clearKnowledgeHit}
                className="ks-preview-close"
              >
                <X size={14} aria-hidden="true" />
              </button>
            </header>

            <div className="ks-preview-meta">
              {project ? <span>{project}</span> : null}
              {harness ? <span>{harness}</span> : null}
              {selectedKnowledgeHit.freshness
                && selectedKnowledgeHit.freshness !== "unknown"
                && <span>{selectedKnowledgeHit.freshness}</span>}
              {transcript?.recordRange ? (
                <span>records {transcript.recordRange[0]}..{transcript.recordRange[1]}</span>
              ) : null}
            </div>

            {(sessionId || tailQuery || transcript || fileRef || reference) ? (
              <div className="ks-preview-actions" aria-label="Selected result actions">
                {sessionId ? (
                  <button
                    type="button"
                    className="ks-action-primary"
                    onClick={() => navigate({ view: "sessions", sessionId })}
                  >
                    <MessageSquareText size={13} aria-hidden="true" />
                    Open conversation
                  </button>
                ) : null}
                {tailQuery ? (
                  <button
                    type="button"
                    onClick={() => navigate({ view: "ops", mode: "tail", tailQuery })}
                  >
                    <RadioTower size={13} aria-hidden="true" />
                    Observe window
                  </button>
                ) : null}
                {reference ? (
                  <button type="button" onClick={() => void copyReference()}>
                    {referenceCopied
                      ? <Check size={13} aria-hidden="true" />
                      : <Copy size={13} aria-hidden="true" />}
                    {referenceCopied ? "Copied" : "Copy ref"}
                  </button>
                ) : null}
                {(transcript || fileRef) ? (
                  <button type="button" onClick={openSourceFile}>
                    <ExternalLink size={13} aria-hidden="true" />
                    Open file
                  </button>
                ) : null}
              </div>
            ) : null}

            <details className="ks-why-matched">
              <summary>
                <span>{matchExplanation(selectedKnowledgeHit, activeQuery, primaryMatchedRecord)}</span>
                <em>{scoreMatchKind(selectedKnowledgeHit)}</em>
              </summary>
              <dl>
                <div>
                  <dt>Index signal</dt>
                  <dd>{selectedKnowledgeHit.scoreSource || "fts"}</dd>
                </div>
                <div>
                  <dt>Origin</dt>
                  <dd>{selectedKnowledgeHit.origin} · {selectedKnowledgeHit.ownership}</dd>
                </div>
                {transcript?.recordRange ? (
                  <div>
                    <dt>Records</dt>
                    <dd>{transcript.recordRange[0]}…{transcript.recordRange[1]}</dd>
                  </div>
                ) : null}
              </dl>
            </details>

            {loadingPreview ? (
              <div className="ks-preview-loading">
                <Loader2 size={15} className="ks-spin" aria-hidden="true" />
                Loading conversation…
              </div>
            ) : excerpt.length > 0 ? (
              <section className="ks-conversation-excerpt" aria-label="Conversation excerpt">
                <div className="ks-rendered-head">
                  <MessageSquareText size={14} aria-hidden="true" />
                  <strong>Conversation</strong>
                  {excerptRange ? (
                    <span>records {excerptRange[0]}…{excerptRange[1]}</span>
                  ) : null}
                </div>
                {excerpt.map((block, index) => {
                  if (block.kind === "folded") {
                    const foldKey = block.records[0]?.index ?? index;
                    const open = expandedFolds[foldKey] === true;
                    return (
                      <div key={`fold:${foldKey}`} className="ks-excerpt-fold">
                        <button
                          type="button"
                          className="ks-excerpt-fold-toggle"
                          aria-expanded={open}
                          onClick={() => setExpandedFolds((current) => ({
                            ...current,
                            [foldKey]: !open,
                          }))}
                        >
                          <span aria-hidden="true">{open ? "▾" : "▸"}</span>
                          {block.summary}
                        </button>
                        {open ? (
                          <div className="ks-excerpt-fold-body">
                            {block.records.map((record) => (
                              <article
                                key={`fold-record:${record.index}`}
                                className="ks-excerpt-turn ks-excerpt-turn--muted"
                              >
                                <header>
                                  <span>{String(record.index).padStart(4, "0")}</span>
                                  <strong>{previewRecordKindLabel(record)}</strong>
                                </header>
                                <p tabIndex={0}>
                                  <HighlightedText text={recordText(record)} query={activeQuery} />
                                </p>
                              </article>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    );
                  }

                  const { record, role } = block;
                  const expanded = expandedTurns[record.index] === true;
                  return (
                    <ConversationTurn
                      key={`turn:${record.index}`}
                      record={record}
                      role={role}
                      query={activeQuery}
                      expanded={expanded}
                      onToggle={() => setExpandedTurns((current) => ({
                        ...current,
                        [record.index]: !expanded,
                      }))}
                    />
                  );
                })}
              </section>
            ) : (
              <section className="ks-indexed-snippet" aria-label="Match snippet">
                <span>Match</span>
                <p><HighlightedText text={selectedKnowledgeHit.snippet} query={activeQuery} /></p>
              </section>
            )}

            {sourcePath ? (
              <div className="ks-preview-source">
                <span>Source</span>
                <code>{pathLabel(sourcePath)}</code>
                <button type="button" onClick={() => void copyReference()} aria-label="Copy source reference">
                  {referenceCopied
                    ? <Check size={12} aria-hidden="true" />
                    : <Copy size={12} aria-hidden="true" />}
                  {referenceCopied ? "Copied" : "Copy ref"}
                </button>
              </div>
            ) : null}

            {preview ? (
              <details
                className="ks-jsonl-window"
                open={rawOpen}
                onToggle={(event) => setRawOpen((event.target as HTMLDetailsElement).open)}
              >
                <summary className="ks-jsonl-window-head">
                  <strong>Raw evidence (advanced)</strong>
                  <span>records {preview.previewRange[0]}..{preview.previewRange[1]}</span>
                </summary>
                {preview.records.map((record) => (
                  <details
                    key={`${preview.path}:${record.index}`}
                    className={`ks-jsonl-record${record.matched ? " ks-jsonl-record--matched" : ""}`}
                    open={record.index === firstOpenRecord}
                  >
                    <summary>
                      <span>{String(record.index).padStart(4, "0")}</span>
                      <strong>{record.kind || record.role || record.type || "record"}</strong>
                      <em><HighlightedText text={record.summary || "no summary"} query={activeQuery} /></em>
                    </summary>
                    <pre>{record.raw}</pre>
                  </details>
                ))}
              </details>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
