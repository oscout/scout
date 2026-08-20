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
import {
  getScoutDesktopAgentConfig,
  updateScoutDesktopAgentConfig,
  type ScoutDesktopAgentConfigState,
  type ScoutDesktopUpdateAgentConfigInput,
} from "./agent-config.ts";
import {
  createScoutDesktopAgent,
  controlScoutDesktopBroker,
  restartScoutDesktopAgent,
  sendScoutDesktopRelayMessage,
  type ScoutDesktopBrokerControlAction,
  type ScoutDesktopCreateAgentInput,
  type ScoutDesktopCreateAgentResult,
  type ScoutDesktopRestartAgentInput,
  type ScoutDesktopSendRelayMessageInput,
} from "./broker-actions.ts";
import {
  getScoutDesktopFeedbackBundle,
  getScoutDesktopBrokerInspector,
  getScoutDesktopLogCatalog,
  readScoutDesktopLogSource,
  submitScoutDesktopFeedbackReport,
  type ReadScoutLogSourceInput,
  type ScoutDesktopBrokerInspector,
  type ScoutDesktopFeedbackBundle,
  type ScoutDesktopFeedbackSubmission,
  type ScoutDesktopLogCatalog,
  type ScoutDesktopLogContent,
  type SubmitScoutFeedbackReportInput,
} from "./diagnostics.ts";
import {
  pickScoutHostDirectory,
  reloadScoutHostApp,
  quitScoutHostApp,
  revealScoutHostPath,
  type ScoutHostNativeServices,
} from "./native-host.ts";
import {
  acquireScoutKeepAliveLease,
  getScoutKeepAliveState,
  releaseScoutKeepAliveLease,
  type AcquireScoutKeepAliveLeaseInput,
  type ReleaseScoutKeepAliveLeaseInput,
  type ScoutKeepAliveLease,
  type ScoutKeepAliveState,
} from "./keep-alive.ts";
import type {
  AnswerScoutPairingQuestionInput,
  DecideScoutPairingApprovalInput,
  ScoutPairingControlAction,
  ScoutPairingState,
  UpdateScoutPairingConfigInput,
} from "./pairing.ts";
import {
  answerScoutDesktopPairingQuestion,
  controlScoutDesktopPairingService,
  decideScoutDesktopPairingApproval,
  getScoutDesktopPairingState,
  refreshScoutDesktopPairingState,
  updateScoutDesktopPairingConfig,
} from "./pairing.ts";
import {
  answerScoutDesktopAgentSessionQuestion,
  getScoutDesktopAgentSession,
  openScoutDesktopAgentSession,
  type AnswerScoutDesktopAgentSessionQuestionInput,
  type ScoutDesktopAgentSessionHost,
  type ScoutDesktopAgentSessionInspector,
} from "./agent-session.ts";
import {
  getScoutDesktopAppInfo,
  getScoutDesktopHomeState,
  getScoutDesktopMessagesWorkspaceState,
  getScoutDesktopRelayShellPatch,
  getScoutDesktopServicesState,
  getScoutDesktopPhonePreparation,
  getScoutDesktopShellState,
  refreshScoutDesktopRelayShellPatch,
  refreshScoutDesktopShellState,
  setScoutDesktopVoiceRepliesEnabled,
  toggleScoutDesktopVoiceCapture,
  updateScoutDesktopPhonePreparation,
  type ScoutDesktopVoiceService,
} from "./service.ts";
import {
  getScoutDesktopAppSettings,
  refreshScoutDesktopAppSettingsInventory,
  restoreScoutDesktopProject,
  retireScoutDesktopProject,
  restartScoutDesktopOnboarding,
  runScoutDesktopOnboardingCommand,
  skipScoutDesktopOnboarding,
  updateScoutDesktopAppSettings,
  type AppSettingsState,
  type OnboardingCommandResult,
  type RunOnboardingCommandInput,
  type ScoutDesktopSettingsService,
  type UpdateAppSettingsInput,
} from "./settings.ts";

export type CreateScoutHostServicesInput = {
  currentDirectory?: string;
  appInfo?: ScoutDesktopAppInfo;
  voice?: ScoutDesktopVoiceService;
  settings?: ScoutDesktopSettingsService;
  agentSessionHost?: ScoutDesktopAgentSessionHost;
  host?: ScoutHostNativeServices;
};

export type AppInfoServices = {
  getAppInfo: () => Promise<ScoutDesktopAppInfo> | ScoutDesktopAppInfo;
};

export type DesktopStateServices = {
  getServicesState: () => Promise<ScoutDesktopServicesState>;
  getHomeState: () => Promise<ScoutDesktopHomeState>;
  getMessagesWorkspaceState: () => Promise<ScoutDesktopMessagesWorkspaceState>;
  getRelayShellPatch: () => Promise<ScoutDesktopShellPatch>;
  getShellState: () => Promise<ScoutDesktopShellState>;
  refreshRelayShellPatch: () => Promise<ScoutDesktopShellPatch>;
  refreshShellState: () => Promise<ScoutDesktopShellState>;
};

export type SettingsAdminServices = {
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
  getPhonePreparation: () => Promise<ScoutPhonePreparationState>;
  updatePhonePreparation: (input: UpdateScoutPhonePreparationInput) => Promise<ScoutPhonePreparationState>;
};

export type NativeHostServices = {
  pickDirectory: () => Promise<string | null>;
  reloadApp: () => Promise<boolean>;
  quitApp: () => Promise<boolean>;
  revealPath: (filePath: string) => Promise<boolean>;
};

export type PairingServices = {
  getPairingState: () => Promise<ScoutPairingState>;
  refreshPairingState: () => Promise<ScoutPairingState>;
  controlPairingService: (action: ScoutPairingControlAction) => Promise<ScoutPairingState>;
  updatePairingConfig: (input: UpdateScoutPairingConfigInput) => Promise<ScoutPairingState>;
  decidePairingApproval: (input: DecideScoutPairingApprovalInput) => Promise<ScoutPairingState>;
  answerPairingQuestion: (input: AnswerScoutPairingQuestionInput) => Promise<ScoutPairingState>;
};

export type RelayActivityServices = {
  restartAgent: (input: ScoutDesktopRestartAgentInput) => Promise<ScoutDesktopShellState>;
  sendRelayMessage: (input: ScoutDesktopSendRelayMessageInput) => Promise<ScoutDesktopShellPatch>;
  getKeepAliveState: () => Promise<ScoutKeepAliveState> | ScoutKeepAliveState;
  acquireKeepAliveLease: (input: AcquireScoutKeepAliveLeaseInput) => Promise<ScoutKeepAliveLease> | ScoutKeepAliveLease;
  releaseKeepAliveLease: (input: ReleaseScoutKeepAliveLeaseInput) => Promise<boolean> | boolean;
  getAgentSession: (agentId: string) => Promise<ScoutDesktopAgentSessionInspector>;
  answerAgentSessionQuestion: (input: AnswerScoutDesktopAgentSessionQuestionInput) => Promise<boolean>;
  openAgentSession: (agentId: string) => Promise<boolean>;
  toggleVoiceCapture: () => Promise<ScoutDesktopShellState>;
  setVoiceRepliesEnabled: (enabled: boolean) => Promise<ScoutDesktopShellState>;
};

export type BrokerAdminServices = {
  controlBroker: (action: ScoutDesktopBrokerControlAction) => Promise<ScoutDesktopShellState>;
};

export type DiagnosticsServices = {
  getLogCatalog: () => Promise<ScoutDesktopLogCatalog>;
  getBrokerInspector: () => Promise<ScoutDesktopBrokerInspector>;
  getFeedbackBundle: () => Promise<ScoutDesktopFeedbackBundle>;
  submitFeedbackReport: (input: SubmitScoutFeedbackReportInput) => Promise<ScoutDesktopFeedbackSubmission>;
  readLogSource: (input: ReadScoutLogSourceInput) => Promise<ScoutDesktopLogContent>;
};

export type ScoutHostServices = AppInfoServices
  & DesktopStateServices
  & SettingsAdminServices
  & NativeHostServices
  & PairingServices
  & RelayActivityServices
  & BrokerAdminServices
  & DiagnosticsServices;

function resolveCurrentDirectory(input?: string): string {
  return input ?? process.cwd();
}

export function createAppInfoServices(
  input: CreateScoutHostServicesInput = {},
): AppInfoServices {
  const appInfo = input.appInfo;
  return {
    getAppInfo: () => appInfo ?? getScoutDesktopAppInfo(),
  };
}

export function createDesktopStateServices(
  input: CreateScoutHostServicesInput = {},
): DesktopStateServices {
  const currentDirectory = resolveCurrentDirectory(input.currentDirectory);
  const appInfo = input.appInfo;
  const voice = input.voice;

  return {
    getServicesState: () => getScoutDesktopServicesState({ currentDirectory, appInfo, voice }),
    getHomeState: () => getScoutDesktopHomeState({ currentDirectory, appInfo, voice }),
    getMessagesWorkspaceState: () => getScoutDesktopMessagesWorkspaceState({ currentDirectory, appInfo, voice }),
    getRelayShellPatch: () => getScoutDesktopRelayShellPatch({ currentDirectory, appInfo, voice }),
    getShellState: () => getScoutDesktopShellState({ currentDirectory, appInfo, voice }),
    refreshRelayShellPatch: () => refreshScoutDesktopRelayShellPatch({ currentDirectory, appInfo, voice }),
    refreshShellState: () => refreshScoutDesktopShellState({ currentDirectory, appInfo, voice }),
  };
}

export function createSettingsAdminServices(
  input: CreateScoutHostServicesInput = {},
): SettingsAdminServices {
  const currentDirectory = resolveCurrentDirectory(input.currentDirectory);
  const appInfo = input.appInfo;
  const settings = input.settings ?? {};

  return {
    getAppSettings: () => getScoutDesktopAppSettings(currentDirectory, settings),
    refreshSettingsInventory: () => refreshScoutDesktopAppSettingsInventory(currentDirectory, settings),
    updateAppSettings: (nextInput) => updateScoutDesktopAppSettings(nextInput, currentDirectory, settings),
    retireProject: (projectRoot) => retireScoutDesktopProject(projectRoot, currentDirectory, settings),
    restoreProject: (projectRoot) => restoreScoutDesktopProject(projectRoot, currentDirectory, settings),
    runOnboardingCommand: (nextInput) => runScoutDesktopOnboardingCommand(nextInput, currentDirectory),
    skipOnboarding: () => skipScoutDesktopOnboarding(currentDirectory, settings),
    restartOnboarding: () => restartScoutDesktopOnboarding(currentDirectory, settings),
    getAgentConfig: (agentId) => getScoutDesktopAgentConfig(agentId),
    updateAgentConfig: (nextInput) => updateScoutDesktopAgentConfig(nextInput),
    createAgent: (nextInput) => createScoutDesktopAgent(nextInput, { currentDirectory, appInfo }),
    getPhonePreparation: () => getScoutDesktopPhonePreparation(currentDirectory),
    updatePhonePreparation: (nextInput) => updateScoutDesktopPhonePreparation(nextInput, currentDirectory),
  };
}

export function createNativeHostServices(
  input: CreateScoutHostServicesInput = {},
): NativeHostServices {
  const host = input.host ?? {};

  return {
    pickDirectory: () => pickScoutHostDirectory(host),
    reloadApp: () => reloadScoutHostApp(host),
    quitApp: () => quitScoutHostApp(host),
    revealPath: (filePath) => revealScoutHostPath(filePath, host),
  };
}

export function createPairingServices(
  input: CreateScoutHostServicesInput = {},
): PairingServices {
  const currentDirectory = resolveCurrentDirectory(input.currentDirectory);

  return {
    getPairingState: () => getScoutDesktopPairingState(currentDirectory),
    refreshPairingState: () => refreshScoutDesktopPairingState(currentDirectory),
    controlPairingService: (action) => controlScoutDesktopPairingService(action, currentDirectory),
    updatePairingConfig: (nextInput) => updateScoutDesktopPairingConfig(nextInput, currentDirectory),
    decidePairingApproval: (nextInput) => decideScoutDesktopPairingApproval(nextInput, currentDirectory),
    answerPairingQuestion: (nextInput) => answerScoutDesktopPairingQuestion(nextInput, currentDirectory),
  };
}

export function createRelayActivityServices(
  input: CreateScoutHostServicesInput = {},
): RelayActivityServices {
  const currentDirectory = resolveCurrentDirectory(input.currentDirectory);
  const appInfo = input.appInfo;
  const voice = input.voice;
  const agentSessionHost = input.agentSessionHost;

  return {
    restartAgent: async (nextInput) => {
      await restartScoutDesktopAgent(nextInput, { currentDirectory, appInfo });
      return refreshScoutDesktopShellState({ currentDirectory, appInfo, voice });
    },
    sendRelayMessage: (nextInput) => sendScoutDesktopRelayMessage(nextInput, { currentDirectory, appInfo }),
    getKeepAliveState: () => getScoutKeepAliveState(),
    acquireKeepAliveLease: (nextInput) => acquireScoutKeepAliveLease(nextInput),
    releaseKeepAliveLease: (nextInput) => releaseScoutKeepAliveLease(nextInput.leaseId),
    getAgentSession: (agentId) => getScoutDesktopAgentSession(agentId),
    answerAgentSessionQuestion: async (nextInput) => {
      await answerScoutDesktopAgentSessionQuestion(nextInput);
      return true;
    },
    openAgentSession: (agentId) => openScoutDesktopAgentSession(agentId, agentSessionHost),
    toggleVoiceCapture: () => toggleScoutDesktopVoiceCapture({ currentDirectory, appInfo, voice }),
    setVoiceRepliesEnabled: (enabled) => setScoutDesktopVoiceRepliesEnabled(enabled, { currentDirectory, appInfo, voice }),
  };
}

export function createBrokerAdminServices(
  input: CreateScoutHostServicesInput = {},
): BrokerAdminServices {
  const currentDirectory = resolveCurrentDirectory(input.currentDirectory);
  const appInfo = input.appInfo;
  const voice = input.voice;
  const settings = input.settings ?? {};

  return {
    controlBroker: async (action) => {
      await controlScoutDesktopBroker(action, {
        currentDirectory,
        appInfo,
        telegram: {
          refreshConfiguration: settings.refreshTelegramConfiguration,
        },
      });
      return refreshScoutDesktopShellState({ currentDirectory, appInfo, voice });
    },
  };
}

export function createDiagnosticsServices(
  input: CreateScoutHostServicesInput = {},
): DiagnosticsServices {
  const currentDirectory = resolveCurrentDirectory(input.currentDirectory);

  return {
    getLogCatalog: () => getScoutDesktopLogCatalog(currentDirectory),
    getBrokerInspector: () => getScoutDesktopBrokerInspector(),
    getFeedbackBundle: () => getScoutDesktopFeedbackBundle(currentDirectory),
    submitFeedbackReport: (nextInput) => submitScoutDesktopFeedbackReport(nextInput, currentDirectory),
    readLogSource: (nextInput) => readScoutDesktopLogSource(nextInput, currentDirectory),
  };
}

export function createScoutHostServices(
  input: CreateScoutHostServicesInput = {},
): ScoutHostServices {
  return {
    ...createAppInfoServices(input),
    ...createDesktopStateServices(input),
    ...createSettingsAdminServices(input),
    ...createNativeHostServices(input),
    ...createPairingServices(input),
    ...createRelayActivityServices(input),
    ...createBrokerAdminServices(input),
    ...createDiagnosticsServices(input),
  };
}
