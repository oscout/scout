import { describe, expect, test } from "bun:test";

import type { FlightRecord, InvocationRequest } from "./invocations";
import {
  deriveProjectedAgentRunId,
  projectAgentRunFromInvocation,
  projectAgentRunFromInvocationFlight,
  projectAgentRunState,
} from "./agent-runs";

function makeInvocation(input: Partial<InvocationRequest> = {}): InvocationRequest {
  return {
    id: "inv-1",
    requesterId: "operator",
    requesterNodeId: "node-operator",
    targetAgentId: "agent-1",
    action: "consult",
    task: "Summarize the current state.",
    ensureAwake: true,
    stream: false,
    createdAt: 1_000,
    ...input,
  };
}

function makeFlight(input: Partial<FlightRecord> = {}): FlightRecord {
  return {
    id: "flight-1",
    invocationId: "inv-1",
    requesterId: "operator",
    targetAgentId: "agent-1",
    state: "queued",
    ...input,
  };
}

describe("agent run projection", () => {
  test("derives stable projected run ids from flight or invocation ids", () => {
    expect(deriveProjectedAgentRunId({ invocationId: "inv-1", flightId: "flight-1" }))
      .toBe("run:flight:flight-1");
    expect(deriveProjectedAgentRunId({ invocationId: "inv-1" }))
      .toBe("run:invocation:inv-1");
  });

  test("maps flight states conservatively", () => {
    expect(projectAgentRunState("queued")).toBe("queued");
    expect(projectAgentRunState("waking")).toBe("waking");
    expect(projectAgentRunState("running")).toBe("running");
    expect(projectAgentRunState("waiting")).toBe("waiting");
    expect(projectAgentRunState("completed")).toBe("completed");
    expect(projectAgentRunState("failed")).toBe("failed");
    expect(projectAgentRunState("cancelled")).toBe("cancelled");
    expect(projectAgentRunState("mystery")).toBe("unknown");
    expect(projectAgentRunState(undefined)).toBe("unknown");
  });

  test("moves completed runs into review when review is needed", () => {
    const run = projectAgentRunFromInvocationFlight({
      invocation: makeInvocation(),
      flight: makeFlight({
        state: "completed",
        output: "Done.",
        completedAt: 2_000,
      }),
      reviewTaskIds: ["review-1"],
    });

    expect(run.state).toBe("review");
    expect(run.reviewState).toBe("needed");
    expect(run.reviewTaskIds).toEqual(["review-1"]);
    expect(run.output).toMatchObject({ text: "Done." });

    const failed = projectAgentRunFromInvocationFlight({
      invocation: makeInvocation(),
      flight: makeFlight({
        state: "failed",
        error: "Harness exited",
        completedAt: 2_000,
      }),
      reviewTaskIds: ["review-1"],
    });

    expect(failed.state).toBe("failed");
    expect(failed.terminalReason).toBe("Harness exited");
  });

  test("projects source and collaboration metadata into run references", () => {
    const run = projectAgentRunFromInvocationFlight({
      invocation: makeInvocation({
        collaborationRecordId: "work-1",
        conversationId: "conv-1",
        messageId: "msg-1",
        context: {
          collaboration: {
            recordId: "work-1",
            kind: "work_item",
          },
        },
        metadata: {
          source: "collaboration-record",
          artifactIds: ["artifact-1", "artifact-1"],
          traceSessionIds: "trace-1",
        },
      }),
      flight: makeFlight({
        state: "completed",
        summary: "Implemented the slice.",
        completedAt: 2_000,
      }),
    });

    expect(run).toMatchObject({
      id: "run:flight:flight-1",
      source: "ask",
      requesterId: "operator",
      agentId: "agent-1",
      workId: "work-1",
      collaborationRecordId: "work-1",
      conversationId: "conv-1",
      messageId: "msg-1",
      invocationId: "inv-1",
      flightIds: ["flight-1"],
      artifactIds: ["artifact-1"],
      traceSessionIds: ["trace-1"],
      createdAt: 1_000,
      updatedAt: 2_000,
    });
    expect(run.input).toMatchObject({
      action: "consult",
      task: "Summarize the current state.",
      metadata: {
        source: "collaboration-record",
      },
    });
    expect(run.output).toMatchObject({ summary: "Implemented the slice." });
  });

  test("does not promote non-work collaboration ids to work ids", () => {
    const run = projectAgentRunFromInvocationFlight({
      invocation: makeInvocation({
        collaborationRecordId: "question-1",
        context: {
          collaboration: {
            recordId: "question-1",
            kind: "question",
          },
        },
      }),
      flight: makeFlight(),
    });

    expect(run.collaborationRecordId).toBe("question-1");
    expect(run.workId).toBeUndefined();
  });

  test("honors explicit run source metadata over message inference", () => {
    const run = projectAgentRunFromInvocationFlight({
      invocation: makeInvocation({
        conversationId: "conv-1",
        messageId: "msg-1",
        metadata: {
          runSource: "external_issue",
          source: "scout-cli",
        },
      }),
      flight: makeFlight({ state: "running", startedAt: 1_500 }),
      now: 1_750,
    });

    expect(run.source).toBe("external_issue");
    expect(run.state).toBe("running");
    expect(run.updatedAt).toBe(1_750);
  });

  test("propagates permission profile and revision snapshot posture", () => {
    const run = projectAgentRunFromInvocationFlight({
      invocation: makeInvocation({
        execution: {
          harness: "codex",
          permissionProfile: "workspace_write",
          session: "new",
        },
      }),
      flight: makeFlight({ state: "waiting", startedAt: 1_200 }),
      agentRevisionSnapshot: {
        id: "rev-1",
        agentId: "agent-1",
        runtime: {
          harness: "claude",
          model: "claude-sonnet-test",
        },
        permissions: {
          permissionProfile: "trusted-local",
        },
      },
    });

    expect(run.agentRevisionId).toBe("rev-1");
    expect(run.agentRevisionSnapshot?.id).toBe("rev-1");
    expect(run.metadata?.agentRevisionSnapshot).toMatchObject({ id: "rev-1" });
    expect(run.harness).toBe("codex");
    expect(run.model).toBe("claude-sonnet-test");
    expect(run.permissionProfile).toBe("workspace_write");
  });

  test("projects invocation-only records without pretending a flight exists", () => {
    const run = projectAgentRunFromInvocationFlight({
      invocation: makeInvocation({
        id: "inv-missing-flight",
        metadata: {
          permissionProfile: "trusted-local",
          reviewNeeded: true,
        },
      }),
      now: 1_250,
    });

    expect(run.id).toBe("run:invocation:inv-missing-flight");
    expect(run.state).toBe("unknown");
    expect(run.reviewState).toBe("needed");
    expect(run.updatedAt).toBe(1_250);
    expect(run.permissionProfile).toBe("trusted_local");
    expect(run.flightIds).toBeUndefined();
    expect(run.output).toBeUndefined();
  });

  test("projectAgentRunFromInvocation matches the flight-based projector on a merged record", () => {
    const invocation = makeInvocation();
    const flight = makeFlight({
      state: "completed",
      summary: "Implemented the slice.",
      output: "Done.",
      startedAt: 1_500,
      completedAt: 2_000,
    });

    const viaFlight = projectAgentRunFromInvocationFlight({ invocation, flight });
    const viaMerged = projectAgentRunFromInvocation({
      invocation: {
        ...invocation,
        flightId: flight.id,
        state: flight.state,
        summary: flight.summary,
        output: flight.output,
        startedAt: flight.startedAt,
        completedAt: flight.completedAt,
      },
    });

    // The merged projector must reproduce the flight-based projection exactly,
    // including the stable projected run id and flight id alias.
    expect(viaMerged).toEqual(viaFlight);
    expect(viaMerged.id).toBe("run:flight:flight-1");
    expect(viaMerged.flightIds).toEqual(["flight-1"]);
    expect(viaMerged.state).toBe("completed");
    expect(viaMerged.output).toMatchObject({ summary: "Implemented the slice.", text: "Done." });
  });

  test("projectAgentRunFromInvocation projects an invocation-only record without a flight", () => {
    const run = projectAgentRunFromInvocation({
      invocation: makeInvocation({ id: "inv-no-flight", metadata: { reviewNeeded: true } }),
      now: 1_250,
    });

    expect(run.id).toBe("run:invocation:inv-no-flight");
    expect(run.state).toBe("unknown");
    expect(run.reviewState).toBe("needed");
    expect(run.flightIds).toBeUndefined();
    expect(run.output).toBeUndefined();
  });
});
