import { Check, ChevronDown, Code2, FileCode2, Loader2, SendHorizontal, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { fileDisplayPath } from "./model.ts";
import type { RepoDiffCommentTarget } from "./comment-context.ts";
import type { DiffCommentContextItem } from "./useDiffCommentComposer.ts";
import type {
  RepoDiffFile,
  ScoutRepoDiffSnapshot,
} from "./types.ts";

export function DiffCommentComposer({
  snapshot,
  selectedFile,
  targets,
  targetId,
  onTargetId,
  draft,
  onDraft,
  contextItems,
  onRemoveContextItem,
  pending,
  status,
  error,
  textareaRef,
  onSubmit,
}: {
  snapshot: ScoutRepoDiffSnapshot;
  selectedFile: RepoDiffFile | null;
  targets: RepoDiffCommentTarget[];
  targetId: string;
  onTargetId: (targetId: string) => void;
  draft: string;
  onDraft: (value: string) => void;
  contextItems: DiffCommentContextItem[];
  onRemoveContextItem: (id: string) => void;
  pending: boolean;
  status: string | null;
  error: string | null;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onSubmit: () => void;
}) {
  const [targetMenuOpen, setTargetMenuOpen] = useState(false);
  const targetPickerRef = useRef<HTMLDivElement>(null);
  const target = targets.find((candidate) => candidate.id === targetId) ?? null;
  const targetLabel = target?.label ?? "Scout";
  const bestTargetId = targets[0]?.id ?? null;
  const selectedFileLabel = selectedFile ? fileDisplayPath(selectedFile) : null;
  const canSubmit = (draft.trim().length > 0 || contextItems.length > 0) && !pending;
  const targetOptions = useMemo(
    () => [
      ...targets.map((candidate) => ({
        id: candidate.id,
        label: candidate.label,
        suffix: candidate.id === bestTargetId ? "best context" : null,
      })),
      { id: "scout", label: "Scout", suffix: null },
    ],
    [bestTargetId, targets],
  );

  useEffect(() => {
    if (!targetMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const root = targetPickerRef.current;
      if (root && event.target instanceof Node && root.contains(event.target)) return;
      setTargetMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [targetMenuOpen]);

  return (
    <div className="rd-comment">
      {contextItems.length > 0 ? (
        <div className="rd-comment-context" aria-label="Included diff context">
          {contextItems.map((item) => (
            <DiffContextItem
              key={item.id}
              item={item}
              disabled={pending}
              onRemove={onRemoveContextItem}
            />
          ))}
        </div>
      ) : null}
      <div className="rd-comment-main">
        <div className="rd-target-picker" ref={targetPickerRef}>
          <button
            type="button"
            className="rd-target-button"
            onClick={() => setTargetMenuOpen((open) => !open)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Escape") setTargetMenuOpen(false);
            }}
            disabled={pending}
            aria-label="Diff comment target"
            aria-haspopup="listbox"
            aria-expanded={targetMenuOpen}
            title="Diff comment target"
          >
            <span>{targetLabel}</span>
            <ChevronDown size={13} strokeWidth={2} aria-hidden />
          </button>
          {targetMenuOpen ? (
            <div className="rd-target-menu" role="listbox" aria-label="Diff comment target">
              {targetOptions.map((option) => {
                const selected = option.id === (target?.id ?? "scout");
                return (
                  <button
                    key={option.id}
                    type="button"
                    className="rd-target-option"
                    role="option"
                    aria-selected={selected}
                    onClick={() => {
                      onTargetId(option.id);
                      setTargetMenuOpen(false);
                    }}
                  >
                    <span className="rd-target-option-label">{option.label}</span>
                    {option.suffix ? (
                      <span className="rd-target-option-suffix">{option.suffix}</span>
                    ) : null}
                    <span className="rd-target-option-check" aria-hidden>
                      {selected ? <Check size={12} strokeWidth={2.2} /> : null}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(event) => onDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              onSubmit();
            }
          }}
          rows={1}
          disabled={pending}
          placeholder={
            contextItems.length > 0
              ? `Send to ${targetLabel} with included context`
              : `Leave a note on this diff…`
          }
          aria-label="Diff comment"
        />
        <button
          type="button"
          className="rd-comment-send"
          disabled={!canSubmit}
          onClick={onSubmit}
          title="Send diff comment"
          aria-label="Send diff comment"
        >
          {pending ? (
            <Loader2 size={13} className="rd-comment-spin" aria-hidden />
          ) : (
            <SendHorizontal size={13} aria-hidden />
          )}
          <span>{pending ? "Sending" : "Send"}</span>
        </button>
      </div>
      <div className="rd-comment-meta">
        {error ? (
          <span className="err">{error}</span>
        ) : status ? (
          <span className="ok">{status}</span>
        ) : (
          <span>
            {snapshot.scope?.kind === "session" ? "Session diff" : "Worktree diff"}
            {selectedFileLabel ? ` · ${selectedFileLabel}` : ""}
          </span>
        )}
      </div>
    </div>
  );
}

function DiffContextItem({
  item,
  disabled,
  onRemove,
}: {
  item: DiffCommentContextItem;
  disabled: boolean;
  onRemove: (id: string) => void;
}) {
  const Icon = item.kind === "file" ? FileCode2 : Code2;
  return (
    <div className={`rd-context-item ${item.kind}`}>
      <div className="rd-context-head">
        <span className="rd-context-icon" aria-hidden>
          <Icon size={12} strokeWidth={2} />
        </span>
        <span className="rd-context-label" title={item.label}>
          {item.label}
        </span>
        <span className="rd-context-detail">{item.detail}</span>
        <button
          type="button"
          className="rd-context-remove"
          onClick={() => onRemove(item.id)}
          disabled={disabled}
          title="Remove included context"
          aria-label="Remove included context"
        >
          <X size={11} strokeWidth={2.2} aria-hidden />
        </button>
      </div>
      {item.preview ? <pre className="rd-context-preview">{item.preview}</pre> : null}
    </div>
  );
}
