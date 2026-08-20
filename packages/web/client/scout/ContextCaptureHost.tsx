import { useCallback, useEffect, useRef, useState } from "react";
import { filterAgentsByMachineScope } from "../lib/machine-scope.ts";
import { isEditableTarget } from "../lib/keyboard-nav-core.ts";
import {
  contextCaptureDraftHasContent,
  mergeContextCaptureDraft,
  type ContextCaptureDraft,
} from "../lib/context-capture-draft.ts";
import {
  dataTransferMayContainFiles,
  isRoutableMediaFile,
  readTransferredFiles,
} from "../lib/media-blobs.ts";
import { resolveCaptureRouteContext } from "../lib/media-route.ts";
import { routeMachineId } from "../lib/router.ts";
import { NewChatComposer } from "../screens/agents/NewChatComposer.tsx";
import type { ContextCaptureRequest } from "./Provider.tsx";
import { useScout } from "./Provider.tsx";
import "./context-capture.css";

export function ContextCaptureHost({
  request,
  onClose,
  onOpenCapture,
}: {
  request: ContextCaptureRequest | null;
  onClose: () => void;
  onOpenCapture: (request: ContextCaptureRequest) => void;
}) {
  const { agents, route, navigate } = useScout();
  const machineId = routeMachineId(route);
  const scopedAgents = filterAgentsByMachineScope(agents, machineId);
  const routeContext = resolveCaptureRouteContext(route, scopedAgents);
  const [dragDepth, setDragDepth] = useState(0);
  const [captureFeedback, setCaptureFeedback] = useState<string | null>(null);
  const [draft, setDraft] = useState<ContextCaptureDraft | null>(null);
  const dragDepthRef = useRef(0);

  const restoredDraft = request ? mergeContextCaptureDraft(draft, request) : null;

  const openCapture = useCallback((files: File[], attachmentFeedback?: string) => {
    if (files.length === 0) return;
    const hasExplicitRoute = Boolean(routeContext.agentId || routeContext.conversationId);
    onOpenCapture({
      intent: hasExplicitRoute ? "route-capture" : "new-task",
      files,
      attachmentFeedback,
      agentId: routeContext.agentId ?? undefined,
      conversationId: routeContext.conversationId ?? undefined,
      preferExistingChat: routeContext.canUseExistingChat,
    });
  }, [onOpenCapture, routeContext]);

  useEffect(() => {
    if (!captureFeedback) return;
    const timeout = window.setTimeout(() => setCaptureFeedback(null), 5000);
    return () => window.clearTimeout(timeout);
  }, [captureFeedback]);

  useEffect(() => {
    const onDragEnter = (event: DragEvent) => {
      if (!dataTransferMayContainFiles(event.dataTransfer)) return;
      event.preventDefault();
      dragDepthRef.current += 1;
      setDragDepth(dragDepthRef.current);
    };
    const onDragOver = (event: DragEvent) => {
      if (!dataTransferMayContainFiles(event.dataTransfer)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const onDragLeave = () => {
      if (dragDepthRef.current === 0) return;
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      setDragDepth(dragDepthRef.current);
    };
    const onDrop = (event: DragEvent) => {
      if (!dataTransferMayContainFiles(event.dataTransfer)) return;
      event.preventDefault();
      const incoming = readTransferredFiles(event.dataTransfer);
      const files = incoming.filter(isRoutableMediaFile);
      const rejectedCount = incoming.length - files.length;
      dragDepthRef.current = 0;
      setDragDepth(0);
      if (files.length === 0) {
        setCaptureFeedback(
          incoming.length === 0
            ? "Scout could not read that file. Try the attachment picker instead."
            : "That file type is not supported. Drop markdown, code, an image, or a video clip.",
        );
        return;
      }
      const added = files.length === 1
        ? `Dropped ${files[0]?.name || "1 attachment"}.`
        : `Dropped ${files.length} attachments.`;
      const feedback = rejectedCount > 0
        ? `${added} Skipped ${rejectedCount} unsupported ${rejectedCount === 1 ? "file" : "files"}.`
        : added;
      setCaptureFeedback(null);
      openCapture(files, feedback);
    };
    const onPaste = (event: ClipboardEvent) => {
      if (isEditableTarget(event.target)) return;
      if (!dataTransferMayContainFiles(event.clipboardData)) return;
      event.preventDefault();
      const incoming = readTransferredFiles(event.clipboardData);
      const files = incoming.filter(isRoutableMediaFile);
      if (files.length === 0) {
        setCaptureFeedback(
          incoming.length === 0
            ? "Scout could not read that pasted file. Try the attachment picker instead."
            : "That pasted file type is not supported. Paste an image or video, or attach markdown or code.",
        );
        return;
      }
      openCapture(
        files,
        files.length === 1
          ? `Pasted ${files[0]?.name || "1 attachment"}.`
          : `Pasted ${files.length} attachments.`,
      );
    };

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("paste", onPaste);
    };
  }, [openCapture]);

  const dropActive = dragDepth > 0 && !request;

  return (
    <>
      {dropActive ? (
        <div className="s-capture-drop" role="presentation">
          <div className="s-capture-drop-card">
            <div className="s-capture-drop-title">Route capture</div>
            <div className="s-capture-drop-copy">
              Drop markdown, code, an image, or a video clip to send it to the right agent or chat.
            </div>
          </div>
        </div>
      ) : null}
      {captureFeedback ? (
        <div className="s-capture-feedback" role="alert">
          {captureFeedback}
        </div>
      ) : null}
      {request ? (
        <NewChatComposer
          agents={scopedAgents}
          route={route}
          navigate={navigate}
          onClose={onClose}
          initialAgentId={restoredDraft?.agentId}
          initialConversationId={restoredDraft?.conversationId}
          initialMessage={restoredDraft?.message}
          initialFiles={restoredDraft?.files}
          initialAttachmentFeedback={restoredDraft?.attachmentFeedback ?? undefined}
          initialIntent={restoredDraft?.intent}
          initialProjectPath={restoredDraft?.projectPath}
          initialProjectQuery={restoredDraft?.projectQuery}
          initialForwardContext={restoredDraft?.forwardContext}
          initialForwardContextMode={restoredDraft?.forwardContextMode}
          defaultMode={restoredDraft?.mode}
          draftRestored={contextCaptureDraftHasContent(draft)}
          onDraftChange={setDraft}
          onDraftConsumed={() => setDraft(null)}
        />
      ) : null}
    </>
  );
}
