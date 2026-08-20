// ─────────────────────────────────────────────────────────────────────────
// design-sync preview provider — NOT used by the app.
//
// A lightweight stand-in for ScoutProvider: it paints the real dark theme vars
// and supplies a mock ScoutContext + ContextMenuProvider so context-coupled
// components (AgentsLibrary) render — WITHOUT mounting the app's fixed
// settings-drawer / file-overlay chrome, which otherwise escapes the design
// tool's grid cells. cfg.provider points here.
// ─────────────────────────────────────────────────────────────────────────
import { type ReactNode } from "react";
import { DARK_THEME_VARS, ScoutContext } from "../scout/Provider.tsx";
import { ContextMenuProvider } from "../components/ContextMenu.tsx";

// A complete-enough ScoutContextValue for preview rendering. The directory only
// reads `route` + `reload`; the rest are inert defaults. Loose-typed — this is
// fixture wiring, not app code.
const value: any = {
  route: { view: "agents-v2", projectSlug: "openscout" },
  navigate: () => {},
  navigateBack: () => {},
  canNavigateBack: false,
  agents: [],
  agentsLoaded: true,
  onlineCount: 0,
  apiConnection: { status: "online", message: null, lastCheckedAt: null },
  reload: async () => {},
  onboarding: null,
  refreshOnboarding: async () => {},
  onboardingSkipped: false,
  skipOnboarding: () => {},
  settingsOpen: false,
  openSettings: () => {},
  closeSettings: () => {},
  scoutbotAgentId: "",
  scoutbotConversationId: null,
  applyScoutbotUiAction: () => {},
  selectedBrokerAttempt: null,
  inspectBrokerAttempt: () => {},
  clearBrokerAttempt: () => {},
  selectedKnowledgeHit: null,
  selectedKnowledgeQuery: "",
  inspectKnowledgeHit: () => {},
  clearKnowledgeHit: () => {},
  focusedSession: null,
  focusSession: () => {},
  openFilePreview: () => {},
  closeFilePreview: () => {},
  openContextCapture: () => {},
  closeContextCapture: () => {},
};

export function DesignProvider({ children }: { children: ReactNode }) {
  return (
    <div
      data-scout-theme="dark"
      data-scout-theme-mode="dark"
      style={{ ...DARK_THEME_VARS, background: "var(--hud-bg)", color: "var(--hud-ink)", minHeight: "100%" }}
    >
      <ScoutContext.Provider value={value}>
        <ContextMenuProvider>{children}</ContextMenuProvider>
      </ScoutContext.Provider>
    </div>
  );
}
