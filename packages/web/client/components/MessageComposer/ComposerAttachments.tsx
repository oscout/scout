import { mergeComposerFiles, composerFileId, readComposerFiles, subscribeComposerFiles, updateComposerFiles } from "../../lib/composer-file-recovery.ts";
/**
 * Staged-attachment plumbing for MessageComposer call sites.
 *
 * The New chat composer grew its own file staging, paste, and drop handling
 * first; Comms threads had none. This is that behaviour lifted into the kit so
 * both surfaces stage the same way and upload through `uploadMediaFiles`.
 *
 * The hook owns picked files only. Uploading stays with the caller because each
 * surface posts to a different endpoint.
 */
import {
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { FileText } from "lucide-react";
import {
  dataTransferMayContainFiles,
  isRoutableMediaFile,
  readClipboardMediaFiles,
  readRoutableFiles,
} from "../../lib/media-blobs.ts";

const UNROUTABLE_HINT =
  "Only markdown, code, images, and video clips can be attached.";

export type ComposerAttachmentsState = {
  files: File[];
  hasFiles: boolean;
  feedback: string | null;
  error: string | null;
  dragActive: boolean;
  recoveryPending: boolean;
  recoveryError: string | null;
  waitForRecovery: () => Promise<void>;
  /** Returns how many of `incoming` were routable and staged. */
  stage: (incoming: File[], verb?: string) => number;
  remove: (file: File) => void;
  clear: (submitted?: readonly File[]) => void;
  setError: (message: string | null) => void;
  openPicker: () => void;
  /** Spread onto the element that should accept drops (composer shell). */
  dropHandlers: {
    onDragOver: (event: ReactDragEvent) => void;
    onDragLeave: (event: ReactDragEvent) => void;
    onDrop: (event: ReactDragEvent) => void;
  };
  onPaste: (event: ReactClipboardEvent) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
};

export function useComposerAttachments(scopeKey = "default", persistFiles = false): ComposerAttachmentsState {
  const [scopedFiles, setScopedFiles] = useState<Record<string, File[]>>({});
  const fileState = useRef(scopedFiles);
  const writes = useRef(new Map<string, Promise<void>>());
  const removedIds = useRef(new Set<string>());
  const [recovery, setRecovery] = useState<Record<string, { ready: boolean; error: string | null }>>({});
  const files = scopedFiles[scopeKey] ?? [];
  const setFiles = useCallback((update: File[] | ((previous: File[]) => File[])) => {
    const previous = fileState.current[scopeKey] ?? [];
    const next = typeof update === "function" ? update(previous) : update;
    fileState.current = { ...fileState.current, [scopeKey]: next };
    setScopedFiles(fileState.current);
    if (persistFiles) {
      const added = next.filter(file => !previous.includes(file));
      const removed = previous.filter(file => !next.includes(file));
      for (const file of removed) removedIds.current.add(composerFileId(file));
      for (const file of added) removedIds.current.delete(composerFileId(file));
      const write = updateComposerFiles(scopeKey, added, removed).catch(() => {
        setRecovery(state => ({ ...state, [scopeKey]: { ready: true, error: added.length ? "Files are available in this tab, but could not be saved for reopening. Keep this tab open until you send them." : "Saved attachments could not be removed from this browser. Check them before sending after reopening." } }));
      });
      writes.current.set(scopeKey, Promise.all([writes.current.get(scopeKey), write]).then(() => {}));
    }
  }, [scopeKey, persistFiles]);
  useEffect(() => {
    if (!persistFiles) return;
    let active = true;
    const refresh = (onlyIds?: Set<string>) => readComposerFiles(scopeKey).then(restored => {
      if (!active) return;
      const current = fileState.current[scopeKey] ?? [];
      const ids = new Set(current.map(composerFileId));
      fileState.current = { ...fileState.current, [scopeKey]: mergeComposerFiles(current, restored.filter(file => (!onlyIds || onlyIds.has(composerFileId(file))) && !ids.has(composerFileId(file)) && !removedIds.current.has(composerFileId(file)))) };
      setScopedFiles(fileState.current);
      setRecovery(state => ({ ...state, [scopeKey]: { ready: true, error: state[scopeKey]?.error ?? null } }));
    }).catch(() => { if (active) setRecovery(state => ({ ...state, [scopeKey]: { ready: true, error: "Saved attachments could not be restored. Reattach any missing files before sending." } })); });
    const unsubscribe = subscribeComposerFiles(change => {
      if (change.scope !== scopeKey || !active) return;
      for (const id of change.removed) removedIds.current.add(id);
      for (const id of change.added) removedIds.current.delete(id);
      const removed = new Set(change.removed);
      fileState.current = { ...fileState.current, [scopeKey]: (fileState.current[scopeKey] ?? []).filter(file => !removed.has(composerFileId(file))) };
      setScopedFiles(fileState.current);
      if (change.added.length) void refresh(new Set(change.added));
    });
    void refresh();
    return () => { active = false; unsubscribe(); };
  }, [scopeKey, persistFiles]);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragDepth, setDragDepth] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => { setFeedback(null); setError(null); setDragDepth(0); }, [scopeKey]);

  const stage = useCallback((incoming: File[], verb = "Attached") => {
    const routable = incoming.filter(isRoutableMediaFile);
    if (routable.length === 0) {
      if (incoming.length > 0) setError(UNROUTABLE_HINT);
      return 0;
    }
    setError(null);
    setFiles((previous) => {
      return mergeComposerFiles(previous, routable);
    });
    setFeedback(
      routable.length === 1
        ? `${verb} ${routable[0]?.name ?? "1 attachment"}.`
        : `${verb} ${routable.length} attachments.`,
    );
    return routable.length;
  }, [setFiles]);

  const remove = useCallback((target: File) => {
    setFiles((previous) => previous.filter((file) => file !== target));
    setFeedback(null);
  }, [setFiles]);

  const clear = useCallback((submitted?: readonly File[]) => {
    setFiles(previous => submitted ? previous.filter(file => !submitted.includes(file)) : []);
    setFeedback(null);
    setError(null);
    setDragDepth(0);
  }, [setFiles]);

  const openPicker = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const onPaste = useCallback(
    (event: ReactClipboardEvent) => {
      const pasted = readClipboardMediaFiles(event.clipboardData);
      if (pasted.length === 0) return;
      // Only swallow the paste once we know we can stage it — plain text and
      // unroutable files must still reach the textarea.
      event.preventDefault();
      stage(pasted, "Pasted");
    },
    [stage],
  );

  const dropHandlers = useMemo(
    () => ({
      onDragOver: (event: ReactDragEvent) => {
        if (!dataTransferMayContainFiles(event.dataTransfer)) return;
        event.preventDefault();
        setDragDepth((depth) => (depth === 0 ? 1 : depth));
      },
      onDragLeave: (event: ReactDragEvent) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
          return;
        }
        setDragDepth(0);
      },
      onDrop: (event: ReactDragEvent) => {
        if (!dataTransferMayContainFiles(event.dataTransfer)) return;
        event.preventDefault();
        setDragDepth(0);
        const dropped = readRoutableFiles(event.dataTransfer);
        if (dropped.length === 0) {
          setError(UNROUTABLE_HINT);
          return;
        }
        stage(dropped, "Dropped");
      },
    }),
    [stage],
  );

  return {
    files,
    recoveryPending: persistFiles && !recovery[scopeKey]?.ready,
    recoveryError: recovery[scopeKey]?.error ?? null,
    waitForRecovery: () => writes.current.get(scopeKey) ?? Promise.resolve(),
    hasFiles: files.length > 0,
    feedback,
    error,
    dragActive: dragDepth > 0,
    stage,
    remove,
    clear,
    setError,
    openPicker,
    dropHandlers,
    onPaste,
    inputRef,
  };
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}

function fileExtBadge(filename: string): string {
  const ext = filename.split(".").pop()?.toUpperCase() ?? "FILE";
  return ext.slice(0, 4);
}

function StagedAttachment({
  file,
  onRemove,
}: {
  file: File;
  onRemove: () => void;
}) {
  const url = useMemo(() => URL.createObjectURL(file), [file]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  const isVideo = file.type.startsWith("video/");
  const isImage = file.type.startsWith("image/");
  const ext = fileExtBadge(file.name);
  const size = formatFileSize(file.size);

  return (
    <div className="s-msg-compose-attachment surface-card surface-card--inset">
      {isVideo ? (
        <video src={url} muted playsInline />
      ) : isImage ? (
        <img src={url} alt={file.name} />
      ) : (
        <div className="s-msg-compose-attachment-file" title={`${file.name} (${size})`}>
          <div className="s-msg-compose-attachment-file-icon">
            <FileText size={16} aria-hidden="true" />
            <span className="s-msg-compose-attachment-ext label-xs">{ext}</span>
          </div>
          <span className="s-msg-compose-attachment-name">{file.name}</span>
          <span className="s-msg-compose-attachment-size label-xs text-dim">{size}</span>
        </div>
      )}
      <button
        type="button"
        className="s-msg-compose-attachment-remove btn btn--ghost btn--icon"
        aria-label={`Remove ${file.name}`}
        title={`Remove ${file.name}`}
        onClick={onRemove}
      >
        ×
      </button>
    </div>
  );
}

/**
 * Hidden picker input plus the staged thumbnails. Render inside the composer
 * `header` slot so staged files sit above the field.
 */
export function ComposerAttachmentStrip({
  attachments,
  accept = "image/*,video/*,text/markdown,.md,.markdown,text/plain,.txt",
}: {
  attachments: ComposerAttachmentsState;
  accept?: string;
}) {
  const { files, feedback, error, remove, stage, inputRef } = attachments;

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={accept}
        className="s-msg-compose-file-input"
        onChange={(event) => {
          stage([...(event.target.files ?? [])]);
          // Reset so re-picking the same file fires change again.
          event.target.value = "";
        }}
      />
      {files.length > 0 ? (
        <div className="s-msg-compose-attachments" aria-label="Staged attachments">
          {files.map((file) => (
            <StagedAttachment
              key={`${file.name}:${file.size}:${file.lastModified}`}
              file={file}
              onRemove={() => remove(file)}
            />
          ))}
        </div>
      ) : null}
      {error ? (
        <div className="s-msg-compose-attach-note" data-tone="error" role="alert">
          {error}
        </div>
      ) : feedback ? (
        <div className="s-msg-compose-attach-note" data-tone="muted" role="status">
          {feedback}
        </div>
      ) : null}
    </>
  );
}
