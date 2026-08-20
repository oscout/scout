import { tailscaleStatusProbe } from "@openscout/runtime/system-probes";

import {
  createScoutDesktopAppInfo,
  loadScoutDesktopHomeState,
  loadScoutDesktopMessagesWorkspaceState,
  loadScoutDesktopRelayShellPatch,
  loadScoutDesktopServicesState,
  loadScoutDesktopShellState,
  loadScoutPhonePreparation,
  updateScoutPhonePreparation,
  type ScoutDesktopAppInfo,
  type ScoutDesktopHomeState,
  type ScoutDesktopMessagesWorkspaceState,
  type ScoutDesktopShellPatch,
  type ScoutDesktopServicesState,
  type ScoutDesktopShellState,
  type ScoutPhonePreparationState,
  type UpdateScoutPhonePreparationInput,
} from "../desktop/index.ts";
import { getScoutDesktopPairingState } from "./pairing.ts";
import type { ScoutHostVoiceState as ScoutDesktopVoiceState } from "./voice.ts";

export type ScoutDesktopServiceOptions = {
  currentDirectory?: string;
  appInfo?: ScoutDesktopAppInfo;
  voice?: ScoutDesktopVoiceService;
};

export type ScoutDesktopVoiceService = {
  getVoiceState?: () => Promise<ScoutDesktopVoiceState> | ScoutDesktopVoiceState;
  toggleVoiceCapture?: () => Promise<void> | void;
  setVoiceRepliesEnabled?: (enabled: boolean) => Promise<void> | void;
};

function resolveCurrentDirectory(input?: string): string {
  return input ?? process.cwd();
}

export function getScoutDesktopAppInfo(input: {
  appVersion?: string;
  isPackaged?: boolean;
  platform?: string;
} = {}): ScoutDesktopAppInfo {
  return createScoutDesktopAppInfo({ ...input, surface: "desktop" });
}

export async function getScoutDesktopServicesState(
  options: ScoutDesktopServiceOptions = {},
): Promise<ScoutDesktopServicesState> {
  const currentDirectory = resolveCurrentDirectory(options.currentDirectory);
  const [servicesState, pairingState, tailscale] = await Promise.all([
    loadScoutDesktopServicesState(),
    getScoutDesktopPairingState(currentDirectory),
    Promise.resolve(tailscaleStatusProbe.read().value),
  ]);

  const pairingService = {
    id: "pairing" as const,
    title: "Pairing",
    status: pairingState.isRunning
      ? pairingState.status === "error"
        ? "degraded" as const
        : "running" as const
      : "offline" as const,
    statusLabel: pairingState.isRunning
      ? pairingState.status === "error"
        ? "Degraded"
        : "Running"
      : "Offline",
    healthy: pairingState.isRunning && pairingState.status !== "error",
    reachable: pairingState.isRunning,
    detail: pairingState.statusDetail ?? pairingState.statusLabel,
    lastHeartbeatLabel: pairingState.lastUpdatedLabel,
    updatedAtLabel: pairingState.lastUpdatedLabel ?? servicesState.updatedAtLabel,
    url: pairingState.relay,
    nodeId: null,
  };
  const tailscaleService = {
    id: "tailscale" as const,
    title: "Tailscale",
    status: tailscale === null
      ? "offline" as const
      : tailscale.running
        ? "running" as const
        : "degraded" as const,
    statusLabel: tailscale === null
      ? "Unavailable"
      : tailscale.running
        ? "Running"
        : "Stopped",
    healthy: Boolean(tailscale?.running),
    reachable: Boolean(tailscale?.running),
    detail: tailscale === null
      ? "Tailscale status is unavailable on this machine."
      : tailscale.running
        ? `${tailscale.peers.filter((peer) => peer.online).length}/${tailscale.peers.length} visible peers online`
        : (tailscale.health[0] ?? `Backend state: ${tailscale.backendState ?? "unknown"}`),
    lastHeartbeatLabel: null,
    updatedAtLabel: servicesState.updatedAtLabel,
    url: tailscale?.self?.dnsName?.replace(/\.$/, "") ?? tailscale?.self?.addresses[0] ?? null,
    nodeId: tailscale?.self?.id ?? null,
  };
  const nextServices = [...servicesState.services, tailscaleService, pairingService];
  const runningCount = nextServices.filter((service) => service.status === "running").length;

  return {
    ...servicesState,
    subtitle: `${runningCount}/${nextServices.length} running`,
    services: nextServices,
  };
}

export async function getScoutDesktopHomeState(
  options: ScoutDesktopServiceOptions = {},
): Promise<ScoutDesktopHomeState> {
  const currentDirectory = resolveCurrentDirectory(options.currentDirectory);
  return loadScoutDesktopHomeState({ currentDirectory });
}

async function applyScoutDesktopVoiceToMessagesWorkspaceState(
  messagesWorkspaceState: ScoutDesktopMessagesWorkspaceState,
  voiceService?: ScoutDesktopVoiceService,
): Promise<ScoutDesktopMessagesWorkspaceState> {
  if (!voiceService?.getVoiceState) {
    return messagesWorkspaceState;
  }

  const voice = await voiceService.getVoiceState();
  return {
    ...messagesWorkspaceState,
    relay: {
      ...messagesWorkspaceState.relay,
      voice,
    },
  };
}

async function applyScoutDesktopVoiceToRelayShellPatch(
  relayShellPatch: ScoutDesktopShellPatch,
  voiceService?: ScoutDesktopVoiceService,
): Promise<ScoutDesktopShellPatch> {
  if (!voiceService?.getVoiceState) {
    return relayShellPatch;
  }

  const voice = await voiceService.getVoiceState();
  return {
    ...relayShellPatch,
    relay: {
      ...relayShellPatch.relay,
      voice,
    },
  };
}

export async function getScoutDesktopMessagesWorkspaceState(
  options: ScoutDesktopServiceOptions = {},
): Promise<ScoutDesktopMessagesWorkspaceState> {
  const currentDirectory = resolveCurrentDirectory(options.currentDirectory);
  const messagesWorkspaceState = await loadScoutDesktopMessagesWorkspaceState({ currentDirectory });
  return applyScoutDesktopVoiceToMessagesWorkspaceState(messagesWorkspaceState, options.voice);
}

export async function getScoutDesktopRelayShellPatch(
  options: ScoutDesktopServiceOptions = {},
): Promise<ScoutDesktopShellPatch> {
  const currentDirectory = resolveCurrentDirectory(options.currentDirectory);
  const relayShellPatch = await loadScoutDesktopRelayShellPatch({ currentDirectory });
  return applyScoutDesktopVoiceToRelayShellPatch(relayShellPatch, options.voice);
}

async function applyScoutDesktopVoiceState(
  shellState: ScoutDesktopShellState,
  voiceService?: ScoutDesktopVoiceService,
): Promise<ScoutDesktopShellState> {
  if (!voiceService?.getVoiceState) {
    return shellState;
  }

  const voice = await voiceService.getVoiceState();
  return {
    ...shellState,
    relay: {
      ...shellState.relay,
      voice,
    },
  };
}

export async function getScoutDesktopShellState(
  options: ScoutDesktopServiceOptions = {},
): Promise<ScoutDesktopShellState> {
  const currentDirectory = resolveCurrentDirectory(options.currentDirectory);
  const shellState = await loadScoutDesktopShellState({
    currentDirectory,
    appInfo: options.appInfo ?? createScoutDesktopAppInfo(),
  });
  return applyScoutDesktopVoiceState(shellState, options.voice);
}

export async function refreshScoutDesktopShellState(
  options: ScoutDesktopServiceOptions = {},
): Promise<ScoutDesktopShellState> {
  return getScoutDesktopShellState(options);
}

export async function refreshScoutDesktopRelayShellPatch(
  options: ScoutDesktopServiceOptions = {},
): Promise<ScoutDesktopShellPatch> {
  return getScoutDesktopRelayShellPatch(options);
}

export async function getScoutDesktopPhonePreparation(
  currentDirectory = process.cwd(),
): Promise<ScoutPhonePreparationState> {
  return loadScoutPhonePreparation(currentDirectory);
}

export async function updateScoutDesktopPhonePreparation(
  input: UpdateScoutPhonePreparationInput,
  currentDirectory = process.cwd(),
): Promise<ScoutPhonePreparationState> {
  return updateScoutPhonePreparation(currentDirectory, input);
}

export async function toggleScoutDesktopVoiceCapture(
  options: ScoutDesktopServiceOptions = {},
): Promise<ScoutDesktopShellState> {
  if (!options.voice?.toggleVoiceCapture) {
    throw new Error("Scout voice capture is unavailable.");
  }

  await options.voice.toggleVoiceCapture();
  return refreshScoutDesktopShellState(options);
}

export async function setScoutDesktopVoiceRepliesEnabled(
  enabled: boolean,
  options: ScoutDesktopServiceOptions = {},
): Promise<ScoutDesktopShellState> {
  if (!options.voice?.setVoiceRepliesEnabled) {
    throw new Error("Scout voice playback control is unavailable.");
  }

  await options.voice.setVoiceRepliesEnabled(enabled);
  return refreshScoutDesktopShellState(options);
}
