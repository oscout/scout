import { useMemo, useRef, useState, type ReactNode } from "react";

import { ScoutContext, useScout } from "../Provider.tsx";
import { onboardingEmbedView } from "./onboarding-gate.ts";
import { OnboardingNotice, OnboardingTakeover } from "./OnboardingTakeover.tsx";

/**
 * First-run gate for `/embed/settings` when a host (the Mac app) opens it to
 * finish setup: the same takeover the web shells show, until the canonical
 * record says completed or skipped. The host watches that record and moves on
 * by itself; this page never reports completion any other way.
 */
export function OnboardingEmbedGate({ children }: { children: ReactNode }) {
  const scout = useScout();
  const { onboarding, onboardingError, refreshOnboarding } = scout;
  // This page mounts lazily, often after the first read already failed; the
  // placeholder it left behind must never count as a loaded state.
  const loaded = onboardingError?.kind === "load" ? null : onboarding;
  const lastLoaded = useRef(loaded);
  if (loaded) lastLoaded.current = loaded;
  const view = onboardingEmbedView(onboarding, lastLoaded.current, onboardingError);

  const [retrying, setRetrying] = useState(false);
  const retry = () => {
    setRetrying(true);
    void refreshOnboarding().finally(() => setRetrying(false));
  };

  // Steps read onboarding from context; during a dropped read they keep the
  // last loaded state instead of the unreachable-API placeholder.
  const held = useMemo(
    () => (view.kind === "setup" && view.state !== onboarding ? { ...scout, onboarding: view.state } : null),
    [view, onboarding, scout],
  );

  if (view.kind === "content") return <>{children}</>;
  return (
    <div className="s-onboarding-embed" data-scout-theme style={{ height: "100vh", minHeight: 0 }}>
      {view.kind === "checking" ? (
        <OnboardingNotice title="Checking setup" description="Reading this Mac's Scout setup…" />
      ) : view.kind === "unavailable" ? (
        <OnboardingNotice
          title="Scout's local service isn't answering"
          description="Setup reads and saves through it. Nothing was changed."
          error={view.message}
          action="Try again"
          onAction={retry}
          busy={retrying}
        />
      ) : (
        <>
          {view.reconnecting ? (
            <div role="alert" style={reconnectStyle}>
              <span>Lost touch with Scout's local service. Your answers are kept.</span>
              <button type="button" onClick={retry} disabled={retrying} style={reconnectButtonStyle}>
                {retrying ? "Retrying…" : "Retry"}
              </button>
            </div>
          ) : null}
          <ScoutContext.Provider value={held ?? scout}>
            <OnboardingTakeover />
          </ScoutContext.Provider>
        </>
      )}
    </div>
  );
}

const reconnectStyle: React.CSSProperties = {
  position: "fixed",
  top: 12,
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 1,
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid color-mix(in srgb, var(--hud-status-error) 35%, transparent)",
  backgroundColor: "var(--hud-surface)",
  color: "var(--hud-status-error)",
  fontSize: 12,
};

const reconnectButtonStyle: React.CSSProperties = {
  fontSize: 12,
  padding: "4px 10px",
  borderRadius: 6,
  border: "1px solid var(--hud-border)",
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
};
