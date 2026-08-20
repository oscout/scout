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
  /** Returns how many of `incoming` were routable and staged. */
  stage: (incoming: File[], verb?: string) => number;
  remove: (file: File) => void;
  clear: () => void;
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

export function useComposerAttachments(): ComposerAttachmentsState {
  const [files, setFiles] = useState<File[]>([]);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragDepth, setDragDepth] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const stage = useCallback((incoming: File[], verb = "Attached") => {
    const routable = incoming.filter(isRoutableMediaFile);
    if (routable.length === 0) {
      if (incoming.length > 0) setError(UNROUTABLE_HINT);
      return 0;
    }
    setError(null);
    setFiles((previous) => {
      // Same name+size+mtime picked twice is the same capture, not two.
      const seen = new Set(
        previous.map((file) => `${file.name}:${file.size}:${file.lastModified}`),
      );
      const fresh = routable.filter(
        (file) => !seen.has(`${file.name}:${file.size}:${file.lastModified}`),
      );
      return fresh.length > 0 ? [...previous, ...fresh] : previous;
    });
    setFeedback(
      routable.length === 1
        ? `${verb} ${routable[0]?.name ?? "1 attachment"}.`
        : `${verb} ${routable.length} attachments.`,
    );
    return routable.length;
  }, []);

  const remove = useCallback((target: File) => {
    setFiles((previous) => previous.filter((file) => file !== target));
    setFeedback(null);
  }, []);

  const clear = useCallback(() => {
    setFiles([]);
    setFeedback(null);
    setError(null);
    setDragDepth(0);
  }, []);

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
  return (
    <div className="s-msg-compose-attachment">
      {isVideo ? (
        <video src={url} muted playsInline />
      ) : isImage ? (
        <img src={url} alt={file.name} />
      ) : (
        <div className="s-msg-compose-attachment-file" title={file.name}>
          <FileText size={18} aria-hidden="true" />
          <span>{file.name}</span>
        </div>
      )}
      <button
        type="button"
        className="s-msg-compose-attachment-remove"
        aria-label={`Remove ${file.name}`}
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
