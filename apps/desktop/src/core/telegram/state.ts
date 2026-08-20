import { SCOUT_TELEGRAM_PRIMARY_CONVERSATION_ID, SCOUT_TELEGRAM_SHARED_CHANNEL_ID } from "./bindings.ts";

export type ScoutTelegramBridgeMode = "auto" | "webhook" | "polling";
export type ScoutTelegramBridgeRuntimeMode = "webhook" | "polling" | null;

export type ScoutTelegramBridgeConfig = {
  enabled: boolean;
  configured: boolean;
  mode: ScoutTelegramBridgeMode;
  botToken: string;
  secretToken: string;
  apiBaseUrl: string;
  userName: string;
  defaultConversationId: string;
  ownerNodeId: string;
};

export type ScoutTelegramBridgeRuntimeState = {
  enabled: boolean;
  configured: boolean;
  running: boolean;
  mode: ScoutTelegramBridgeMode;
  runtimeMode: ScoutTelegramBridgeRuntimeMode;
  detail: string;
  lastError: string | null;
  bindingCount: number;
  pendingDeliveries: number;
};

export type ScoutTelegramRuntimeReadiness = {
  brokerReachable: boolean;
  localNodeId: string | null;
  ownerNodeId: string | null;
  ownerPinned?: boolean;
};

export function normalizeScoutTelegramBridgeConfig(input: {
  enabled: boolean;
  mode: ScoutTelegramBridgeMode;
  botToken: string;
  secretToken: string;
  apiBaseUrl: string;
  userName: string;
  defaultConversationId: string;
  ownerNodeId: string;
}): ScoutTelegramBridgeConfig {
  const botToken = input.botToken.trim();
  const normalizedDefaultConversationId =
    !input.defaultConversationId.trim() || input.defaultConversationId.trim() === SCOUT_TELEGRAM_SHARED_CHANNEL_ID
      ? SCOUT_TELEGRAM_PRIMARY_CONVERSATION_ID
      : input.defaultConversationId.trim();

  return {
    enabled: input.enabled,
    configured: Boolean(botToken),
    mode: input.mode,
    botToken,
    secretToken: input.secretToken.trim(),
    apiBaseUrl: input.apiBaseUrl.trim(),
    userName: input.userName.trim(),
    defaultConversationId: normalizedDefaultConversationId,
    ownerNodeId: input.ownerNodeId.trim(),
  };
}

export function createScoutTelegramBridgeRuntimeState(
  input: Partial<ScoutTelegramBridgeRuntimeState> = {},
): ScoutTelegramBridgeRuntimeState {
  return {
    enabled: Boolean(input.enabled),
    configured: Boolean(input.configured),
    running: Boolean(input.running),
    mode: input.mode ?? "polling",
    runtimeMode: input.runtimeMode ?? null,
    detail: typeof input.detail === "string" ? input.detail : "Telegram bridge disabled.",
    lastError: typeof input.lastError === "string" ? input.lastError : null,
    bindingCount: typeof input.bindingCount === "number" ? input.bindingCount : 0,
    pendingDeliveries: typeof input.pendingDeliveries === "number" ? input.pendingDeliveries : 0,
  };
}

export function deriveScoutTelegramBridgeRuntimeState(input: {
  config: ScoutTelegramBridgeConfig;
  readiness: ScoutTelegramRuntimeReadiness;
  running?: boolean;
  runtimeMode?: ScoutTelegramBridgeRuntimeMode;
  bindingCount?: number;
  pendingDeliveries?: number;
  lastError?: string | null;
}): ScoutTelegramBridgeRuntimeState {
  const running = Boolean(input.running);
  const base = {
    enabled: input.config.enabled,
    configured: input.config.configured,
    running,
    mode: input.config.mode,
    runtimeMode: running ? (input.runtimeMode ?? null) : null,
    lastError: input.lastError ?? null,
    bindingCount: input.bindingCount ?? 0,
    pendingDeliveries: input.pendingDeliveries ?? 0,
  };

  if (!input.config.enabled) {
    return createScoutTelegramBridgeRuntimeState({
      ...base,
      detail: "Telegram bridge disabled in settings.",
    });
  }

  if (!input.config.configured) {
    return createScoutTelegramBridgeRuntimeState({
      ...base,
      detail: "Telegram bridge is enabled, but the bot token is missing.",
    });
  }

  if (!input.readiness.brokerReachable || !input.readiness.localNodeId) {
    return createScoutTelegramBridgeRuntimeState({
      ...base,
      detail: "Telegram bridge is waiting for the local Relay broker.",
    });
  }

  if (input.readiness.ownerNodeId && input.readiness.ownerNodeId !== input.readiness.localNodeId) {
    return createScoutTelegramBridgeRuntimeState({
      ...base,
      detail: input.readiness.ownerPinned
        ? `Telegram bridge standby. External comms are pinned to ${input.readiness.ownerNodeId}.`
        : `Telegram bridge standby. Automatic mesh owner is ${input.readiness.ownerNodeId}.`,
    });
  }

  return createScoutTelegramBridgeRuntimeState({
    ...base,
    detail: running
      ? `Telegram bridge active in ${input.runtimeMode ?? "polling"} mode.`
      : "Telegram bridge ready.",
  });
}
