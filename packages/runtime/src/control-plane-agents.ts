import { normalizeAgentSelectorSegment } from "@openscout/protocol";
import type { AgentHarness, ScoutAgentCard, ScoutPermissionProfile } from "@openscout/protocol";
import { basename } from "node:path";

import {
  collectOccupiedDefinitionIds,
  resolveProvisionalAgentName,
} from "./provisional-agent-names.js";

import {
  inferLocalAgentBinding,
  listLocalAgents,
  pruneOneTimeLocalAgentCards,
  retireLocalAgent,
  updateLocalAgentCardLifecycle,
  restartAllLocalAgents,
  restartLocalAgent,
  startLocalAgent,
  stopAllLocalAgents,
  stopLocalAgent,
  updateLocalAgentCard,
  type LocalAgentBinding,
  type LocalAgentConfigState,
  type ScoutLocalAgentStatus,
  type UpdateLocalAgentCardInput,
} from "./local-agents.js";
import { buildScoutAgentCard } from "./scout-agent-cards.js";

export type ScoutAgentStatus = ScoutLocalAgentStatus;

export type CreateScoutAgentCardInput = {
  projectPath: string;
  agentName?: string;
  displayName?: string;
  harness?: AgentHarness;
  model?: string;
  provider?: string;
  reasoningEffort?: string;
  permissionProfile?: ScoutPermissionProfile | string;
  currentDirectory?: string;
  createdById?: string;
  oneTimeUse?: boolean;
  ttlMs?: number;
};

export type CleanupScoutAgentCardsInput = {
  currentDirectory?: string;
  createdById?: string;
  projectRoot?: string;
  maxAgeMs?: number;
  maxCount?: number;
};

export type UpScoutAgentInput = {
  projectPath: string;
  agentName?: string;
  harness?: AgentHarness;
  currentDirectory?: string;
  cwdOverride?: string;
  model?: string;
  provider?: string;
  reasoningEffort?: string;
  permissionProfile?: ScoutPermissionProfile | string;
  branch?: string;
};

export type UpdateScoutAgentCardInput = UpdateLocalAgentCardInput & {
  restart?: boolean;
};

export type ScoutAgentServiceBrokerContext = {
  node: {
    id: string;
  };
  snapshot?: {
    agents: Record<string, {
      id: string;
      definitionId?: string;
      handle?: string;
    }>;
  };
};

export type ScoutLocalAgentBindingSyncResult = {
  binding: LocalAgentBinding;
  brokerRegistered: boolean;
};

export type ScoutPeerSessionResult = {
  sourceId: string;
  conversation: {
    id: string;
  };
};

export type ScoutAgentServiceDeps<TBroker extends ScoutAgentServiceBrokerContext> = {
  loadScoutBrokerContext: () => Promise<TBroker | null>;
  registerScoutLocalAgentBinding: (input: {
    agentId: string;
    broker?: TBroker | null;
  }) => Promise<ScoutLocalAgentBindingSyncResult | null>;
  retireScoutLocalAgentBinding?: (input: {
    agentId: string;
    broker?: TBroker | null;
  }) => Promise<boolean>;
  openScoutPeerSession: (input: {
    sourceId: string;
    targetId: string;
    currentDirectory?: string;
  }) => Promise<ScoutPeerSessionResult>;
  localAgents?: {
    listLocalAgents?: typeof listLocalAgents;
    retireLocalAgent?: typeof retireLocalAgent;
    restartAllLocalAgents?: typeof restartAllLocalAgents;
    restartLocalAgent?: typeof restartLocalAgent;
    startLocalAgent?: typeof startLocalAgent;
    stopAllLocalAgents?: typeof stopAllLocalAgents;
    stopLocalAgent?: typeof stopLocalAgent;
    updateLocalAgentCard?: typeof updateLocalAgentCard;
    updateLocalAgentCardLifecycle?: typeof updateLocalAgentCardLifecycle;
    pruneOneTimeLocalAgentCards?: typeof pruneOneTimeLocalAgentCards;
    inferLocalAgentBinding?: typeof inferLocalAgentBinding;
  };
};

const DEFAULT_ONE_TIME_SCOUT_AGENT_CARD_TTL_MS = 24 * 60 * 60 * 1000;

async function resolveOneTimeAgentName<TBroker extends ScoutAgentServiceBrokerContext>(
  deps: ScoutAgentServiceDeps<TBroker>,
  input: {
    agentName?: string;
    projectPath: string;
    currentDirectory?: string;
    createdById?: string;
  },
): Promise<string> {
  if (input.agentName?.trim()) {
    return resolveProvisionalAgentName({
      explicitName: input.agentName,
      occupied: new Set<string>(),
    });
  }

  const references: string[] = [];
  const broker = await deps.loadScoutBrokerContext().catch(() => null);
  if (broker?.snapshot) {
    for (const agent of Object.values(broker.snapshot.agents)) {
      references.push(agent.id);
      if (agent.definitionId) references.push(agent.definitionId);
      if (agent.handle) references.push(agent.handle);
    }
  }
  const localStatuses = await (deps.localAgents?.listLocalAgents ?? listLocalAgents)({
    currentDirectory: input.currentDirectory ?? input.projectPath,
  }).catch(() => []);
  for (const status of localStatuses) {
    references.push(status.agentId);
  }
  const occupied = collectOccupiedDefinitionIds(references);
  return resolveProvisionalAgentName({
    occupied,
    seedParts: [
      "one-time-agent-card",
      input.createdById,
      input.projectPath,
      input.currentDirectory ?? input.projectPath,
      localStatuses.length,
    ],
  });
}

export function createScoutAgentService<TBroker extends ScoutAgentServiceBrokerContext>(
  deps: ScoutAgentServiceDeps<TBroker>,
) {
  const localAgents = {
    listLocalAgents: deps.localAgents?.listLocalAgents ?? listLocalAgents,
    retireLocalAgent: deps.localAgents?.retireLocalAgent ?? retireLocalAgent,
    restartAllLocalAgents: deps.localAgents?.restartAllLocalAgents ?? restartAllLocalAgents,
    restartLocalAgent: deps.localAgents?.restartLocalAgent ?? restartLocalAgent,
    startLocalAgent: deps.localAgents?.startLocalAgent ?? startLocalAgent,
    stopAllLocalAgents: deps.localAgents?.stopAllLocalAgents ?? stopAllLocalAgents,
    stopLocalAgent: deps.localAgents?.stopLocalAgent ?? stopLocalAgent,
    updateLocalAgentCard: deps.localAgents?.updateLocalAgentCard ?? updateLocalAgentCard,
    updateLocalAgentCardLifecycle: deps.localAgents?.updateLocalAgentCardLifecycle ?? updateLocalAgentCardLifecycle,
    pruneOneTimeLocalAgentCards: deps.localAgents?.pruneOneTimeLocalAgentCards ?? pruneOneTimeLocalAgentCards,
    inferLocalAgentBinding: deps.localAgents?.inferLocalAgentBinding ?? inferLocalAgentBinding,
  };

  return {
    async loadScoutAgentStatuses(input: {
      currentDirectory?: string;
    } = {}): Promise<ScoutAgentStatus[]> {
      return localAgents.listLocalAgents({
        currentDirectory: input.currentDirectory,
      });
    },

    async upScoutAgent(input: UpScoutAgentInput): Promise<ScoutAgentStatus> {
      const status = await localAgents.startLocalAgent(input);
      // Synchronously register the endpoint with the broker so the agent is
      // immediately routable without waiting on the broker's background sync.
      await deps.registerScoutLocalAgentBinding({ agentId: status.agentId }).catch(() => {});
      return status;
    },

    async downScoutAgent(agentId: string): Promise<ScoutAgentStatus | null> {
      return localAgents.stopLocalAgent(agentId);
    },

    async retireScoutAgentCard(agentId: string): Promise<ScoutAgentStatus | null> {
      const broker = await deps.loadScoutBrokerContext().catch(() => null);
      const retired = await localAgents.retireLocalAgent(agentId);
      if (retired) {
        await deps.retireScoutLocalAgentBinding?.({ agentId, broker }).catch(() => false);
      }
      return retired;
    },

    async updateScoutAgentCard(
      agentId: string,
      input: UpdateScoutAgentCardInput,
    ): Promise<LocalAgentConfigState | null> {
      const config = await localAgents.updateLocalAgentCard(agentId, input);
      if (!config) {
        return null;
      }
      if (input.restart === true) {
        await localAgents.restartLocalAgent(agentId);
      }
      await deps.registerScoutLocalAgentBinding({ agentId }).catch(() => {});
      return config;
    },

    async downAllScoutAgents(input: {
      currentDirectory?: string;
    } = {}): Promise<ScoutAgentStatus[]> {
      return localAgents.stopAllLocalAgents(input);
    },

    async restartScoutAgents(input: {
      currentDirectory?: string;
    } = {}): Promise<ScoutAgentStatus[]> {
      return localAgents.restartAllLocalAgents(input);
    },

    async cleanupScoutAgentCards(input: CleanupScoutAgentCardsInput = {}) {
      const broker = await deps.loadScoutBrokerContext().catch(() => null);
      const result = await localAgents.pruneOneTimeLocalAgentCards(input);
      await Promise.all(result.retired.map((status) =>
        deps.retireScoutLocalAgentBinding?.({ agentId: status.agentId, broker }).catch(() => false),
      ));
      return result;
    },

    async createScoutAgentCard(input: CreateScoutAgentCardInput): Promise<ScoutAgentCard> {
      const createdAt = Date.now();
      const oneTimeUse = input.oneTimeUse === true;
      const createdById = input.createdById?.trim() || undefined;
      const agentName = oneTimeUse
        ? await resolveOneTimeAgentName(deps, {
          agentName: input.agentName,
          projectPath: input.projectPath,
          currentDirectory: input.currentDirectory,
          createdById: input.createdById,
        })
        : input.agentName;
      const lifecycle = oneTimeUse
        ? {
          kind: "one_time" as const,
          createdAt,
          ...(createdById ? { createdById } : {}),
          expiresAt: createdAt + Math.max(1, input.ttlMs ?? DEFAULT_ONE_TIME_SCOUT_AGENT_CARD_TTL_MS),
          maxUses: 1,
        }
        : undefined;
      const status = await localAgents.startLocalAgent({
        projectPath: input.projectPath,
        agentName,
        displayName: input.displayName,
        harness: input.harness,
        model: input.model,
        provider: input.provider,
        reasoningEffort: input.reasoningEffort,
        permissionProfile: input.permissionProfile,
        currentDirectory: input.currentDirectory,
        ...(lifecycle ? { card: lifecycle } : {}),
        // Card creation should publish a routable identity, not make this
        // short-lived caller the owner of a long-running harness session.
        ensureOnline: false,
      });
      const currentDirectory = input.currentDirectory ?? input.projectPath;
      const broker = await deps.loadScoutBrokerContext();
      const syncResult = await deps.registerScoutLocalAgentBinding({
        agentId: status.agentId,
        broker,
      });

      const binding = syncResult?.binding
        ?? await localAgents.inferLocalAgentBinding(
          status.agentId,
          broker?.node.id ?? process.env.OPENSCOUT_NODE_ID ?? "local",
        );
      if (!binding) {
        throw new Error(`Agent ${status.agentId} did not expose an addressable binding.`);
      }

      let inboxConversationId: string | undefined;
      let resolvedCreatedById = createdById;
      if (broker && resolvedCreatedById && resolvedCreatedById !== binding.agent.id) {
        const session = await deps.openScoutPeerSession({
          sourceId: resolvedCreatedById,
          targetId: binding.agent.id,
          currentDirectory,
        });
        inboxConversationId = session.conversation.id;
        resolvedCreatedById = session.sourceId;
      }

      const finalLifecycle = lifecycle
        ? {
          ...lifecycle,
          ...(resolvedCreatedById ? { createdById: resolvedCreatedById } : {}),
          ...(inboxConversationId ? { inboxConversationId } : {}),
        }
        : undefined;
      if (finalLifecycle) {
        await localAgents.updateLocalAgentCardLifecycle(status.agentId, finalLifecycle).catch(() => null);
        const cleaned = await localAgents.pruneOneTimeLocalAgentCards({
          createdById: finalLifecycle.createdById,
          projectRoot: binding.endpoint.projectRoot ?? input.projectPath,
          excludeAgentIds: [status.agentId],
        }).catch(() => null);
        if (cleaned?.retired.length) {
          await Promise.all(cleaned.retired.map((retired) =>
            deps.retireScoutLocalAgentBinding?.({ agentId: retired.agentId, broker }).catch(() => false),
          ));
        }
      }

      return buildScoutAgentCard(binding, {
        currentDirectory,
        createdById: resolvedCreatedById,
        brokerRegistered: syncResult?.brokerRegistered ?? false,
        inboxConversationId,
        lifecycle: finalLifecycle,
      });
    },
  };
}
