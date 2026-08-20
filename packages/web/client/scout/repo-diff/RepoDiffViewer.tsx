/**
 * Repo Diff Viewer (SCO-065) — the shared diff review surface.
 *
 * Fetches `GET /api/repo-diff/worktree?path=…&layer=unstaged&layer=staged` (a
 * `ScoutRepoDiffSnapshot`), then renders it with Pierre Diffs + Shiki, which are
 * loaded at runtime from a pinned esm.sh version (see ./pierre.ts). Diff data is
 * always local; only the Pierre/Shiki library is remote.
 */

import { pathLeaf } from "../repo-watch/ui.ts";
import "./repo-diff.css";
import { DiffCommentComposer } from "./DiffCommentComposer.tsx";
import { DiffHeader, SnapshotDiagnostics } from "./DiffHeader.tsx";
import { DiffSurface } from "./DiffSurface.tsx";
import { FilesRail } from "./FilesRail.tsx";
import { Center, Viewer } from "./RepoDiffChrome.tsx";
import { DEFAULT_LAYERS } from "./model.ts";
import { useDiffCommentComposer } from "./useDiffCommentComposer.ts";
import { usePierreRuntime } from "./usePierreRuntime.ts";
import { useRepoDiffPatchChunk } from "./useRepoDiffPatchChunk.ts";
import { useRepoDiffSelection } from "./useRepoDiffSelection.ts";
import { useRepoDiffSnapshot } from "./useRepoDiffSnapshot.ts";
import type { RepoDiffSessionRequest } from "./cache.ts";
import type { RepoDiffLayerKind } from "./types.ts";

export type RepoDiffViewerProps = {
  /** Absolute worktree path to diff. The viewer fetches the snapshot itself. */
  path: string;
  /** Layers to request (default: unstaged + staged). */
  layers?: RepoDiffLayerKind[];
  /** Optional worktree path filters, surfaced as repeated `file=` query values. */
  files?: string[];
  /** Optional session scope; when present the server derives changed files. */
  session?: RepoDiffSessionRequest | null;
  /** Force the first snapshot request to bypass the server repo-diff cache. */
  forceInitialLoad?: boolean;
  /** Optional close affordance (rendered in the header when present). */
  onClose?: () => void;
  /** Optional "open as page" affordance (promotes the panel to the
   *  /repo-diff route). Rendered in the header only when present. */
  onOpenAsPage?: () => void;
  /** Extra className on the root (e.g. for the chrome-free embed). */
  className?: string;
  /** Heading shown in the header (defaults to the worktree leaf name). */
  title?: string;
};

export function RepoDiffViewer({
  path,
  layers = DEFAULT_LAYERS,
  files,
  session,
  forceInitialLoad = false,
  onClose,
  onOpenAsPage,
  className,
  title,
}: RepoDiffViewerProps) {
  const {
    snapshot,
    fetchPhase,
    fetchError,
    freshness,
    filesKey,
    sessionKey,
    loadSnapshot,
    refreshSnapshot,
  } = useRepoDiffSnapshot({
    path,
    layers,
    files,
    session,
    tier: "summary",
    forceInitialLoad,
  });
  const {
    pierre,
    pierrePhase,
    pierreError,
    pierreTheme,
    retryPierre,
  } = usePierreRuntime(snapshot);
  const {
    activeLayer,
    setActiveLayer,
    layer,
    selectedFileKey,
    setSelectedFileKey,
    selectedFile,
    layout,
    setLayout,
  } = useRepoDiffSelection(snapshot);
  const patch = useRepoDiffPatchChunk({
    path,
    activeLayer,
    selectedFile,
    snapshotKey: snapshot?.render.renderKey ?? "",
  });
  const comment = useDiffCommentComposer({
    snapshot,
    activeLayer,
    selectedFile,
    setSelectedFileKey,
    resetKey: `${path}\0${filesKey}\0${sessionKey}`,
  });

  if (fetchPhase === "loading" && !snapshot) {
    return (
      <Viewer className={className}>
        <Center>
          <div className="rd-spinner" aria-hidden />
          <div className="rd-center-title">
            Reading {session ? "session" : "worktree"} diff…
          </div>
          <div className="rd-center-body">{path}</div>
        </Center>
      </Viewer>
    );
  }

  if (fetchPhase === "error" && !snapshot) {
    return (
      <Viewer className={className}>
        <Center>
          <div className="rd-center-title">Couldn’t load the diff</div>
          <div className="rd-center-body">
            {fetchError ?? "The broker did not return a diff snapshot."}
          </div>
          <div className="rd-center-action">
            <button type="button" className="rd-btn" onClick={() => void loadSnapshot()}>
              Retry
            </button>
          </div>
        </Center>
      </Viewer>
    );
  }

  if (!snapshot) return <Viewer className={className} />;

  const heading = title ?? pathLeaf(snapshot.worktreePath);

  return (
    <Viewer className={className}>
      <DiffHeader
        heading={heading}
        worktreePath={snapshot.worktreePath}
        snapshot={snapshot}
        freshness={freshness}
        activeLayer={activeLayer}
        onLayer={setActiveLayer}
        layout={layout}
        onLayout={setLayout}
        refreshing={freshness?.refreshing === true}
        onRefresh={refreshSnapshot}
        onFocusComment={() => {
          comment.textareaRef.current?.scrollIntoView({ block: "nearest" });
          comment.textareaRef.current?.focus();
        }}
        onClose={onClose}
        onOpenAsPage={onOpenAsPage}
      />

      <SnapshotDiagnostics snapshot={snapshot} />

      <div className="rd-body">
        <FilesRail
          layer={layer}
          selectedFileKey={selectedFileKey}
          onSelect={setSelectedFileKey}
          onIncludeFile={comment.includeFileInComment}
        />
        <DiffCommentComposer
          snapshot={snapshot}
          selectedFile={selectedFile}
          targets={comment.targets}
          targetId={comment.targetId}
          onTargetId={comment.setTargetId}
          draft={comment.draft}
          onDraft={comment.setDraft}
          contextItems={comment.contextItems}
          onRemoveContextItem={comment.removeContextItem}
          pending={comment.pending}
          status={comment.status}
          error={comment.error}
          textareaRef={comment.textareaRef}
          onSubmit={comment.submit}
        />
        <DiffSurface
          layer={layer}
          patchLayer={patch.layer}
          patchPhase={patch.phase}
          patchError={patch.error}
          selectedFileKey={selectedFileKey}
          renderKey={snapshot.render.renderKey}
          theme={pierreTheme}
          layout={layout}
          pierre={pierre}
          pierrePhase={pierrePhase}
          pierreError={pierreError}
          onRetryPierre={retryPierre}
          onIncludeLineContext={comment.includeLineInComment}
          onIncludeSelectionContext={comment.includeSelectionInComment}
        />
      </div>
    </Viewer>
  );
}

export default RepoDiffViewer;
