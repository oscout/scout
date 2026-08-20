import type {
  ScoutDesktopAppInfo,
  ScoutDesktopHomeState,
  ScoutDesktopMessagesWorkspaceState,
  ScoutDesktopServicesState,
  ScoutDesktopShellPatch,
  ScoutDesktopShellState,
  ScoutPhonePreparationState,
  UpdateScoutPhonePreparationInput,
} from "../desktop/index.ts";
import type {
  ScoutDesktopAgentConfigState,
  ScoutDesktopUpdateAgentConfigInput,
} from "./agent-config.ts";
import type {
  ScoutDesktopCreateAgentInput,
  ScoutDesktopCreateAgentResult,
  ScoutDesktopBrokerControlAction,
  ScoutDesktopRestartAgentInput,
  ScoutDesktopSendRelayMessageInput,
} from "./broker-actions.ts";
import type {
  AcquireScoutKeepAliveLeaseInput,
  ReleaseScoutKeepAliveLeaseInput,
  ScoutKeepAliveLease,
  ScoutKeepAliveState,
} from "./keep-alive.ts";
import type {
  AnswerScoutPairingQuestionInput,
  DecideScoutPairingApprovalInput,
  ScoutPairingControlAction,
  ScoutPairingState,
  UpdateScoutPairingConfigInput,
} from "./pairing.ts";
import type {
  AppSettingsState,
  OnboardingCommandResult,
  RunOnboardingCommandInput,
  UpdateAppSettingsInput,
} from "./settings.ts";
import type {
  ScoutDesktopFeedbackBundle,
  ScoutDesktopFeedbackSubmission,
  ReadScoutLogSourceInput,
  SubmitScoutFeedbackReportInput,
  ScoutDesktopBrokerInspector,
  ScoutDesktopLogCatalog,
  ScoutDesktopLogContent,
} from "./diagnostics.ts";
import type {
  AnswerScoutDesktopAgentSessionQuestionInput,
  ScoutDesktopAgentSessionInspector,
} from "./agent-session.ts";
import { SCOUT_DESKTOP_CHANNELS } from "./channels.ts";

export type ScoutDesktopInvoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

export type ScoutDesktopBridge = {
  isDesktop: boolean;
  getAppInfo: () => Promise<ScoutDesktopAppInfo>;
  getServicesState: () => Promise<ScoutDesktopServicesState>;
  getHomeState: () => Promise<ScoutDesktopHomeState>;
  getMessagesWorkspaceState: () => Promise<ScoutDesktopMessagesWorkspaceState>;
  getRelayShellPatch: () => Promise<ScoutDesktopShellPatch>;
  getShellState: () => Promise<ScoutDesktopShellState>;
  refreshRelayShellPatch: () => Promise<ScoutDesktopShellPatch>;
  refreshShellState: () => Promise<ScoutDesktopShellState>;
  getAppSettings: () => Promise<AppSettingsState>;
  refreshSettingsInventory: () => Promise<AppSettingsState>;
  updateAppSettings: (input: UpdateAppSettingsInput) => Promise<AppSettingsState>;
  retireProject: (projectRoot: string) => Promise<AppSettingsState>;
  restoreProject: (projectRoot: string) => Promise<AppSettingsState>;
  runOnboardingCommand: (input: RunOnboardingCommandInput) => Promise<OnboardingCommandResult>;
  skipOnboarding: () => Promise<AppSettingsState>;
  restartOnboarding: () => Promise<AppSettingsState>;
  getAgentConfig: (agentId: string) => Promise<ScoutDesktopAgentConfigState>;
  updateAgentConfig: (input: ScoutDesktopUpdateAgentConfigInput) => Promise<ScoutDesktopAgentConfigState>;
  createAgent: (input: ScoutDesktopCreateAgentInput) => Promise<ScoutDesktopCreateAgentResult>;
  pickDirectory: () => Promise<string | null>;
  reloadApp: () => Promise<boolean>;
  quitApp: () => Promise<boolean>;
  revealPath: (filePath: string) => Promise<boolean>;
  getPhonePreparation: () => Promise<ScoutPhonePreparationState>;
  updatePhonePreparation: (input: UpdateScoutPhonePreparationInput) => Promise<ScoutPhonePreparationState>;
  getPairingState: () => Promise<ScoutPairingState>;
  refreshPairingState: () => Promise<ScoutPairingState>;
  controlPairingService: (action: ScoutPairingControlAction) => Promise<ScoutPairingState>;
  updatePairingConfig: (input: UpdateScoutPairingConfigInput) => Promise<ScoutPairingState>;
  decidePairingApproval: (input: DecideScoutPairingApprovalInput) => Promise<ScoutPairingState>;
  answerPairingQuestion: (input: AnswerScoutPairingQuestionInput) => Promise<ScoutPairingState>;
  restartAgent: (input: ScoutDesktopRestartAgentInput) => Promise<ScoutDesktopShellState>;
  sendRelayMessage: (input: ScoutDesktopSendRelayMessageInput) => Promise<ScoutDesktopShellPatch>;
  controlBroker: (action: ScoutDesktopBrokerControlAction) => Promise<ScoutDesktopShellState>;
  getKeepAliveState: () => Promise<ScoutKeepAliveState>;
  acquireKeepAliveLease: (input: AcquireScoutKeepAliveLeaseInput) => Promise<ScoutKeepAliveLease>;
  releaseKeepAliveLease: (input: ReleaseScoutKeepAliveLeaseInput) => Promise<boolean>;
  getAgentSession: (agentId: string) => Promise<ScoutDesktopAgentSessionInspector>;
  answerAgentSessionQuestion: (input: AnswerScoutDesktopAgentSessionQuestionInput) => Promise<boolean>;
  openAgentSession: (agentId: string) => Promise<boolean>;
  toggleVoiceCapture: () => Promise<ScoutDesktopShellState>;
  setVoiceRepliesEnabled: (enabled: boolean) => Promise<ScoutDesktopShellState>;
  getLogCatalog: () => Promise<ScoutDesktopLogCatalog>;
  getBrokerInspector: () => Promise<ScoutDesktopBrokerInspector>;
  getFeedbackBundle: () => Promise<ScoutDesktopFeedbackBundle>;
  submitFeedbackReport: (input: SubmitScoutFeedbackReportInput) => Promise<ScoutDesktopFeedbackSubmission>;
  readLogSource: (input: ReadScoutLogSourceInput) => Promise<ScoutDesktopLogContent>;
  onOpenKnowledgeBase?: (callback: () => void) => () => void;
};

export function createScoutDesktopBridge(invoke: ScoutDesktopInvoke): ScoutDesktopBridge {
  return {
    isDesktop: true,
    getAppInfo: () => invoke(SCOUT_DESKTOP_CHANNELS.getAppInfo) as Promise<ScoutDesktopAppInfo>,
    getServicesState: () => invoke(SCOUT_DESKTOP_CHANNELS.getServicesState) as Promise<ScoutDesktopServicesState>,
    getHomeState: () => invoke(SCOUT_DESKTOP_CHANNELS.getHomeState) as Promise<ScoutDesktopHomeState>,
    getMessagesWorkspaceState: () => invoke(
      SCOUT_DESKTOP_CHANNELS.getMessagesWorkspaceState,
    ) as Promise<ScoutDesktopMessagesWorkspaceState>,
    getRelayShellPatch: () => invoke(
      SCOUT_DESKTOP_CHANNELS.getRelayShellPatch,
    ) as Promise<ScoutDesktopShellPatch>,
    getShellState: () => invoke(SCOUT_DESKTOP_CHANNELS.getShellState) as Promise<ScoutDesktopShellState>,
    refreshRelayShellPatch: () => invoke(
      SCOUT_DESKTOP_CHANNELS.refreshRelayShellPatch,
    ) as Promise<ScoutDesktopShellPatch>,
    refreshShellState: () => invoke(SCOUT_DESKTOP_CHANNELS.refreshShellState) as Promise<ScoutDesktopShellState>,
    getAppSettings: () => invoke(SCOUT_DESKTOP_CHANNELS.getAppSettings) as Promise<AppSettingsState>,
    refreshSettingsInventory: () => invoke(
      SCOUT_DESKTOP_CHANNELS.refreshSettingsInventory,
    ) as Promise<AppSettingsState>,
    updateAppSettings: (input) => invoke(
      SCOUT_DESKTOP_CHANNELS.updateAppSettings,
      input,
    ) as Promise<AppSettingsState>,
    retireProject: (projectRoot) => invoke(
      SCOUT_DESKTOP_CHANNELS.retireProject,
      projectRoot,
    ) as Promise<AppSettingsState>,
    restoreProject: (projectRoot) => invoke(
      SCOUT_DESKTOP_CHANNELS.restoreProject,
      projectRoot,
    ) as Promise<AppSettingsState>,
    runOnboardingCommand: (input) => invoke(
      SCOUT_DESKTOP_CHANNELS.runOnboardingCommand,
      input,
    ) as Promise<OnboardingCommandResult>,
    skipOnboarding: () => invoke(SCOUT_DESKTOP_CHANNELS.skipOnboarding) as Promise<AppSettingsState>,
    restartOnboarding: () => invoke(SCOUT_DESKTOP_CHANNELS.restartOnboarding) as Promise<AppSettingsState>,
    getAgentConfig: (agentId) => invoke(
      SCOUT_DESKTOP_CHANNELS.getAgentConfig,
      agentId,
    ) as Promise<ScoutDesktopAgentConfigState>,
    updateAgentConfig: (input) => invoke(
      SCOUT_DESKTOP_CHANNELS.updateAgentConfig,
      input,
    ) as Promise<ScoutDesktopAgentConfigState>,
    createAgent: (input) => invoke(
      SCOUT_DESKTOP_CHANNELS.createAgent,
      input,
    ) as Promise<ScoutDesktopCreateAgentResult>,
    pickDirectory: () => invoke(SCOUT_DESKTOP_CHANNELS.pickDirectory) as Promise<string | null>,
    reloadApp: () => invoke(SCOUT_DESKTOP_CHANNELS.reloadApp) as Promise<boolean>,
    quitApp: () => invoke(SCOUT_DESKTOP_CHANNELS.quitApp) as Promise<boolean>,
    revealPath: (filePath) => invoke(
      SCOUT_DESKTOP_CHANNELS.revealPath,
      filePath,
    ) as Promise<boolean>,
    getPhonePreparation: () => invoke(SCOUT_DESKTOP_CHANNELS.getPhonePreparation) as Promise<ScoutPhonePreparationState>,
    updatePhonePreparation: (input) => invoke(
      SCOUT_DESKTOP_CHANNELS.updatePhonePreparation,
      input,
    ) as Promise<ScoutPhonePreparationState>,
    getPairingState: () => invoke(SCOUT_DESKTOP_CHANNELS.getPairingState) as Promise<ScoutPairingState>,
    refreshPairingState: () => invoke(SCOUT_DESKTOP_CHANNELS.refreshPairingState) as Promise<ScoutPairingState>,
    controlPairingService: (action) => invoke(
      SCOUT_DESKTOP_CHANNELS.controlPairingService,
      action,
    ) as Promise<ScoutPairingState>,
    updatePairingConfig: (input) => invoke(
      SCOUT_DESKTOP_CHANNELS.updatePairingConfig,
      input,
    ) as Promise<ScoutPairingState>,
    decidePairingApproval: (input) => invoke(
      SCOUT_DESKTOP_CHANNELS.decidePairingApproval,
      input,
    ) as Promise<ScoutPairingState>,
    answerPairingQuestion: (input) => invoke(
      SCOUT_DESKTOP_CHANNELS.answerPairingQuestion,
      input,
    ) as Promise<ScoutPairingState>,
    restartAgent: (input) => invoke(
      SCOUT_DESKTOP_CHANNELS.restartAgent,
      input,
    ) as Promise<ScoutDesktopShellState>,
    sendRelayMessage: (input) => invoke(
      SCOUT_DESKTOP_CHANNELS.sendRelayMessage,
      input,
    ) as Promise<ScoutDesktopShellPatch>,
    controlBroker: (action) => invoke(
      SCOUT_DESKTOP_CHANNELS.controlBroker,
      action,
    ) as Promise<ScoutDesktopShellState>,
    getKeepAliveState: () => invoke(
      SCOUT_DESKTOP_CHANNELS.getKeepAliveState,
    ) as Promise<ScoutKeepAliveState>,
    acquireKeepAliveLease: (input) => invoke(
      SCOUT_DESKTOP_CHANNELS.acquireKeepAliveLease,
      input,
    ) as Promise<ScoutKeepAliveLease>,
    releaseKeepAliveLease: (input) => invoke(
      SCOUT_DESKTOP_CHANNELS.releaseKeepAliveLease,
      input,
    ) as Promise<boolean>,
    getAgentSession: (agentId) => invoke(
      SCOUT_DESKTOP_CHANNELS.getAgentSession,
      agentId,
    ) as Promise<ScoutDesktopAgentSessionInspector>,
    answerAgentSessionQuestion: (input) => invoke(
      SCOUT_DESKTOP_CHANNELS.answerAgentSessionQuestion,
      input,
    ) as Promise<boolean>,
    openAgentSession: (agentId) => invoke(
      SCOUT_DESKTOP_CHANNELS.openAgentSession,
      agentId,
    ) as Promise<boolean>,
    toggleVoiceCapture: () => invoke(
      SCOUT_DESKTOP_CHANNELS.toggleVoiceCapture,
    ) as Promise<ScoutDesktopShellState>,
    setVoiceRepliesEnabled: (enabled) => invoke(
      SCOUT_DESKTOP_CHANNELS.setVoiceRepliesEnabled,
      enabled,
    ) as Promise<ScoutDesktopShellState>,
    getLogCatalog: () => invoke(
      SCOUT_DESKTOP_CHANNELS.getLogCatalog,
    ) as Promise<ScoutDesktopLogCatalog>,
    getBrokerInspector: () => invoke(
      SCOUT_DESKTOP_CHANNELS.getBrokerInspector,
    ) as Promise<ScoutDesktopBrokerInspector>,
    getFeedbackBundle: () => invoke(
      SCOUT_DESKTOP_CHANNELS.getFeedbackBundle,
    ) as Promise<ScoutDesktopFeedbackBundle>,
    submitFeedbackReport: (input) => invoke(
      SCOUT_DESKTOP_CHANNELS.submitFeedbackReport,
      input,
    ) as Promise<ScoutDesktopFeedbackSubmission>,
    readLogSource: (input) => invoke(
      SCOUT_DESKTOP_CHANNELS.readLogSource,
      input,
    ) as Promise<ScoutDesktopLogContent>,
  };
}
