import { describe, expect, test } from "bun:test";

import {
  CONVERSATION_WORKING_TURN_ACTIVE_WINDOW_MS,
  isActiveConversationFlight,
  isConversationWorkingTurnWithoutRecentUpdate,
  isConversationWorkingTurnWithoutRecentUpdateAnswered,
  isChannelConversation,
  isGroupConversation,
  isObservedDirect,
  isOperatorDm,
  isOperatorParticipant,
  shouldClearConversationWorkingStateForAgentMessage,
  shouldShowConversationWorkingTurn,
} from "./conversations.ts";
import type { SessionEntry } from "./types.ts";

describe("conversation flight presence", () => {
  test("keeps acknowledged running asks in the working state", () => {
    const runningFlight = { state: "running" };

    expect(isActiveConversationFlight(runningFlight)).toBe(true);
    expect(shouldShowConversationWorkingTurn(runningFlight)).toBe(true);
    expect(
      shouldClearConversationWorkingStateForAgentMessage(runningFlight),
    ).toBe(false);
  });

  test("does not show requester wait timeouts as conversation working turns", () => {
    const timeoutFlight = {
      state: "waiting",
      summary: "Review Run2 is still working; Scout stopped waiting for a synchronous result after 300000ms.",
    };

    expect(isActiveConversationFlight(timeoutFlight)).toBe(true);
    expect(shouldShowConversationWorkingTurn(timeoutFlight)).toBe(false);
  });

  test("clears working state after terminal flights", () => {
    for (const state of ["completed", "failed", "cancelled"]) {
      const terminalFlight = { state };

      expect(isActiveConversationFlight(terminalFlight)).toBe(false);
      expect(shouldShowConversationWorkingTurn(terminalFlight)).toBe(false);
      expect(
        shouldClearConversationWorkingStateForAgentMessage(terminalFlight),
      ).toBe(true);
    }
  });

  test("allows an agent message to resolve pending state before a flight exists", () => {
    expect(shouldClearConversationWorkingStateForAgentMessage(null)).toBe(true);
  });

  test("marks unresolved working turns as having no recent update after the active window", () => {
    const nowMs = 2_000_000_000_000;
    const freshFlight = {
      state: "running",
      startedAt: nowMs - CONVERSATION_WORKING_TURN_ACTIVE_WINDOW_MS,
    };
    const quietFlight = {
      state: "running",
      startedAt: nowMs - CONVERSATION_WORKING_TURN_ACTIVE_WINDOW_MS - 1,
    };

    expect(isConversationWorkingTurnWithoutRecentUpdate(freshFlight, nowMs)).toBe(false);
    expect(isConversationWorkingTurnWithoutRecentUpdate(quietFlight, nowMs)).toBe(true);
  });

  test("does not mark terminal flights as having no recent update", () => {
    const flight = {
      state: "completed",
      startedAt: 1,
    };

    expect(isConversationWorkingTurnWithoutRecentUpdate(flight, 1_000_000)).toBe(false);
  });

  test("does not mark queued-until-online flights as no recent update", () => {
    const nowMs = 2_000_000_000_000;
    const flight = {
      state: "queued",
      startedAt: nowMs - CONVERSATION_WORKING_TURN_ACTIVE_WINDOW_MS - 1,
      dispatchOutcome: {
        status: "queued_until_online",
        reason: "no_runnable_endpoint",
        checkedAt: nowMs - CONVERSATION_WORKING_TURN_ACTIVE_WINDOW_MS - 1,
      },
    };

    expect(shouldShowConversationWorkingTurn(flight)).toBe(true);
    expect(isConversationWorkingTurnWithoutRecentUpdate(flight, nowMs)).toBe(false);
  });

  test("treats a no-recent-update working turn as answered after a newer agent reply", () => {
    const nowMs = 2_000_000_000_000;
    const flight = {
      state: "running",
      startedAt: nowMs - CONVERSATION_WORKING_TURN_ACTIVE_WINDOW_MS - 1,
    };

    expect(
      isConversationWorkingTurnWithoutRecentUpdateAnswered(
        flight,
        flight.startedAt - 1,
        nowMs,
      ),
    ).toBe(false);
    expect(
      isConversationWorkingTurnWithoutRecentUpdateAnswered(
        flight,
        flight.startedAt + 1,
        nowMs,
      ),
    ).toBe(true);
  });
});

function session(partial: Partial<SessionEntry> & Pick<SessionEntry, "id" | "kind">): SessionEntry {
  return {
    title: partial.title ?? partial.id,
    participantIds: partial.participantIds ?? [],
    agentId: partial.agentId ?? null,
    agentName: partial.agentName ?? null,
    harness: partial.harness ?? null,
    harnessSessionId: partial.harnessSessionId ?? null,
    harnessLogPath: partial.harnessLogPath ?? null,
    currentBranch: partial.currentBranch ?? null,
    preview: partial.preview ?? null,
    messageCount: partial.messageCount ?? 0,
    lastMessageAt: partial.lastMessageAt ?? null,
    workspaceRoot: partial.workspaceRoot ?? null,
    ...partial,
  };
}

describe("conversation membership helpers", () => {
  test("named channels are channels, not DMs or observed", () => {
    const channel = session({
      id: "composer-kit",
      kind: "channel",
      participantIds: ["operator", "openscout.kimi"],
    });
    expect(isChannelConversation(channel)).toBe(true);
    expect(isGroupConversation(channel)).toBe(true);
    expect(isOperatorDm(channel)).toBe(false);
    expect(isObservedDirect(channel)).toBe(false);
  });

  test("operator participant ids mark real DMs", () => {
    const dm = session({
      id: "dm-1",
      kind: "direct",
      participantIds: ["operator", "openscout.claude"],
      agentId: "openscout.claude",
      agentName: "Openscout",
    });
    expect(isOperatorParticipant(dm)).toBe(true);
    expect(isOperatorDm(dm)).toBe(true);
    expect(isObservedDirect(dm)).toBe(false);
  });

  test("group_direct with operator is a DM, not a channel", () => {
    const groupDm = session({
      id: "gdm-1",
      kind: "group_direct",
      participantIds: ["operator", "agent-a", "agent-b"],
    });
    expect(isChannelConversation(groupDm)).toBe(false);
    expect(isOperatorDm(groupDm)).toBe(true);
    expect(isObservedDirect(groupDm)).toBe(false);
  });

  test("group_direct without operator is observed", () => {
    const groupObs = session({
      id: "gobs-1",
      kind: "group_direct",
      participantIds: ["agent-a", "agent-b"],
      participants: [
        { actorId: "agent-a", kind: "agent", displayName: "A", label: "A" },
        { actorId: "agent-b", kind: "agent", displayName: "B", label: "B" },
      ],
    });
    expect(isChannelConversation(groupObs)).toBe(false);
    expect(isOperatorDm(groupObs)).toBe(false);
    expect(isObservedDirect(groupObs)).toBe(true);
  });

  test("person/operator participant rows also count as operator presence", () => {
    const dm = session({
      id: "dm-2",
      kind: "direct",
      participantIds: ["session-abc"],
      participants: [
        { actorId: "operator", kind: "person", displayName: "You", label: "You" },
        { actorId: "session-abc", kind: "session", displayName: "Session", label: "Session" },
      ],
    });
    expect(isOperatorParticipant(dm)).toBe(true);
    expect(isOperatorDm(dm)).toBe(true);
  });

  test("agent-to-agent directs without operator are observed", () => {
    const observed = session({
      id: "obs-1",
      kind: "direct",
      title: "Openscout Pr 423",
      participantIds: ["agent-a", "agent-b"],
      participants: [
        { actorId: "agent-a", kind: "agent", displayName: "A", label: "A" },
        { actorId: "agent-b", kind: "agent", displayName: "B", label: "B" },
      ],
      agentId: "agent-a",
      agentName: "Openscout Pr 423",
    });
    expect(isOperatorParticipant(observed)).toBe(false);
    expect(isOperatorDm(observed)).toBe(false);
    expect(isObservedDirect(observed)).toBe(true);
  });
});
