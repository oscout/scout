type SurfaceDocument = Pick<Document, "visibilityState"> & Partial<Pick<Document, "hasFocus">>;

export function isScoutSurfaceActive(
  target: SurfaceDocument | undefined = globalThis.document,
): boolean {
  if (!target) return true;
  if (target.visibilityState !== "visible") return false;
  return typeof target.hasFocus !== "function" || target.hasFocus();
}

/**
 * Visible, focused or not. For watch surfaces (the Home cockpit left open on
 * a second screen) that must stay current while the operator works elsewhere.
 */
export function isScoutSurfaceVisible(
  target: Pick<Document, "visibilityState"> | undefined = globalThis.document,
): boolean {
  if (!target) return true;
  return target.visibilityState === "visible";
}

type SurfaceActivationDocument = SurfaceDocument
  & Pick<Document, "addEventListener" | "removeEventListener">;
type SurfaceActivationWindow = Pick<Window, "addEventListener" | "removeEventListener">;

type SurfaceActivationTargets = {
  document?: SurfaceActivationDocument;
  window?: SurfaceActivationWindow;
};

export function onScoutSurfaceActivated(
  callback: () => void,
  targets: SurfaceActivationTargets = {
    document: typeof document === "undefined" ? undefined : document,
    window: typeof window === "undefined" ? undefined : window,
  },
): () => void {
  const targetDocument = targets.document;
  const targetWindow = targets.window;
  if (!targetDocument) return () => {};

  let wasActive = isScoutSurfaceActive(targetDocument);
  const notifyIfActive = () => {
    const active = isScoutSurfaceActive(targetDocument);
    if (active && !wasActive) callback();
    wasActive = active;
  };
  const markInactive = () => {
    wasActive = false;
  };

  targetDocument.addEventListener("visibilitychange", notifyIfActive);
  targetWindow?.addEventListener("blur", markInactive);
  targetWindow?.addEventListener("focus", notifyIfActive);

  return () => {
    targetDocument.removeEventListener("visibilitychange", notifyIfActive);
    targetWindow?.removeEventListener("blur", markInactive);
    targetWindow?.removeEventListener("focus", notifyIfActive);
  };
}
