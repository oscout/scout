import {
  loadScoutBrokerContext,
  loadScoutMessages,
  readScoutBrokerHealth,
  readScoutBrokerHome,
  resolveScoutBrokerUrl,
  type ScoutBrokerHealthState,
  type ScoutBrokerHomeActivityRecord,
  type ScoutBrokerHomeAgentRecord,
  type ScoutBrokerMessageRecord,
} from "../broker/service.ts";
import { sendScoutMobileMessage } from "../mobile/service.ts";
import {
  loadScoutRuntimesReport,
  type ScoutRuntimesReport,
} from "../setup/service.ts";

export type ScoutMonitorAgent = ScoutBrokerHomeAgentRecord;
export type ScoutMonitorActivity = ScoutBrokerHomeActivityRecord;

export type ScoutMonitorSnapshot = {
  refreshedAt: number;
  currentDirectory: string;
  brokerUrl: string;
  brokerHealth: ScoutBrokerHealthState;
  homeUpdatedAt: number | null;
  agents: ScoutMonitorAgent[];
  activity: ScoutMonitorActivity[];
  recentMessages: ScoutBrokerMessageRecord[];
  channel: string;
  errors: string[];
};

export type ScoutMonitorSnapshotOptions = {
  currentDirectory: string;
  channel?: string;
  limit?: number;
};

export type ScoutMonitorHarnessSnapshot = {
  conversationId: string | null;
  messages: ScoutBrokerMessageRecord[];
};

export type ScoutMonitorHarnessOptions = {
  senderId: string;
  agentId?: string;
  conversationId?: string;
  limit?: number;
};

const DEFAULT_MONITOR_CHANNEL = "shared";
const DEFAULT_MONITOR_MESSAGE_LIMIT = 64;
export const SCOUT_MONITOR_ASSISTANT_ID = "scoutbot";

export async function sendScoutMonitorAssistantMessage(input: {
  body: string;
  currentDirectory: string;
}): Promise<{ conversationId: string; messageId: string }> {
  return sendScoutMobileMessage({
    agentId: SCOUT_MONITOR_ASSISTANT_ID,
    body: input.body,
    source: "scout-tui-harness",
  }, input.currentDirectory);
}

export async function loadScoutMonitorRuntimes(
  currentDirectory: string,
): Promise<ScoutRuntimesReport> {
  return loadScoutRuntimesReport(currentDirectory);
}

export async function loadScoutMonitorHarness(
  input: ScoutMonitorHarnessOptions,
): Promise<ScoutMonitorHarnessSnapshot> {
  const brokerUrl = resolveScoutBrokerUrl();
  let conversationId = input.conversationId?.trim() || null;

  if (!conversationId && input.agentId?.trim()) {
    const context = await loadScoutBrokerContext(brokerUrl);
    const senderId = input.senderId.trim();
    const agentId = input.agentId.trim();
    const conversation = Object.values(context?.snapshot.conversations ?? {})
      .find((candidate) => (
        candidate.kind === "direct"
        && candidate.participantIds.includes(senderId)
        && candidate.participantIds.includes(agentId)
      ));
    conversationId = conversation?.id ?? null;
  }

  if (!conversationId) {
    return { conversationId: null, messages: [] };
  }

  const messages = await loadScoutMessages({
    baseUrl: brokerUrl,
    conversationId,
    limit: input.limit ?? DEFAULT_MONITOR_MESSAGE_LIMIT,
  });
  return { conversationId, messages };
}

export async function loadScoutMonitorSnapshot(
  input: ScoutMonitorSnapshotOptions,
): Promise<ScoutMonitorSnapshot> {
  const channel = input.channel?.trim() || DEFAULT_MONITOR_CHANNEL;
  const limit = input.limit ?? DEFAULT_MONITOR_MESSAGE_LIMIT;
  const brokerUrl = resolveScoutBrokerUrl();
  const errors: string[] = [];

  const [healthResult, homeResult, recentMessagesResult] = await Promise.allSettled([
    readScoutBrokerHealth(brokerUrl),
    readScoutBrokerHome(brokerUrl),
    loadScoutMessages({ baseUrl: brokerUrl, channel, limit }),
  ]);

  const brokerHealth = healthResult.status === "fulfilled"
    ? healthResult.value
    : offlineBrokerHealth(brokerUrl, healthResult.reason);

  if (!brokerHealth.ok && brokerHealth.error) {
    errors.push(brokerHealth.error);
  }
  if (healthResult.status === "rejected") {
    errors.push(errorMessage(healthResult.reason));
  }

  const home = homeResult.status === "fulfilled" ? homeResult.value : null;
  if (homeResult.status === "rejected") {
    errors.push(errorMessage(homeResult.reason));
  } else if (brokerHealth.reachable && brokerHealth.ok && !home) {
    errors.push("Broker home aggregate unavailable");
  }

  const recentMessages = recentMessagesResult.status === "fulfilled"
    ? recentMessagesResult.value
    : [];
  if (recentMessagesResult.status === "rejected" && brokerHealth.reachable) {
    errors.push(errorMessage(recentMessagesResult.reason));
  }

  return {
    refreshedAt: Date.now(),
    currentDirectory: input.currentDirectory,
    brokerUrl,
    brokerHealth,
    homeUpdatedAt: home?.updatedAt ?? null,
    agents: home?.agents ?? [],
    activity: home?.activity ?? [],
    recentMessages,
    channel,
    errors: [...new Set(errors.filter(Boolean))],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function offlineBrokerHealth(baseUrl: string, error: unknown): ScoutBrokerHealthState {
  return {
    baseUrl,
    reachable: false,
    ok: false,
    checkedAt: Date.now(),
    transport: null,
    socketPath: null,
    socketFallbackError: null,
    nodeId: null,
    meshId: null,
    build: null,
    services: null,
    counts: null,
    error: errorMessage(error),
  };
}
