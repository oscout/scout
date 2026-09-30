import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ScoutOutput } from "../output.ts";

afterEach(() => {
  mock.restore();
});

type WrittenValue = { value: unknown; rendered: string | null };

function makeOutput(written: WrittenValue[]): ScoutOutput {
  return {
    mode: "plain",
    writeText: mock(() => {}),
    writeValue: mock((value: unknown, render?: (value: never) => string) => {
      written.push({
        value,
        rendered: render ? render(value as never) : null,
      });
    }),
  };
}

function makeContext(output: ScoutOutput) {
  return {
    cwd: "/tmp/current",
    env: {},
    stdout: () => {},
    stderr: () => {},
    output,
    isTty: false,
  };
}

const QUEUED_RECEIPT = {
  ok: true,
  state: "queued" as const,
  ids: {
    targetAgentId: "hudson",
    invocationId: "inv-1",
    flightId: "flt-1",
    conversationId: "dm.hudson.me",
    bindingRef: "7f3a9c21",
  },
};

const SENT_MESSAGE = {
  usedBroker: true,
  conversationId: "conv-1",
  messageId: "msg-1",
  invokedTargets: ["hudson"],
  unresolvedTargets: [],
};

function installBrokerMocks(overrides?: {
  waitSnapshot?: unknown;
}) {
  const scoutAskHandler = mock(async (_command: Record<string, unknown>) => QUEUED_RECEIPT);
  const sendScoutMessage = mock(async (_input: Record<string, unknown>) => SENT_MESSAGE);
  const waitForScoutInvocation = mock(
    async (_baseUrl: string, _ref: string, _options: { timeoutSeconds: number }) =>
      overrides?.waitSnapshot ?? {
        invocation: null,
        flight: {
          id: "flt-1",
          invocationId: "inv-1",
          requesterId: "me",
          targetAgentId: "hudson",
          state: "completed",
          output: "the answer",
        },
      },
  );

  mock.module("../../core/broker/ask.ts", () => ({
    scoutAskHandler,
  }));
  mock.module("../../core/broker/service.ts", () => ({
    loadScoutInvocationSnapshot: mock(async () => null),
    parseScoutHarness: (value: string | undefined) => value,
    resolveScoutBrokerUrl: () => "http://127.0.0.1:0",
    resolveScoutSenderId: mock(async () => "me"),
    sendScoutMessage,
    waitForScoutInvocation,
  }));
  mock.module("./ask.ts", () => ({
    formatScoutAskReceiptError: () => "receipt failed",
    loadInitialScoutAskFlight: mock(async () => null),
  }));

  return { scoutAskHandler, sendScoutMessage, waitForScoutInvocation };
}

describe("runSendCommand interaction dispatch", () => {
  test("a plain directed send stays a message (main's FYI contract)", async () => {
    const { scoutAskHandler, sendScoutMessage } = installBrokerMocks();
    const { runSendCommand } = await import("./send.ts");
    const written: WrittenValue[] = [];
    await runSendCommand(makeContext(makeOutput(written)), [
      "--to", "hudson", "branch", "pushed",
    ]);

    expect(scoutAskHandler).not.toHaveBeenCalled();
    expect(sendScoutMessage).toHaveBeenCalledTimes(1);
    const input = sendScoutMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.targetLabel).toBe("hudson");
    expect(input.body).toBe("branch pushed");
  });

  test("a plain send keeps legacy --wake passthrough", async () => {
    const { scoutAskHandler, sendScoutMessage } = installBrokerMocks();
    const { runSendCommand } = await import("./send.ts");
    await runSendCommand(makeContext(makeOutput([])), [
      "--to", "hudson", "--wake", "FYI", "applied",
    ]);

    expect(scoutAskHandler).not.toHaveBeenCalled();
    const input = sendScoutMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.wake).toBe(true);
  });

  test("--tracked is tracked work on the ask lifecycle with a completion callback", async () => {
    const { scoutAskHandler, sendScoutMessage } = installBrokerMocks();
    const { runSendCommand } = await import("./send.ts");
    const written: WrittenValue[] = [];
    await runSendCommand(makeContext(makeOutput(written)), [
      "--tracked", "--to", "hudson", "review", "the", "parser",
    ]);

    expect(sendScoutMessage).not.toHaveBeenCalled();
    expect(scoutAskHandler).toHaveBeenCalledTimes(1);
    const command = scoutAskHandler.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(command.to).toBe("hudson");
    expect(command.body).toBe("review the parser");
    expect(command.replyMode).toBe("notify");
    expect(command.source).toBe("scout-send");
    expect(written[0]?.rendered).toContain("tracked send to hudson");
    expect(written[0]?.rendered).toContain("Completion will be reported back to me");
  });

  test("--tracked --no-notifs keeps the work tracked and suppresses the callback", async () => {
    const { scoutAskHandler } = installBrokerMocks();
    const { runSendCommand } = await import("./send.ts");
    const written: WrittenValue[] = [];
    await runSendCommand(makeContext(makeOutput(written)), [
      "--to", "hudson", "--tracked", "--no-notifs", "run", "the", "sweep",
    ]);

    const command = scoutAskHandler.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(command.replyMode).toBe("none");
    expect(written[0]?.rendered).toContain("Completion notifications suppressed");
    expect(written[0]?.rendered).toContain("scout wait inv-1");
  });

  test("--tracked --wait waits for the result within the bounded budget", async () => {
    const { scoutAskHandler, waitForScoutInvocation } = installBrokerMocks();
    const { runSendCommand } = await import("./send.ts");
    const written: WrittenValue[] = [];
    await runSendCommand(makeContext(makeOutput(written)), [
      "--to", "hudson", "--tracked", "--wait", "--timeout", "300", "current", "blocker?",
    ]);

    const command = scoutAskHandler.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(command.replyMode).toBe("inline");
    expect(waitForScoutInvocation).toHaveBeenCalledTimes(1);
    expect(waitForScoutInvocation.mock.calls[0]?.[1]).toBe("inv-1");
    expect(waitForScoutInvocation.mock.calls[0]?.[2]?.timeoutSeconds).toBe(300);
    expect(written[0]?.rendered).toBe("the answer");
  });

  test("--tracked on message-only routes fails closed and sends nothing", async () => {
    const { scoutAskHandler, sendScoutMessage } = installBrokerMocks();
    const { runSendCommand } = await import("./send.ts");
    for (const args of [
      ["--tracked", "--channel", "triage", "status"],
      ["--tracked", "--ref", "msg-123", "done"],
      ["--tracked", "--to", "requester", "[ask:flt-9]", "the", "answer"],
      ["--tracked", "@hudson", "build", "passed"],
    ]) {
      await expect(
        runSendCommand(makeContext(makeOutput([])), args),
      ).rejects.toThrow(/--tracked needs exactly one directed --to target/);
    }
    expect(scoutAskHandler).not.toHaveBeenCalled();
    expect(sendScoutMessage).not.toHaveBeenCalled();
  });

  test("channel and ref sends stay message-only", async () => {
    const { scoutAskHandler, sendScoutMessage } = installBrokerMocks();
    const { runSendCommand } = await import("./send.ts");
    await runSendCommand(makeContext(makeOutput([])), ["--channel", "triage", "status", "update"]);
    await runSendCommand(makeContext(makeOutput([])), ["--ref", "msg-123", "[ask:flt-9]", "done"]);

    expect(scoutAskHandler).not.toHaveBeenCalled();
    expect(sendScoutMessage).toHaveBeenCalledTimes(2);
    const input = sendScoutMessage.mock.calls[1]?.[0] as Record<string, unknown>;
    expect(input.targetRef).toBe("msg-123");
  });
});

describe("runTellCommand", () => {
  test("tell posts a message even to a directed target", async () => {
    const { scoutAskHandler, sendScoutMessage } = installBrokerMocks();
    const { runTellCommand } = await import("./tell.ts");
    const written: WrittenValue[] = [];
    await runTellCommand(makeContext(makeOutput(written)), [
      "--to", "hudson", "review", "completed",
    ]);

    expect(scoutAskHandler).not.toHaveBeenCalled();
    expect(sendScoutMessage).toHaveBeenCalledTimes(1);
  });
});
