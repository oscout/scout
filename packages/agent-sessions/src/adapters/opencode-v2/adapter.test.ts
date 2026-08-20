import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import type { AgentSessionStreamEvent } from "../../protocol/primitives.js";
import {
  OpenCodeV2Adapter,
  OPENCODE_V2_CLIENT_VERSION,
  type OpenCodeV2Dependencies,
} from "./adapter.js";
import type {
  DiscoverOptions,
  Endpoint,
  EnsureOptions,
  OpenCodeClient,
  OpenCodeEvent,
  SessionPendingInfo,
} from "./upstream.js";

type SessionInfo = Awaited<ReturnType<OpenCodeClient["session"]["get"]>>;
type SessionCreateInput = Parameters<OpenCodeClient["session"]["create"]>[0];
type SessionGetInput = Parameters<OpenCodeClient["session"]["get"]>[0];
type SessionPromptInput = Parameters<OpenCodeClient["session"]["prompt"]>[0];
type SessionInterruptInput = Parameters<OpenCodeClient["session"]["interrupt"]>[0];
type RequestOptions = Parameters<OpenCodeClient["session"]["interrupt"]>[1];
type PermissionReplyInput = Parameters<OpenCodeClient["permission"]["reply"]>[0];
type QuestionReplyInput = Parameters<OpenCodeClient["question"]["reply"]>[0];
type ClientOptions = Parameters<OpenCodeV2Dependencies["makeClient"]>[0];

const activeAdapters = new Set<OpenCodeV2Adapter>();

afterEach(async () => {
  await Promise.all([...activeAdapters].map((adapter) => adapter.shutdown()));
  activeAdapters.clear();
});

function sessionInfo(id: string, directory: string): SessionInfo {
  return {
    id,
    projectID: "project-1",
    agent: "build",
    model: { providerID: "anthropic", id: "claude-sonnet", variant: "high" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1_754_000_000_000, updated: 1_754_000_000_000 },
    title: "Native OpenCode session",
    location: { directory },
  };
}

const SERVER_CONNECTED = {
  id: "evt-server-connected",
  type: "server.connected",
  data: {},
} satisfies OpenCodeEvent;

function executionSucceeded(id: string, sessionID: string): OpenCodeEvent {
  return {
    id,
    created: 1_754_000_000_100,
    type: "session.execution.succeeded",
    durable: { aggregateID: sessionID, seq: 1, version: 1 },
    data: { sessionID },
  } satisfies OpenCodeEvent;
}

function executionFailed(id: string, sessionID: string, message: string): OpenCodeEvent {
  return {
    id,
    created: 1_754_000_000_100,
    type: "session.execution.failed",
    durable: { aggregateID: sessionID, seq: 1, version: 1 },
    data: { sessionID, error: { type: "FixtureError", message } },
  } satisfies OpenCodeEvent;
}

function executionInterrupted(id: string, sessionID: string): OpenCodeEvent {
  return {
    id,
    created: 1_754_000_000_100,
    type: "session.execution.interrupted",
    durable: { aggregateID: sessionID, seq: 1, version: 1 },
    data: { sessionID, reason: "user" },
  } satisfies OpenCodeEvent;
}

function inputAdmitted(id: string, sessionID: string, inputID: string): OpenCodeEvent {
  return {
    id,
    created: 1_754_000_000_050,
    type: "session.input.admitted",
    durable: { aggregateID: sessionID, seq: 1, version: 1 },
    data: {
      sessionID,
      inputID,
      input: {
        type: "user",
        data: { text: "fixture" },
        delivery: "queue",
      },
    },
  } satisfies OpenCodeEvent;
}

function inputPromoted(id: string, sessionID: string, inputID: string): OpenCodeEvent {
  return {
    id,
    created: 1_754_000_000_075,
    type: "session.input.promoted",
    durable: { aggregateID: sessionID, seq: 2, version: 1 },
    data: { sessionID, inputID },
  } satisfies OpenCodeEvent;
}

function inputCancelled(id: string, sessionID: string, inputID: string): OpenCodeEvent {
  return {
    id,
    created: 1_754_000_000_080,
    type: "session.input.cancelled",
    durable: { aggregateID: sessionID, seq: 3, version: 1 },
    data: { sessionID, inputID },
  } satisfies OpenCodeEvent;
}

function textDelta(id: string, sessionID: string, delta: string): OpenCodeEvent {
  return {
    id,
    created: 1_754_000_000_090,
    type: "session.text.delta",
    data: {
      sessionID,
      assistantMessageID: "msg-assistant",
      ordinal: 0,
      delta,
    },
  } satisfies OpenCodeEvent;
}

class EventFeed {
  readonly queue: OpenCodeEvent[] = [];
  readonly waiters = new Set<() => void>();
  subscriptions = 0;
  closedSubscriptions = 0;
  ended = false;

  push(event: OpenCodeEvent): void {
    this.queue.push(event);
    for (const wake of [...this.waiters]) wake();
  }

  close(): void {
    this.ended = true;
    for (const wake of [...this.waiters]) wake();
  }

  async *subscribe(signal?: AbortSignal): AsyncIterable<OpenCodeEvent> {
    this.subscriptions += 1;
    try {
      while (!signal?.aborted) {
        const event = this.queue.shift();
        if (event) {
          yield event;
          continue;
        }
        if (this.ended) return;
        await new Promise<void>((resolvePromise) => {
          const wake = () => {
            this.waiters.delete(wake);
            signal?.removeEventListener("abort", wake);
            resolvePromise();
          };
          this.waiters.add(wake);
          signal?.addEventListener("abort", wake, { once: true });
        });
      }
    } finally {
      this.closedSubscriptions += 1;
    }
  }
}

function createFakeClient(nativeSession: SessionInfo) {
  const feed = new EventFeed();
  const createCalls: SessionCreateInput[] = [];
  const getCalls: SessionGetInput[] = [];
  const promptCalls: SessionPromptInput[] = [];
  const interruptCalls: Array<{ input: SessionInterruptInput; options: RequestOptions }> = [];
  const waitCalls: unknown[] = [];
  const pendingCancelCalls: unknown[] = [];
  const permissionReplyCalls: PermissionReplyInput[] = [];
  const questionReplyCalls: QuestionReplyInput[] = [];
  const activeSessions: Record<string, { type: "running" }> = {};
  const pendingInputs: SessionPendingInfo[] = [];

  const client = {
    health: {
      get: async () => ({ healthy: true as const, version: OPENCODE_V2_CLIENT_VERSION, pid: 4242 }),
    },
    session: {
      active: async () => ({ ...activeSessions }),
      create: async (input?: SessionCreateInput) => {
        createCalls.push(input);
        return nativeSession;
      },
      get: async (input: SessionGetInput) => {
        getCalls.push(input);
        return nativeSession;
      },
      prompt: async (input: SessionPromptInput) => {
        promptCalls.push(input);
        return {
          id: input.id!,
          sessionID: nativeSession.id,
          timeCreated: 1_754_000_000_000,
          type: "user" as const,
          data: {
            text: input.text,
            ...(input.files ? { files: [...input.files] } : {}),
          },
          delivery: input.delivery ?? "steer",
        };
      },
      interrupt: async (input: SessionInterruptInput, options?: RequestOptions) => {
        interruptCalls.push({ input, options });
      },
      wait: async (input: unknown) => {
        waitCalls.push(input);
      },
      pending: {
        list: async () => [...pendingInputs],
        cancel: async (input: unknown) => {
          pendingCancelCalls.push(input);
          if (input && typeof input === "object" && "inputID" in input) {
            const index = pendingInputs.findIndex((pending) => pending.id === input.inputID);
            if (index >= 0) pendingInputs.splice(index, 1);
          }
        },
      },
    },
    event: {
      subscribe: (options?: { signal?: AbortSignal }) => feed.subscribe(options?.signal),
    },
    permission: {
      reply: async (input: PermissionReplyInput) => {
        permissionReplyCalls.push(input);
      },
    },
    question: {
      reply: async (input: QuestionReplyInput) => {
        questionReplyCalls.push(input);
      },
    },
  } as unknown as OpenCodeClient;

  return {
    client,
    feed,
    createCalls,
    getCalls,
    promptCalls,
    interruptCalls,
    waitCalls,
    pendingCancelCalls,
    permissionReplyCalls,
    questionReplyCalls,
    activeSessions,
    pendingInputs,
  };
}

function createFakeService(options: {
  discovered?: Endpoint;
  ensured?: Endpoint;
  authorization?: string;
} = {}) {
  const discoverCalls: Array<DiscoverOptions | undefined> = [];
  const ensureCalls: EnsureOptions[] = [];
  const headerCalls: Endpoint[] = [];
  const stopCalls: unknown[] = [];
  const ensured = options.ensured ?? { url: "http://127.0.0.1:4096" };

  const service = {
    discover: async (input?: DiscoverOptions) => {
      discoverCalls.push(input);
      return options.discovered;
    },
    ensure: async (input?: EnsureOptions) => {
      ensureCalls.push(input ?? {});
      return ensured;
    },
    headers: (endpoint: Endpoint) => {
      headerCalls.push(endpoint);
      return options.authorization ? { authorization: options.authorization } : undefined;
    },
    // The production dependency surface intentionally omits stop. Keeping a
    // sentinel here proves adapter shutdown does not reach for the shared
    // service's real stop operation.
    stop: async (...args: unknown[]) => {
      stopCalls.push(args);
    },
  };

  return { service, discoverCalls, ensureCalls, headerCalls, stopCalls };
}

function injectedDependencies(
  client: OpenCodeClient,
  service: OpenCodeV2Dependencies["service"],
) {
  const makeClientCalls: ClientOptions[] = [];
  let nextId = 0;
  const dependencies: OpenCodeV2Dependencies = {
    service,
    makeClient: (options) => {
      makeClientCalls.push(options);
      return client;
    },
    delay: async () => undefined,
    now: () => "2026-08-11T12:00:00.000Z",
    nextId: () => `generated-${++nextId}`,
  };
  return { dependencies, makeClientCalls };
}

function collectEvents(adapter: OpenCodeV2Adapter) {
  const events: AgentSessionStreamEvent[] = [];
  const errors: Error[] = [];
  adapter.on("event", (event) => events.push(event));
  adapter.on("error", (error) => errors.push(error));
  return { events, errors };
}

async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}.`);
    await Bun.sleep(1);
  }
}

async function resolveWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
  description: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${description}.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("OpenCodeV2Adapter", () => {
  test("uses injected Service discovery/ensure and creates a configured native session", async () => {
    const cwd = "/workspace/openscout";
    const fakeClient = createFakeClient(sessionInfo("ses-created", cwd));
    const fakeService = createFakeService({ ensured: { url: "http://127.0.0.1:7331" } });
    const injected = injectedDependencies(fakeClient.client, fakeService.service);
    fakeClient.feed.push(SERVER_CONNECTED);

    const adapter = new OpenCodeV2Adapter({
      sessionId: "scout-created",
      name: "OpenCode product V2",
      cwd,
      options: {
        command: ["/opt/opencode2", "serve", "--service"],
        agent: "build",
        model: "anthropic/claude-sonnet#high",
      },
    }, injected.dependencies);
    activeAdapters.add(adapter);

    await adapter.start();

    expect(fakeService.discoverCalls).toEqual([{}]);
    expect(fakeService.ensureCalls).toEqual([{
      command: ["/opt/opencode2", "serve", "--service"],
    }]);
    expect(injected.makeClientCalls).toEqual([{ baseUrl: "http://127.0.0.1:7331" }]);
    expect(fakeClient.getCalls).toEqual([]);
    expect(fakeClient.createCalls).toEqual([{
      title: "OpenCode product V2",
      agent: "build",
      model: { providerID: "anthropic", id: "claude-sonnet", variant: "high" },
      location: { directory: resolve(cwd) },
    }]);
    expect(adapter.debugNativeSessionId).toBe("ses-created");
    expect(adapter.session).toMatchObject({
      adapterType: "opencode-v2",
      status: "idle",
      cwd,
      model: "anthropic/claude-sonnet#high",
      providerMeta: {
        externalSessionId: "ses-created",
        opencode: {
          protocolVersion: "v2",
          clientVersion: OPENCODE_V2_CLIENT_VERSION,
          serverVersion: OPENCODE_V2_CLIENT_VERSION,
          serverUrl: "http://127.0.0.1:7331",
        },
      },
    });

    await adapter.shutdown();
    expect(fakeService.stopCalls).toEqual([]);
    expect(fakeClient.feed.closedSubscriptions).toBe(1);
    expect(adapter.session.status).toBe("closed");
  });

  test("bounds startup when shared-service discovery or ensure never settles", async () => {
    for (const hangingStage of ["discover", "ensure"] as const) {
      const fakeClient = createFakeClient(sessionInfo(`ses-hung-${hangingStage}`, "/workspace/hung"));
      let discoverCalls = 0;
      let ensureCalls = 0;
      const service: OpenCodeV2Dependencies["service"] = {
        discover: () => {
          discoverCalls += 1;
          return hangingStage === "discover"
            ? new Promise<Endpoint | undefined>(() => undefined)
            : Promise.resolve(undefined);
        },
        ensure: () => {
          ensureCalls += 1;
          return new Promise<Endpoint>(() => undefined);
        },
        headers: () => undefined,
      };
      const injected = injectedDependencies(fakeClient.client, service);
      const adapter = new OpenCodeV2Adapter({
        sessionId: `scout-hung-${hangingStage}`,
        cwd: "/workspace/hung",
        options: { startupTimeoutMs: 20 },
      }, injected.dependencies);
      activeAdapters.add(adapter);
      const collector = collectEvents(adapter);

      await expect(resolveWithin(
        adapter.start(),
        300,
        `${hangingStage} startup timeout`,
      )).rejects.toBeInstanceOf(Error);

      expect(adapter.session.status).toBe("error");
      expect(collector.errors).toHaveLength(1);
      expect(discoverCalls).toBe(1);
      expect(ensureCalls).toBe(hangingStage === "ensure" ? 1 : 0);
      expect(injected.makeClientCalls).toEqual([]);
    }
  });

  test("shutdown fences a delayed start before it can mutate the closed adapter", async () => {
    const cwd = "/workspace/start-shutdown-race";
    const fakeClient = createFakeClient(sessionInfo("ses-start-shutdown-race", cwd));
    fakeClient.feed.push(SERVER_CONNECTED);

    let discoverStarted!: () => void;
    const discoveryEntered = new Promise<void>((resolvePromise) => {
      discoverStarted = resolvePromise;
    });
    let resolveDiscovery!: (endpoint: Endpoint) => void;
    const delayedDiscovery = new Promise<Endpoint>((resolvePromise) => {
      resolveDiscovery = resolvePromise;
    });
    let ensureCalls = 0;
    const service: OpenCodeV2Dependencies["service"] = {
      discover: () => {
        discoverStarted();
        return delayedDiscovery;
      },
      ensure: () => {
        ensureCalls += 1;
        throw new Error("ensure should not run when delayed discovery succeeds");
      },
      headers: () => undefined,
    };
    const injected = injectedDependencies(fakeClient.client, service);
    const adapter = new OpenCodeV2Adapter({
      sessionId: "scout-start-shutdown-race",
      cwd,
      options: { startupTimeoutMs: 40 },
    }, injected.dependencies);
    activeAdapters.add(adapter);
    collectEvents(adapter);
    const startOutcome = adapter.start().then(
      () => ({ status: "resolved" as const, error: undefined }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );

    await resolveWithin(discoveryEntered, 300, "the delayed startup discovery");
    await resolveWithin(adapter.shutdown(), 300, "shutdown during delayed startup");
    expect(adapter.session.status).toBe("closed");

    resolveDiscovery({ url: "http://127.0.0.1:7391" });
    const outcome = await resolveWithin(startOutcome, 300, "the fenced startup rejection");

    expect(outcome.status).toBe("rejected");
    expect(outcome.error).toBeInstanceOf(Error);
    expect(adapter.session.status).toBe("closed");
    expect(injected.makeClientCalls).toEqual([]);
    expect(ensureCalls).toBe(0);
    expect(fakeClient.createCalls).toEqual([]);
    expect(fakeClient.getCalls).toEqual([]);
    expect(fakeClient.feed.subscriptions).toBe(0);
    expect(adapter.debugNativeSessionId).toBeNull();
  });

  test("resumes an exact session and forwards Basic authentication to the injected client", async () => {
    const cwd = "/workspace/resume";
    const fakeClient = createFakeClient(sessionInfo("ses-resumed", cwd));
    const fakeService = createFakeService({ authorization: "Basic YWxpY2U6c2VjcmV0" });
    const injected = injectedDependencies(fakeClient.client, fakeService.service);
    fakeClient.feed.push(SERVER_CONNECTED);

    const adapter = new OpenCodeV2Adapter({
      sessionId: "scout-resumed",
      cwd,
      options: {
        serverUrl: "http://127.0.0.1:7441/",
        serverUsername: "alice",
        serverPassword: "secret",
        sessionId: "ses-resumed",
      },
    }, injected.dependencies);
    activeAdapters.add(adapter);

    await adapter.start();

    expect(fakeService.discoverCalls).toEqual([]);
    expect(fakeService.ensureCalls).toEqual([]);
    expect(fakeService.headerCalls).toEqual([{
      url: "http://127.0.0.1:7441",
      auth: { type: "basic", username: "alice", password: "secret" },
    }]);
    expect(injected.makeClientCalls).toEqual([{
      baseUrl: "http://127.0.0.1:7441",
      headers: { authorization: "Basic YWxpY2U6c2VjcmV0" },
    }]);
    expect(fakeClient.createCalls).toEqual([]);
    expect(fakeClient.getCalls).toEqual([{ sessionID: "ses-resumed" }]);
    expect(adapter.debugNativeSessionId).toBe("ses-resumed");

    await adapter.shutdown();
    expect(fakeClient.pendingCancelCalls).toEqual([]);
    expect(fakeClient.interruptCalls).toEqual([]);
    expect(fakeClient.waitCalls).toEqual([]);
  });

  test("fails exact resume when the delayed attach recheck observes reclaimed native work", async () => {
    const cwd = "/workspace/resume-race";
    const fakeClient = createFakeClient(sessionInfo("ses-resume-race", cwd));
    const fakeService = createFakeService({ discovered: { url: "http://127.0.0.1:7491" } });
    const injected = injectedDependencies(fakeClient.client, fakeService.service);
    let activeChecks = 0;
    fakeClient.client.session.active = async (): Promise<Record<string, { type: "running" }>> => {
      activeChecks += 1;
      return activeChecks === 1 ? {} : { "ses-resume-race": { type: "running" as const } };
    };
    fakeClient.feed.push(SERVER_CONNECTED);
    const adapter = new OpenCodeV2Adapter({
      sessionId: "scout-resume-race",
      cwd,
      options: { sessionId: "ses-resume-race", reconnectDelayMs: 1 },
    }, injected.dependencies);
    activeAdapters.add(adapter);

    await expect(adapter.start()).rejects.toThrow("not quiescent after resumed-session stabilization");
    expect(activeChecks).toBe(2);
    expect(fakeClient.promptCalls).toEqual([]);
    expect(adapter.session.status).toBe("error");
  });

  test("sends ordinary files, URI files, and images in the flat V2 prompt files array", async () => {
    const cwd = "/workspace/prompt";
    const fakeClient = createFakeClient(sessionInfo("ses-prompt", cwd));
    const fakeService = createFakeService({ discovered: { url: "http://127.0.0.1:7551" } });
    const injected = injectedDependencies(fakeClient.client, fakeService.service);
    fakeClient.feed.push(SERVER_CONNECTED);

    const adapter = new OpenCodeV2Adapter({
      sessionId: "scout-prompt",
      cwd,
      options: {},
    }, injected.dependencies);
    activeAdapters.add(adapter);
    const collector = collectEvents(adapter);
    await adapter.start();

    adapter.send({
      sessionId: "scout-prompt",
      text: "inspect these",
      files: [
        "docs/readme.md",
        "file:///tmp/already-a-uri.txt",
        "data:text/plain;base64,SGVsbG8=",
      ],
      images: [{ mimeType: "image/png", data: "aW1hZ2U=" }],
    });
    await waitFor(() => fakeClient.promptCalls.length === 1, "the V2 prompt call");

    expect(fakeClient.promptCalls[0]).toEqual({
      sessionID: "ses-prompt",
      id: "msg_generated-2",
      text: "inspect these",
      files: [
        { uri: "file:///workspace/prompt/docs/readme.md", name: "readme.md" },
        { uri: "file:///tmp/already-a-uri.txt" },
        { uri: "data:text/plain;base64,SGVsbG8=" },
        { uri: "data:image/png;base64,aW1hZ2U=", name: "image-1" },
      ],
      delivery: "queue",
      resume: true,
    });
    expect((fakeClient.promptCalls[0] as unknown as { data?: unknown }).data).toBeUndefined();

    // Product V2 can emit execution/output events before our queued input is
    // promoted. Session matching alone is not ownership: ignore those events
    // until the exact prompt id reaches input.promoted.
    fakeClient.feed.push(textDelta("evt-before-promotion", "ses-prompt", "foreign"));
    await Bun.sleep(1);
    expect(collector.events.some((event) => event.event === "block:delta")).toBe(false);

    fakeClient.feed.push(inputPromoted(
      "evt-prompt-promoted",
      "ses-prompt",
      fakeClient.promptCalls[0]!.id!,
    ));
    await waitFor(() => adapter.session.status === "active", "the promoted-input active status");
    fakeClient.feed.push(textDelta("evt-after-promotion", "ses-prompt", "owned"));
    fakeClient.feed.push(executionSucceeded("evt-prompt-succeeded", "ses-prompt"));
    await waitFor(
      () => collector.events.some((event) => event.event === "turn:end"),
      "the normalized prompt terminal event",
    );
    expect(collector.errors).toEqual([]);
    expect(collector.events).toContainEqual(expect.objectContaining({
      event: "turn:end",
      status: "completed",
    }));
    expect(collector.events).toContainEqual(expect.objectContaining({
      event: "block:delta",
      text: "owned",
    }));
    expect(adapter.session.status).toBe("idle");
  });

  test("does not quarantine an id after a declared prompt 400 rejects before admission", async () => {
    const cwd = "/workspace/prompt-invalid-request";
    const fakeClient = createFakeClient(sessionInfo("ses-prompt-invalid-request", cwd));
    const fakeService = createFakeService({ discovered: { url: "http://127.0.0.1:7552" } });
    const injected = injectedDependencies(fakeClient.client, fakeService.service);
    fakeClient.feed.push(SERVER_CONNECTED);
    fakeClient.client.session.prompt = async (input) => {
      fakeClient.promptCalls.push(input);
      if (fakeClient.promptCalls.length === 1) {
        throw {
          _tag: "InvalidRequestError",
          status: 400,
          message: "the first prompt is invalid",
        };
      }
      return {
        id: input.id!,
        sessionID: "ses-prompt-invalid-request",
        timeCreated: 1_754_000_000_000,
        type: "user",
        data: { text: input.text },
        delivery: "queue",
      };
    };

    const adapter = new OpenCodeV2Adapter({
      sessionId: "scout-prompt-invalid-request",
      cwd,
    }, injected.dependencies);
    activeAdapters.add(adapter);
    const collector = collectEvents(adapter);
    await adapter.start();

    adapter.send({ sessionId: "scout-prompt-invalid-request", text: "invalid prompt" });
    await waitFor(
      () => collector.events.some((event) => event.event === "turn:end"),
      "the declared prompt rejection",
    );
    expect(collector.events.filter((event) => event.event === "turn:end")).toEqual([
      expect.objectContaining({ status: "failed" }),
    ]);
    expect(fakeClient.pendingCancelCalls).toEqual([]);

    adapter.send({ sessionId: "scout-prompt-invalid-request", text: "valid prompt" });
    await waitFor(() => fakeClient.promptCalls.length === 2, "the prompt after the declared rejection");
    const nextInputId = fakeClient.promptCalls[1]!.id!;
    fakeClient.feed.push(inputPromoted(
      "evt-invalid-request-next-promoted",
      "ses-prompt-invalid-request",
      nextInputId,
    ));
    fakeClient.feed.push(executionSucceeded(
      "evt-invalid-request-next-succeeded",
      "ses-prompt-invalid-request",
    ));
    await waitFor(
      () => collector.events.filter((event) => event.event === "turn:end").length === 2,
      "the prompt after the declared rejection to complete",
    );
    expect(collector.events.filter((event) => event.event === "turn:end").at(-1)).toMatchObject({
      status: "completed",
    });
  });

  test("keeps a transport-ambiguous prompt id quarantined even when pending cancellation returns success", async () => {
    const cwd = "/workspace/prompt-transport-error";
    const fakeClient = createFakeClient(sessionInfo("ses-prompt-transport-error", cwd));
    const fakeService = createFakeService({ discovered: { url: "http://127.0.0.1:7553" } });
    const injected = injectedDependencies(fakeClient.client, fakeService.service);
    fakeClient.feed.push(SERVER_CONNECTED);
    fakeClient.client.session.prompt = async (input) => {
      fakeClient.promptCalls.push(input);
      throw Object.assign(new Error("the prompt transport closed without a response"), {
        name: "ClientError",
        reason: "Transport" as const,
      });
    };

    const adapter = new OpenCodeV2Adapter({
      sessionId: "scout-prompt-transport-error",
      cwd,
    }, injected.dependencies);
    activeAdapters.add(adapter);
    const collector = collectEvents(adapter);
    await adapter.start();

    adapter.send({ sessionId: "scout-prompt-transport-error", text: "ambiguous prompt" });
    await waitFor(
      () => collector.events.filter((event) => event.event === "turn:end").length === 1,
      "the transport-ambiguous turn to fail closed",
    );
    await waitFor(() => fakeClient.pendingCancelCalls.length === 1, "the best-effort pending cancellation");
    const quarantinedInputId = fakeClient.promptCalls[0]!.id!;
    expect(fakeClient.pendingCancelCalls).toEqual([{
      sessionID: "ses-prompt-transport-error",
      inputID: quarantinedInputId,
    }]);
    expect(collector.events.filter((event) => event.event === "turn:end")).toEqual([
      expect.objectContaining({ status: "failed" }),
    ]);

    adapter.send({ sessionId: "scout-prompt-transport-error", text: "must not be posted" });
    await waitFor(
      () => collector.events.filter((event) => event.event === "turn:end").length === 2,
      "the next normalized turn to fail closed behind quarantine",
    );
    expect(fakeClient.promptCalls).toHaveLength(1);
    expect(collector.events.filter((event) => event.event === "turn:end").at(-1)).toMatchObject({
      status: "failed",
    });
  });

  test("treats same-turn native interactive replies as authoritative over later HTTP rejection", async () => {
    const cwd = "/workspace/native-interactive-replies";
    const fakeClient = createFakeClient(sessionInfo("ses-native-interactive-replies", cwd));
    const fakeService = createFakeService({ discovered: { url: "http://127.0.0.1:7554" } });
    const injected = injectedDependencies(fakeClient.client, fakeService.service);
    fakeClient.feed.push(SERVER_CONNECTED);

    let rejectPermissionReply!: (error: unknown) => void;
    let rejectQuestionReply!: (error: unknown) => void;
    const permissionReply = new Promise<void>((_resolve, reject) => {
      rejectPermissionReply = reject;
    });
    const questionReply = new Promise<void>((_resolve, reject) => {
      rejectQuestionReply = reject;
    });
    fakeClient.client.permission.reply = async (input) => {
      fakeClient.permissionReplyCalls.push(input);
      await permissionReply;
    };
    fakeClient.client.question.reply = async (input) => {
      fakeClient.questionReplyCalls.push(input);
      await questionReply;
    };

    const adapter = new OpenCodeV2Adapter({
      sessionId: "scout-native-interactive-replies",
      cwd,
    }, injected.dependencies);
    activeAdapters.add(adapter);
    const collector = collectEvents(adapter);
    await adapter.start();

    adapter.send({ sessionId: "scout-native-interactive-replies", text: "keep this turn active" });
    await waitFor(() => fakeClient.promptCalls.length === 1, "the interactive prompt");
    const inputId = fakeClient.promptCalls[0]!.id!;
    fakeClient.feed.push(inputPromoted(
      "evt-native-replies-promoted",
      "ses-native-interactive-replies",
      inputId,
    ));
    await waitFor(() => adapter.session.status === "active", "the interactive prompt promotion");

    fakeClient.feed.push({
      id: "evt-native-replies-permission-asked",
      created: 1_754_000_000_130,
      type: "permission.asked",
      data: {
        sessionID: "ses-native-interactive-replies",
        id: "permission-native-reply",
        action: "bash",
        resources: ["echo fixture"],
        source: { type: "tool", messageID: "msg-assistant", id: "tool-native-reply" },
      },
    } satisfies OpenCodeEvent);
    await waitFor(
      () => collector.events.some((event) => event.event === "block:action:approval"),
      "the native permission request",
    );
    const approval = collector.events.find((event) => event.event === "block:action:approval");
    if (!approval || approval.event !== "block:action:approval") throw new Error("approval missing");
    adapter.decide(approval.turnId, approval.blockId, "approve");
    await waitFor(() => fakeClient.permissionReplyCalls.length === 1, "the permission HTTP reply");
    fakeClient.feed.push({
      id: "evt-native-replies-permission-replied",
      created: 1_754_000_000_131,
      type: "permission.replied",
      data: {
        sessionID: "ses-native-interactive-replies",
        requestID: "permission-native-reply",
        reply: "once",
      },
    } satisfies OpenCodeEvent);

    fakeClient.feed.push({
      id: "evt-native-replies-question-asked",
      created: 1_754_000_000_132,
      type: "question.asked",
      data: {
        sessionID: "ses-native-interactive-replies",
        id: "question-native-reply",
        questions: [{
          header: "Continue?",
          question: "Should this turn remain active?",
          options: [{ label: "Proceed", description: "Keep the turn active." }],
        }],
      },
    } satisfies OpenCodeEvent);
    await waitFor(
      () => collector.events.some(
        (event) => event.event === "block:start" && event.block.type === "question",
      ),
      "the native question request",
    );
    const question = collector.events.find(
      (event) => event.event === "block:start" && event.block.type === "question",
    );
    if (!question || question.event !== "block:start" || question.block.type !== "question") {
      throw new Error("question missing");
    }
    adapter.answerQuestion({
      sessionId: "scout-native-interactive-replies",
      blockId: question.block.id,
      answer: ["Proceed"],
    });
    await waitFor(() => fakeClient.questionReplyCalls.length === 1, "the question HTTP reply");
    fakeClient.feed.push({
      id: "evt-native-replies-question-replied",
      created: 1_754_000_000_133,
      type: "question.replied",
      data: {
        sessionID: "ses-native-interactive-replies",
        requestID: "question-native-reply",
        answers: [["Proceed"]],
      },
    } satisfies OpenCodeEvent);

    await waitFor(
      () => collector.events.some(
        (event) => event.event === "block:question:answer" && event.questionStatus === "answered",
      ),
      "both authoritative native reply events",
    );
    rejectPermissionReply({ _tag: "Conflict", message: "permission HTTP response was lost" });
    rejectQuestionReply({ _tag: "Conflict", message: "question HTTP response was lost" });
    await waitFor(() => collector.errors.length === 2, "the diagnostic HTTP reply failures");

    expect(collector.events.some((event) => event.event === "turn:end")).toBe(false);
    expect(fakeClient.pendingCancelCalls).toEqual([]);
    expect(fakeClient.interruptCalls).toEqual([]);
    expect(adapter.session.status).toBe("active");

    fakeClient.feed.push(executionSucceeded(
      "evt-native-replies-succeeded",
      "ses-native-interactive-replies",
    ));
    await waitFor(
      () => collector.events.some((event) => event.event === "turn:end"),
      "the still-valid interactive turn completion",
    );
    expect(collector.events.filter((event) => event.event === "turn:end")).toEqual([
      expect.objectContaining({ status: "completed" }),
    ]);
  });

  test("posts the V2 interrupt and emits a stopped fallback without stopping the shared service", async () => {
    const cwd = "/workspace/interrupt";
    const fakeClient = createFakeClient(sessionInfo("ses-interrupt", cwd));
    const fakeService = createFakeService({ discovered: { url: "http://127.0.0.1:7661" } });
    const injected = injectedDependencies(fakeClient.client, fakeService.service);
    fakeClient.feed.push(SERVER_CONNECTED);

    const adapter = new OpenCodeV2Adapter({
      sessionId: "scout-interrupt",
      cwd,
    }, injected.dependencies);
    activeAdapters.add(adapter);
    const collector = collectEvents(adapter);
    await adapter.start();

    adapter.send({ sessionId: "scout-interrupt", text: "keep working" });
    await waitFor(() => fakeClient.promptCalls.length === 1, "the active V2 prompt");
    fakeClient.feed.push(inputPromoted(
      "evt-interrupt-promoted",
      "ses-interrupt",
      fakeClient.promptCalls[0]!.id!,
    ));
    await Bun.sleep(1);
    adapter.interrupt();
    await waitFor(
      () => collector.events.some((event) => event.event === "turn:end"),
      "the interrupt fallback terminal event",
    );

    expect(fakeClient.interruptCalls).toEqual([{
      input: { sessionID: "ses-interrupt" },
      options: { signal: expect.any(AbortSignal) },
    }]);
    expect(collector.events).toContainEqual(expect.objectContaining({
      event: "turn:end",
      status: "stopped",
    }));
    expect(collector.errors).toEqual([]);

    await adapter.shutdown();
    expect(fakeClient.interruptCalls).toHaveLength(1);
    expect(fakeService.stopCalls).toEqual([]);
  });

  test("settles a pending-input interrupt as stopped even when native cancellation arrives before HTTP 204", async () => {
    const cwd = "/workspace/pending-interrupt";
    const fakeClient = createFakeClient(sessionInfo("ses-pending-interrupt", cwd));
    const fakeService = createFakeService({ discovered: { url: "http://127.0.0.1:7681" } });
    const injected = injectedDependencies(fakeClient.client, fakeService.service);
    fakeClient.feed.push(SERVER_CONNECTED);
    const adapter = new OpenCodeV2Adapter({
      sessionId: "scout-pending-interrupt",
      cwd,
    }, injected.dependencies);
    activeAdapters.add(adapter);
    const collector = collectEvents(adapter);
    await adapter.start();

    adapter.send({ sessionId: "scout-pending-interrupt", text: "stop before promotion" });
    await waitFor(() => fakeClient.promptCalls.length === 1, "the pending interrupt prompt");
    const inputId = fakeClient.promptCalls[0]!.id!;
    fakeClient.client.session.pending.cancel = async (input) => {
      fakeClient.pendingCancelCalls.push(input);
      fakeClient.feed.push(inputCancelled(
        "evt-pending-interrupt-cancelled",
        "ses-pending-interrupt",
        input.inputID,
      ));
      await Bun.sleep(1);
    };

    adapter.interrupt();
    await waitFor(
      () => collector.events.some((event) => event.event === "turn:end"),
      "the deterministic pending-input stop",
    );
    expect(fakeClient.pendingCancelCalls).toContainEqual({
      sessionID: "ses-pending-interrupt",
      inputID: inputId,
    });
    expect(collector.events.filter((event) => event.event === "turn:end")).toEqual([
      expect.objectContaining({ status: "stopped" }),
    ]);
    expect(collector.events.some(
      (event) => event.event === "turn:end" && event.status === "failed",
    )).toBe(false);
  });

  test("retries exact cleanup when admission and a pre-promotion failure race a delayed 404", async () => {
    const cwd = "/workspace/cancel-admission-race";
    const fakeClient = createFakeClient(sessionInfo("ses-cancel-admission-race", cwd));
    const fakeService = createFakeService({ discovered: { url: "http://127.0.0.1:7682" } });
    const injected = injectedDependencies(fakeClient.client, fakeService.service);
    fakeClient.feed.push(SERVER_CONNECTED);

    fakeClient.client.session.prompt = async (input, options) => {
      fakeClient.promptCalls.push(input);
      if (fakeClient.promptCalls.length > 1) {
        return {
          id: input.id!,
          sessionID: "ses-cancel-admission-race",
          timeCreated: 1_754_000_000_000,
          type: "user",
          data: { text: input.text },
          delivery: "queue",
        };
      }
      return new Promise<never>((_resolve, reject) => {
        const signal = options?.signal;
        const abort = () => reject(signal?.reason ?? new Error("prompt aborted"));
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    };

    let rejectFirstCancel!: (error: unknown) => void;
    const firstCancel = new Promise<void>((_resolve, reject) => {
      rejectFirstCancel = reject;
    });
    fakeClient.client.session.pending.cancel = async (input) => {
      fakeClient.pendingCancelCalls.push(input);
      if (fakeClient.pendingCancelCalls.length === 1) await firstCancel;
    };

    const adapter = new OpenCodeV2Adapter({
      sessionId: "scout-cancel-admission-race",
      cwd,
    }, injected.dependencies);
    activeAdapters.add(adapter);
    const collector = collectEvents(adapter);
    await adapter.start();

    adapter.send({ sessionId: "scout-cancel-admission-race", text: "race admission with Stop" });
    await waitFor(() => fakeClient.promptCalls.length === 1, "the in-flight prompt POST");
    const firstInputId = fakeClient.promptCalls[0]!.id!;

    adapter.interrupt();
    await waitFor(() => fakeClient.pendingCancelCalls.length === 1, "the first exact-id cleanup");
    fakeClient.feed.push(inputAdmitted(
      "evt-cancel-race-admitted",
      "ses-cancel-admission-race",
      firstInputId,
    ));
    fakeClient.feed.push(executionFailed(
      "evt-cancel-race-execution-failed",
      "ses-cancel-admission-race",
      "pre-promotion preparation failed",
    ));
    rejectFirstCancel({
      _tag: "NotFound",
      status: 404,
      message: "pending input was not found during the first cancellation attempt",
    });

    await waitFor(
      () => fakeClient.pendingCancelCalls.length === 2,
      "the post-admission exact-id cleanup retry",
    );
    expect(fakeClient.pendingCancelCalls).toEqual([
      { sessionID: "ses-cancel-admission-race", inputID: firstInputId },
      { sessionID: "ses-cancel-admission-race", inputID: firstInputId },
    ]);
    expect(collector.events.filter((event) => event.event === "turn:end")).toEqual([
      expect.objectContaining({ status: "stopped" }),
    ]);

    adapter.send({ sessionId: "scout-cancel-admission-race", text: "next prompt" });
    await waitFor(() => fakeClient.promptCalls.length === 2, "the prompt after cleanup retry");
    const secondInputId = fakeClient.promptCalls[1]!.id!;
    fakeClient.feed.push(inputPromoted(
      "evt-cancel-race-next-promoted",
      "ses-cancel-admission-race",
      secondInputId,
    ));
    fakeClient.feed.push(executionSucceeded(
      "evt-cancel-race-next-succeeded",
      "ses-cancel-admission-race",
    ));
    await waitFor(
      () => collector.events.filter((event) => event.event === "turn:end").length === 2,
      "the prompt after cleanup retry to complete",
    );
    expect(collector.events.filter((event) => event.event === "turn:end").at(-1)).toMatchObject({
      status: "completed",
    });
  });

  test("does not post the next prompt while a promoted cleanup interrupt remains in flight", async () => {
    const cwd = "/workspace/promoted-cleanup-barrier";
    const fakeClient = createFakeClient(sessionInfo("ses-promoted-cleanup-barrier", cwd));
    const fakeService = createFakeService({ discovered: { url: "http://127.0.0.1:7683" } });
    const injected = injectedDependencies(fakeClient.client, fakeService.service);
    fakeClient.feed.push(SERVER_CONNECTED);

    let resolveCleanupInterrupt!: () => void;
    const cleanupInterrupt = new Promise<void>((resolvePromise) => {
      resolveCleanupInterrupt = resolvePromise;
    });
    fakeClient.client.session.interrupt = async (input, options) => {
      fakeClient.interruptCalls.push({ input, options });
      await cleanupInterrupt;
    };

    const adapter = new OpenCodeV2Adapter({
      sessionId: "scout-promoted-cleanup-barrier",
      cwd,
    }, injected.dependencies);
    activeAdapters.add(adapter);
    const collector = collectEvents(adapter);
    await adapter.start();

    adapter.send({ sessionId: "scout-promoted-cleanup-barrier", text: "Turn A" });
    await waitFor(() => fakeClient.promptCalls.length === 1, "Turn A prompt admission");
    const firstInputId = fakeClient.promptCalls[0]!.id!;
    fakeClient.feed.push(inputPromoted(
      "evt-cleanup-barrier-a-promoted",
      "ses-promoted-cleanup-barrier",
      firstInputId,
    ));
    await waitFor(() => adapter.session.status === "active", "Turn A promotion");

    adapter.interrupt();
    await waitFor(() => fakeClient.interruptCalls.length === 1, "Turn A cleanup interrupt");
    fakeClient.feed.push(executionInterrupted(
      "evt-cleanup-barrier-a-interrupted",
      "ses-promoted-cleanup-barrier",
    ));
    adapter.send({ sessionId: "scout-promoted-cleanup-barrier", text: "Turn B" });

    await Bun.sleep(10);
    expect(fakeClient.promptCalls).toHaveLength(1);
    expect(collector.events.filter((event) => event.event === "turn:start")).toHaveLength(1);

    resolveCleanupInterrupt();
    await waitFor(() => fakeClient.promptCalls.length === 2, "Turn B after cleanup interrupt settles");
    const secondInputId = fakeClient.promptCalls[1]!.id!;
    fakeClient.feed.push(inputPromoted(
      "evt-cleanup-barrier-b-promoted",
      "ses-promoted-cleanup-barrier",
      secondInputId,
    ));
    fakeClient.feed.push(executionSucceeded(
      "evt-cleanup-barrier-b-succeeded",
      "ses-promoted-cleanup-barrier",
    ));
    await waitFor(
      () => collector.events.filter((event) => event.event === "turn:end").length === 2,
      "Turn B completion",
    );
    expect(collector.events.filter((event) => event.event === "turn:end").map((event) => event.status)).toEqual([
      "stopped",
      "completed",
    ]);
  });

  test("does not duplicate a successful promoted interrupt when the prompt response advances cleanup evidence", async () => {
    const cwd = "/workspace/promoted-cleanup-generation";
    const fakeClient = createFakeClient(sessionInfo("ses-promoted-cleanup-generation", cwd));
    const fakeService = createFakeService({ discovered: { url: "http://127.0.0.1:7685" } });
    const injected = injectedDependencies(fakeClient.client, fakeService.service);
    fakeClient.feed.push(SERVER_CONNECTED);

    let resolveFirstPrompt!: (value: Awaited<ReturnType<OpenCodeClient["session"]["prompt"]>>) => void;
    const firstPrompt = new Promise<Awaited<ReturnType<OpenCodeClient["session"]["prompt"]>>>(
      (resolvePromise) => { resolveFirstPrompt = resolvePromise; },
    );
    fakeClient.client.session.prompt = async (input) => {
      fakeClient.promptCalls.push(input);
      if (fakeClient.promptCalls.length === 1) return firstPrompt;
      return {
        id: input.id!,
        sessionID: "ses-promoted-cleanup-generation",
        timeCreated: 1_754_000_000_000,
        type: "user",
        data: { text: input.text },
        delivery: "queue",
      };
    };

    let resolveCleanupInterrupt!: () => void;
    const cleanupInterrupt = new Promise<void>((resolvePromise) => {
      resolveCleanupInterrupt = resolvePromise;
    });
    fakeClient.client.session.interrupt = async (input, options) => {
      fakeClient.interruptCalls.push({ input, options });
      await cleanupInterrupt;
    };

    const adapter = new OpenCodeV2Adapter({
      sessionId: "scout-promoted-cleanup-generation",
      cwd,
    }, injected.dependencies);
    activeAdapters.add(adapter);
    const collector = collectEvents(adapter);
    await adapter.start();

    adapter.send({ sessionId: "scout-promoted-cleanup-generation", text: "Turn A" });
    await waitFor(() => fakeClient.promptCalls.length === 1, "Turn A in-flight prompt response");
    const firstInput = fakeClient.promptCalls[0]!;
    fakeClient.feed.push(inputPromoted(
      "evt-cleanup-generation-a-promoted",
      "ses-promoted-cleanup-generation",
      firstInput.id!,
    ));
    await waitFor(() => adapter.session.status === "active", "Turn A promotion before its HTTP response");

    adapter.interrupt();
    await waitFor(() => fakeClient.interruptCalls.length === 1, "the first promoted cleanup interrupt");
    resolveFirstPrompt({
      id: firstInput.id!,
      sessionID: "ses-promoted-cleanup-generation",
      timeCreated: 1_754_000_000_000,
      type: "user",
      data: { text: firstInput.text },
      delivery: "queue",
    });
    await Bun.sleep(1);
    resolveCleanupInterrupt();
    fakeClient.feed.push(executionInterrupted(
      "evt-cleanup-generation-a-interrupted",
      "ses-promoted-cleanup-generation",
    ));
    await Bun.sleep(1);

    expect(fakeClient.interruptCalls).toHaveLength(1);
    expect(collector.events.filter((event) => event.event === "turn:end")).toEqual([
      expect.objectContaining({ status: "stopped" }),
    ]);

    adapter.send({ sessionId: "scout-promoted-cleanup-generation", text: "Turn B" });
    await waitFor(() => fakeClient.promptCalls.length === 2, "Turn B after the successful cleanup boundary");
    expect(fakeClient.interruptCalls).toHaveLength(1);
    const secondInputId = fakeClient.promptCalls[1]!.id!;
    fakeClient.feed.push(inputPromoted(
      "evt-cleanup-generation-b-promoted",
      "ses-promoted-cleanup-generation",
      secondInputId,
    ));
    fakeClient.feed.push(executionSucceeded(
      "evt-cleanup-generation-b-succeeded",
      "ses-promoted-cleanup-generation",
    ));
    await waitFor(
      () => collector.events.filter((event) => event.event === "turn:end").length === 2,
      "Turn B completion",
    );
    expect(fakeClient.interruptCalls).toHaveLength(1);
    expect(collector.events.filter((event) => event.event === "turn:end").map((event) => event.status)).toEqual([
      "stopped",
      "completed",
    ]);
  });

  test("keeps Turn B quarantined when promoted cleanup rejects after the native terminal", async () => {
    const cwd = "/workspace/promoted-cleanup-transport";
    const fakeClient = createFakeClient(sessionInfo("ses-promoted-cleanup-transport", cwd));
    const fakeService = createFakeService({ discovered: { url: "http://127.0.0.1:7684" } });
    const injected = injectedDependencies(fakeClient.client, fakeService.service);
    fakeClient.feed.push(SERVER_CONNECTED);

    let resolveFirstPrompt!: (value: Awaited<ReturnType<OpenCodeClient["session"]["prompt"]>>) => void;
    const firstPrompt = new Promise<Awaited<ReturnType<OpenCodeClient["session"]["prompt"]>>>(
      (resolvePromise) => { resolveFirstPrompt = resolvePromise; },
    );
    fakeClient.client.session.prompt = async (input) => {
      fakeClient.promptCalls.push(input);
      return firstPrompt;
    };

    let rejectCleanupInterrupt!: (error: unknown) => void;
    const cleanupInterrupt = new Promise<void>((_resolve, reject) => {
      rejectCleanupInterrupt = reject;
    });
    fakeClient.client.session.interrupt = async (input, options) => {
      fakeClient.interruptCalls.push({ input, options });
      await cleanupInterrupt;
    };

    const adapter = new OpenCodeV2Adapter({
      sessionId: "scout-promoted-cleanup-transport",
      cwd,
    }, injected.dependencies);
    activeAdapters.add(adapter);
    const collector = collectEvents(adapter);
    await adapter.start();

    adapter.send({ sessionId: "scout-promoted-cleanup-transport", text: "Turn A" });
    await waitFor(() => fakeClient.promptCalls.length === 1, "Turn A transport-cleanup prompt");
    const firstInputId = fakeClient.promptCalls[0]!.id!;
    fakeClient.feed.push(inputPromoted(
      "evt-cleanup-transport-a-promoted",
      "ses-promoted-cleanup-transport",
      firstInputId,
    ));
    await waitFor(() => adapter.session.status === "active", "Turn A transport-cleanup promotion");

    adapter.interrupt();
    await waitFor(() => fakeClient.interruptCalls.length === 1, "the unresolved cleanup interrupt");
    resolveFirstPrompt({
      id: firstInputId,
      sessionID: "ses-promoted-cleanup-transport",
      timeCreated: 1_754_000_000_000,
      type: "user",
      data: { text: "Turn A" },
      delivery: "queue",
    });
    await Bun.sleep(1);
    expect(fakeClient.interruptCalls).toHaveLength(1);
    fakeClient.feed.push(executionInterrupted(
      "evt-cleanup-transport-a-interrupted",
      "ses-promoted-cleanup-transport",
    ));
    adapter.send({ sessionId: "scout-promoted-cleanup-transport", text: "Turn B" });
    await Bun.sleep(10);
    expect(fakeClient.promptCalls).toHaveLength(1);

    rejectCleanupInterrupt(Object.assign(new Error("cleanup interrupt transport failed"), {
      name: "ClientError",
      reason: "Transport" as const,
    }));
    await waitFor(
      () => collector.errors.some((error) => error.message.includes("cleanup interrupt transport failed")),
      "the cleanup interrupt transport rejection",
    );
    await waitFor(
      () => collector.events.filter((event) => event.event === "turn:end").length === 2,
      "Turn B to fail closed behind the promoted cleanup quarantine",
    );

    expect(fakeClient.promptCalls).toHaveLength(1);
    expect(fakeClient.interruptCalls).toHaveLength(1);
    expect(collector.events.filter((event) => event.event === "turn:end").map((event) => event.status)).toEqual([
      "stopped",
      "failed",
    ]);

    await adapter.shutdown();
    expect(adapter.session.status).toBe("closed");
    expect(fakeClient.interruptCalls).toHaveLength(1);
  });

  test("interrupts an exact late promotion after Stop races an in-flight prompt POST", async () => {
    const cwd = "/workspace/late-promotion";
    const fakeClient = createFakeClient(sessionInfo("ses-late-promotion", cwd));
    const fakeService = createFakeService({ discovered: { url: "http://127.0.0.1:7691" } });
    const injected = injectedDependencies(fakeClient.client, fakeService.service);
    fakeClient.feed.push(SERVER_CONNECTED);
    let resolvePrompt!: (value: Awaited<ReturnType<OpenCodeClient["session"]["prompt"]>>) => void;
    const promptResponse = new Promise<Awaited<ReturnType<OpenCodeClient["session"]["prompt"]>>>(
      (resolvePromise) => { resolvePrompt = resolvePromise; },
    );
    fakeClient.client.session.prompt = async (input) => {
      fakeClient.promptCalls.push(input);
      return promptResponse;
    };
    fakeClient.client.session.pending.cancel = async (input) => {
      fakeClient.pendingCancelCalls.push(input);
      throw { _tag: "Conflict", message: "input is not pending" };
    };
    const adapter = new OpenCodeV2Adapter({
      sessionId: "scout-late-promotion",
      cwd,
    }, injected.dependencies);
    activeAdapters.add(adapter);
    const collector = collectEvents(adapter);
    await adapter.start();

    adapter.send({ sessionId: "scout-late-promotion", text: "race Stop" });
    await waitFor(() => fakeClient.promptCalls.length === 1, "the in-flight prompt POST");
    const input = fakeClient.promptCalls[0]!;
    adapter.interrupt();
    fakeClient.feed.push(inputAdmitted(
      "evt-late-promotion-admitted",
      "ses-late-promotion",
      input.id!,
    ));
    fakeClient.feed.push(inputPromoted(
      "evt-late-promotion-promoted",
      "ses-late-promotion",
      input.id!,
    ));
    resolvePrompt({
      id: input.id!,
      sessionID: "ses-late-promotion",
      timeCreated: 1_754_000_000_000,
      type: "user",
      data: { text: input.text },
      delivery: "queue",
    });

    await waitFor(() => fakeClient.interruptCalls.length === 1, "the late-promotion interrupt");
    expect(collector.events.filter((event) => event.event === "turn:end")).toEqual([
      expect.objectContaining({ status: "stopped" }),
    ]);
    expect(fakeClient.pendingCancelCalls.length).toBeGreaterThanOrEqual(1);
  });

  test("fails closed and cancels when execution terminates before local input promotion", async () => {
    const cwd = "/workspace/pre-promotion-failure";
    const fakeClient = createFakeClient(sessionInfo("ses-pre-promotion-failure", cwd));
    const fakeService = createFakeService({ discovered: { url: "http://127.0.0.1:7701" } });
    const injected = injectedDependencies(fakeClient.client, fakeService.service);
    fakeClient.feed.push(SERVER_CONNECTED);
    const adapter = new OpenCodeV2Adapter({
      sessionId: "scout-pre-promotion-failure",
      cwd,
    }, injected.dependencies);
    activeAdapters.add(adapter);
    const collector = collectEvents(adapter);
    await adapter.start();

    adapter.send({ sessionId: "scout-pre-promotion-failure", text: "may fail in preparation" });
    await waitFor(() => fakeClient.promptCalls.length === 1, "the admitted pre-promotion prompt");
    const inputId = fakeClient.promptCalls[0]!.id!;
    fakeClient.feed.push(executionFailed(
      "evt-pre-promotion-failed",
      "ses-pre-promotion-failure",
      "instruction preparation failed",
    ));

    await waitFor(
      () => collector.events.some((event) => event.event === "turn:end"),
      "the pre-promotion failure terminal",
    );
    expect(collector.events).toContainEqual(expect.objectContaining({
      event: "turn:end",
      status: "failed",
    }));
    expect(fakeClient.pendingCancelCalls).toContainEqual({
      sessionID: "ses-pre-promotion-failure",
      inputID: inputId,
    });
  });

  test("routes an answer made synchronously from the emitted native question block", async () => {
    const cwd = "/workspace/question";
    const fakeClient = createFakeClient(sessionInfo("ses-question", cwd));
    const fakeService = createFakeService({ discovered: { url: "http://127.0.0.1:7711" } });
    const injected = injectedDependencies(fakeClient.client, fakeService.service);
    fakeClient.feed.push(SERVER_CONNECTED);
    const adapter = new OpenCodeV2Adapter({
      sessionId: "scout-question",
      cwd,
    }, injected.dependencies);
    activeAdapters.add(adapter);
    await adapter.start();

    adapter.send({ sessionId: "scout-question", text: "ask me" });
    await waitFor(() => fakeClient.promptCalls.length === 1, "the question prompt");
    fakeClient.feed.push(inputPromoted(
      "evt-question-promoted",
      "ses-question",
      fakeClient.promptCalls[0]!.id!,
    ));
    adapter.on("event", (event) => {
      if (event.event !== "block:start" || event.block.type !== "question") return;
      adapter.answerQuestion({
        sessionId: "scout-question",
        blockId: event.block.id,
        answer: ["Proceed"],
      });
    });
    fakeClient.feed.push({
      id: "evt-question-asked",
      created: 1_754_000_000_120,
      type: "question.asked",
      data: {
        sessionID: "ses-question",
        id: "question-1",
        questions: [{
          header: "Continue?",
          question: "Should the adapter continue?",
          options: [{ label: "Proceed", description: "Continue the turn." }],
        }],
      },
    } satisfies OpenCodeEvent);

    await waitFor(() => fakeClient.questionReplyCalls.length === 1, "the synchronous question reply");
    expect(fakeClient.questionReplyCalls).toEqual([{
      sessionID: "ses-question",
      requestID: "question-1",
      answers: [["Proceed"]],
    }]);
    fakeClient.feed.push(executionSucceeded("evt-question-succeeded", "ses-question"));
  });

  test("stale permission and question reply failures from Turn A cannot tear down Turn B", async () => {
    const cwd = "/workspace/stale-interactive-replies";
    const fakeClient = createFakeClient(sessionInfo("ses-stale-interactive-replies", cwd));
    const fakeService = createFakeService({ discovered: { url: "http://127.0.0.1:7712" } });
    const injected = injectedDependencies(fakeClient.client, fakeService.service);
    fakeClient.feed.push(SERVER_CONNECTED);

    let rejectPermissionReply!: (error: unknown) => void;
    let rejectQuestionReply!: (error: unknown) => void;
    const permissionReply = new Promise<void>((_resolve, reject) => {
      rejectPermissionReply = reject;
    });
    const questionReply = new Promise<void>((_resolve, reject) => {
      rejectQuestionReply = reject;
    });
    fakeClient.client.permission.reply = async (input) => {
      fakeClient.permissionReplyCalls.push(input);
      await permissionReply;
    };
    fakeClient.client.question.reply = async (input) => {
      fakeClient.questionReplyCalls.push(input);
      await questionReply;
    };

    const adapter = new OpenCodeV2Adapter({
      sessionId: "scout-stale-interactive-replies",
      cwd,
    }, injected.dependencies);
    activeAdapters.add(adapter);
    const collector = collectEvents(adapter);
    await adapter.start();

    adapter.send({ sessionId: "scout-stale-interactive-replies", text: "Turn A" });
    await waitFor(() => fakeClient.promptCalls.length === 1, "Turn A prompt");
    const firstInputId = fakeClient.promptCalls[0]!.id!;
    fakeClient.feed.push(inputPromoted(
      "evt-stale-replies-a-promoted",
      "ses-stale-interactive-replies",
      firstInputId,
    ));
    await waitFor(() => adapter.session.status === "active", "Turn A promotion");

    fakeClient.feed.push({
      id: "evt-stale-replies-permission",
      created: 1_754_000_000_120,
      type: "permission.asked",
      data: {
        sessionID: "ses-stale-interactive-replies",
        id: "permission-a",
        action: "bash",
        resources: ["echo fixture"],
        source: { type: "tool", messageID: "msg-assistant", id: "tool-a" },
      },
    } satisfies OpenCodeEvent);
    await waitFor(
      () => collector.events.some((event) => event.event === "block:action:approval"),
      "Turn A permission block",
    );
    const approval = collector.events.find((event) => event.event === "block:action:approval");
    expect(approval?.event).toBe("block:action:approval");
    if (!approval || approval.event !== "block:action:approval") throw new Error("approval missing");
    adapter.decide(approval.turnId, approval.blockId, "approve");

    fakeClient.feed.push({
      id: "evt-stale-replies-question",
      created: 1_754_000_000_121,
      type: "question.asked",
      data: {
        sessionID: "ses-stale-interactive-replies",
        id: "question-a",
        questions: [{
          header: "Continue?",
          question: "Should Turn A continue?",
          options: [{ label: "Proceed", description: "Continue Turn A." }],
        }],
      },
    } satisfies OpenCodeEvent);
    await waitFor(
      () => collector.events.some(
        (event) => event.event === "block:start" && event.block.type === "question",
      ),
      "Turn A question block",
    );
    const question = collector.events.find(
      (event) => event.event === "block:start" && event.block.type === "question",
    );
    expect(question?.event).toBe("block:start");
    if (!question || question.event !== "block:start" || question.block.type !== "question") {
      throw new Error("question missing");
    }
    adapter.answerQuestion({
      sessionId: "scout-stale-interactive-replies",
      blockId: question.block.id,
      answer: ["Proceed"],
    });
    await waitFor(
      () => fakeClient.permissionReplyCalls.length === 1 && fakeClient.questionReplyCalls.length === 1,
      "Turn A interactive reply requests",
    );

    fakeClient.feed.push(executionSucceeded(
      "evt-stale-replies-a-succeeded",
      "ses-stale-interactive-replies",
    ));
    await waitFor(
      () => collector.events.filter((event) => event.event === "turn:end").length === 1,
      "Turn A completion",
    );
    adapter.send({ sessionId: "scout-stale-interactive-replies", text: "Turn B" });
    await waitFor(() => fakeClient.promptCalls.length === 2, "Turn B prompt");
    const secondInputId = fakeClient.promptCalls[1]!.id!;
    fakeClient.feed.push(inputPromoted(
      "evt-stale-replies-b-promoted",
      "ses-stale-interactive-replies",
      secondInputId,
    ));
    await waitFor(() => adapter.session.status === "active", "Turn B promotion");

    rejectPermissionReply({ _tag: "Conflict", message: "stale permission reply failed" });
    rejectQuestionReply({ _tag: "Conflict", message: "stale question reply failed" });
    await waitFor(() => collector.errors.length === 2, "both stale reply rejections");
    expect(collector.events.filter((event) => event.event === "turn:end")).toHaveLength(1);
    expect(fakeClient.pendingCancelCalls).toEqual([]);
    expect(fakeClient.interruptCalls).toEqual([]);
    expect(adapter.session.status).toBe("active");

    fakeClient.feed.push(executionSucceeded(
      "evt-stale-replies-b-succeeded",
      "ses-stale-interactive-replies",
    ));
    await waitFor(
      () => collector.events.filter((event) => event.event === "turn:end").length === 2,
      "Turn B completion after stale reply failures",
    );
    expect(collector.events.filter((event) => event.event === "turn:end").at(-1)).toMatchObject({
      status: "completed",
    });
  });

  test("rejects active or pending resumed work and a foreign promoted input without misattributing it", async () => {
    const cwd = "/workspace/shared";
    const fakeClient = createFakeClient(sessionInfo("ses-shared", cwd));
    const fakeService = createFakeService({ discovered: { url: "http://127.0.0.1:7771" } });
    const injected = injectedDependencies(fakeClient.client, fakeService.service);
    fakeClient.feed.push(SERVER_CONNECTED);

    const adapter = new OpenCodeV2Adapter({
      sessionId: "scout-shared",
      cwd,
      options: { sessionId: "ses-shared" },
    }, injected.dependencies);
    activeAdapters.add(adapter);
    const collector = collectEvents(adapter);
    await adapter.start();

    fakeClient.activeSessions["ses-shared"] = { type: "running" };
    adapter.send({ sessionId: "scout-shared", text: "do not steal the active session" });
    await waitFor(() => collector.errors.length === 1, "the active-session admission error");
    expect(fakeClient.promptCalls).toEqual([]);
    expect(collector.errors[0]?.message).toContain("already has active or pending work");

    delete fakeClient.activeSessions["ses-shared"];
    fakeClient.pendingInputs.push({
      id: "msg-foreign-pending",
      sessionID: "ses-shared",
      type: "user",
    });
    adapter.send({ sessionId: "scout-shared", text: "do not jump the pending queue" });
    await waitFor(() => collector.errors.length === 2, "the pending-input admission error");
    expect(fakeClient.promptCalls).toEqual([]);
    expect(collector.errors[1]?.message).toContain("already has active or pending work");

    fakeClient.pendingInputs.length = 0;
    adapter.send({ sessionId: "scout-shared", text: "owned prompt" });
    await waitFor(() => fakeClient.promptCalls.length === 1, "the owned prompt admission");
    const ownedInputId = fakeClient.promptCalls[0]?.id;
    expect(typeof ownedInputId).toBe("string");

    fakeClient.feed.push(inputAdmitted("evt-foreign-input", "ses-shared", "msg-foreign"));
    await Bun.sleep(1);
    expect(collector.errors).toHaveLength(2);
    fakeClient.feed.push(inputPromoted("evt-foreign-promoted", "ses-shared", "msg-foreign"));
    await waitFor(() => collector.errors.length === 3, "the foreign-input correlation error");
    expect(collector.errors[2]?.message).toContain("promoted another client's input");
    await waitFor(() => fakeClient.pendingCancelCalls.length === 1, "the owned pending-input cancellation");
    expect(fakeClient.pendingCancelCalls).toEqual([{
      sessionID: "ses-shared",
      inputID: ownedInputId,
    }]);
  });

  test("shutdown aborts a never-settling service rediscovery after SSE EOF", async () => {
    const cwd = "/workspace/hung-reconnect";
    const native = sessionInfo("ses-hung-reconnect", cwd);
    const fakeClient = createFakeClient(native);
    fakeClient.feed.push(SERVER_CONNECTED);

    let discoveries = 0;
    let rediscoveryStarted!: () => void;
    const rediscoveryEntered = new Promise<void>((resolvePromise) => {
      rediscoveryStarted = resolvePromise;
    });
    const service: OpenCodeV2Dependencies["service"] = {
      discover: () => {
        discoveries += 1;
        if (discoveries === 1) {
          return Promise.resolve({ url: "http://127.0.0.1:7871" });
        }
        rediscoveryStarted();
        return new Promise<Endpoint | undefined>(() => undefined);
      },
      ensure: () => {
        throw new Error("ensure should not run when discovery succeeds");
      },
      headers: () => undefined,
    };
    let nextId = 0;
    const adapter = new OpenCodeV2Adapter({
      sessionId: "scout-hung-reconnect",
      cwd,
      options: { reconnectDelayMs: 1, startupTimeoutMs: 120_000 },
    }, {
      service,
      makeClient: () => fakeClient.client,
      delay: async () => undefined,
      now: () => "2026-08-11T12:00:00.000Z",
      nextId: () => `hung-reconnect-${++nextId}`,
    });
    activeAdapters.add(adapter);
    collectEvents(adapter);
    await adapter.start();

    fakeClient.feed.close();
    await resolveWithin(rediscoveryEntered, 300, "the never-settling service rediscovery");
    expect(discoveries).toBe(2);
    expect(adapter.session.status).toBe("connecting");

    await resolveWithin(adapter.shutdown(), 500, "bounded shutdown during service rediscovery");

    expect(adapter.session.status).toBe("closed");
    expect(fakeClient.feed.closedSubscriptions).toBe(1);
  });

  test("rediscovers a restarted shared service and quiesces a turn lost across the SSE gap", async () => {
    const cwd = "/workspace/reconnect";
    const native = sessionInfo("ses-reconnect", cwd);
    const first = createFakeClient(native);
    const second = createFakeClient(native);
    first.feed.push(SERVER_CONNECTED);
    second.feed.push({ ...SERVER_CONNECTED, id: "evt-server-reconnected" });

    const endpoints: Endpoint[] = [
      { url: "http://127.0.0.1:7881", auth: { type: "basic", username: "opencode", password: "first" } },
      { url: "http://127.0.0.1:7882", auth: { type: "basic", username: "opencode", password: "second" } },
    ];
    let discoveries = 0;
    const service: OpenCodeV2Dependencies["service"] = {
      discover: async () => endpoints[Math.min(discoveries++, endpoints.length - 1)],
      ensure: async () => {
        throw new Error("ensure should not run when discovery succeeds");
      },
      headers: (endpoint) => ({
        authorization: `Basic ${Buffer.from(`opencode:${endpoint.auth?.password ?? ""}`).toString("base64")}`,
      }),
    };
    const makeClientCalls: ClientOptions[] = [];
    let nextId = 0;
    const adapter = new OpenCodeV2Adapter({
      sessionId: "scout-reconnect",
      cwd,
      options: { reconnectDelayMs: 1 },
    }, {
      service,
      makeClient: (options) => {
        makeClientCalls.push(options);
        return options.baseUrl.endsWith(":7881") ? first.client : second.client;
      },
      delay: async () => undefined,
      now: () => "2026-08-11T12:00:00.000Z",
      nextId: () => `reconnect-${++nextId}`,
    });
    activeAdapters.add(adapter);
    const collector = collectEvents(adapter);
    await adapter.start();

    adapter.send({ sessionId: "scout-reconnect", text: "turn crossing a restart" });
    await waitFor(() => first.promptCalls.length === 1, "the pre-restart prompt");
    first.feed.close();

    await waitFor(() => makeClientCalls.length === 2, "the refreshed V2 client");
    await waitFor(() => second.waitCalls.length === 1, "the post-restart quiescence wait");
    expect(discoveries).toBeGreaterThanOrEqual(2);
    expect(makeClientCalls.map((call) => call.baseUrl)).toEqual([
      "http://127.0.0.1:7881",
      "http://127.0.0.1:7882",
    ]);
    expect(second.getCalls).toEqual([{ sessionID: "ses-reconnect" }]);
    expect(second.interruptCalls).toHaveLength(1);
    expect(second.waitCalls).toEqual([{ sessionID: "ses-reconnect" }]);
    expect(collector.events).toContainEqual(expect.objectContaining({
      event: "turn:end",
      status: "failed",
    }));
    expect(adapter.session.providerMeta).toMatchObject({
      opencode: { serverUrl: "http://127.0.0.1:7882" },
    });
  });

  test("reconnect quiescence retires failed cleanup from an already stopped turn", async () => {
    const cwd = "/workspace/stopped-cleanup-reconnect";
    const native = sessionInfo("ses-stopped-cleanup-reconnect", cwd);
    const first = createFakeClient(native);
    const second = createFakeClient(native);
    first.feed.push(SERVER_CONNECTED);
    second.feed.push({ ...SERVER_CONNECTED, id: "evt-stopped-cleanup-reconnected" });

    const endpoints: Endpoint[] = [
      { url: "http://127.0.0.1:7883" },
      { url: "http://127.0.0.1:7884" },
    ];
    let discoveries = 0;
    const service: OpenCodeV2Dependencies["service"] = {
      discover: async () => endpoints[Math.min(discoveries++, endpoints.length - 1)],
      ensure: async () => {
        throw new Error("ensure should not run when discovery succeeds");
      },
      headers: () => undefined,
    };
    const makeClientCalls: ClientOptions[] = [];
    let nextId = 0;
    first.client.session.pending.cancel = async (input) => {
      first.pendingCancelCalls.push(input);
      throw {
        _tag: "ServiceUnavailable",
        status: 503,
        message: "cleanup outcome is unknown",
      };
    };
    const adapter = new OpenCodeV2Adapter({
      sessionId: "scout-stopped-cleanup-reconnect",
      cwd,
      options: { reconnectDelayMs: 1 },
    }, {
      service,
      makeClient: (options) => {
        makeClientCalls.push(options);
        return options.baseUrl.endsWith(":7883") ? first.client : second.client;
      },
      delay: async () => undefined,
      now: () => "2026-08-11T12:00:00.000Z",
      nextId: () => `stopped-cleanup-${++nextId}`,
    });
    activeAdapters.add(adapter);
    const collector = collectEvents(adapter);
    await adapter.start();

    adapter.send({ sessionId: "scout-stopped-cleanup-reconnect", text: "stop before reconnect" });
    await waitFor(() => first.promptCalls.length === 1, "the prompt before failed cleanup");
    const retainedInputId = first.promptCalls[0]!.id!;
    adapter.interrupt();
    await waitFor(() => first.pendingCancelCalls.length === 1, "the failed cleanup attempt");
    await waitFor(
      () => collector.errors.some((error) => error.message.includes("cleanup outcome is unknown")),
      "the failed cleanup result",
    );

    second.pendingInputs.push({
      id: retainedInputId,
      sessionID: native.id,
      type: "user",
    });
    first.feed.close();

    await waitFor(() => makeClientCalls.length === 2, "the client after cleanup-state reconnect");
    await waitFor(() => second.waitCalls.length === 1, "the cleanup-state recovery wait");
    expect(second.pendingCancelCalls).toEqual([{
      sessionID: native.id,
      inputID: retainedInputId,
    }]);
    expect(second.interruptCalls).toHaveLength(1);
    expect(second.waitCalls).toEqual([{ sessionID: native.id }]);

    adapter.send({ sessionId: "scout-stopped-cleanup-reconnect", text: "prompt after quiescence" });
    await waitFor(() => second.promptCalls.length === 1, "the prompt after cleanup quiescence");
    const nextInputId = second.promptCalls[0]!.id!;
    second.feed.push(inputPromoted(
      "evt-stopped-cleanup-next-promoted",
      native.id,
      nextInputId,
    ));
    second.feed.push(executionSucceeded("evt-stopped-cleanup-next-succeeded", native.id));
    await waitFor(
      () => collector.events.filter((event) => event.event === "turn:end").length === 2,
      "the post-recovery prompt completion",
    );
    expect(collector.events.filter((event) => event.event === "turn:end").at(-1)).toMatchObject({
      status: "completed",
    });
  });

  test("recovers an explicitly resumed session without interrupting shared foreign work", async () => {
    const cwd = "/workspace/resumed-reconnect";
    const native = sessionInfo("ses-resumed-reconnect", cwd);
    const first = createFakeClient(native);
    const second = createFakeClient(native);
    first.feed.push(SERVER_CONNECTED);
    second.feed.push({ ...SERVER_CONNECTED, id: "evt-resumed-reconnected" });

    const endpoints: Endpoint[] = [
      { url: "http://127.0.0.1:7981" },
      { url: "http://127.0.0.1:7982" },
    ];
    let discoveries = 0;
    const service: OpenCodeV2Dependencies["service"] = {
      discover: async () => endpoints[Math.min(discoveries++, endpoints.length - 1)],
      ensure: async () => {
        throw new Error("ensure should not run when discovery succeeds");
      },
      headers: () => undefined,
    };
    let nextId = 0;
    const adapter = new OpenCodeV2Adapter({
      sessionId: "scout-resumed-reconnect",
      cwd,
      options: { sessionId: native.id, reconnectDelayMs: 1 },
    }, {
      service,
      makeClient: (options) => options.baseUrl.endsWith(":7981") ? first.client : second.client,
      delay: async () => undefined,
      now: () => "2026-08-11T12:00:00.000Z",
      nextId: () => `resumed-reconnect-${++nextId}`,
    });
    activeAdapters.add(adapter);
    const collector = collectEvents(adapter);
    await adapter.start();

    adapter.send({ sessionId: "scout-resumed-reconnect", text: "shared resumed turn" });
    await waitFor(() => first.promptCalls.length === 1, "the resumed pre-restart prompt");
    first.feed.push(inputPromoted(
      "evt-resumed-reconnect-promoted",
      native.id,
      first.promptCalls[0]!.id!,
    ));
    await waitFor(() => adapter.session.status === "active", "the resumed input promotion");
    first.feed.close();

    await waitFor(() => second.waitCalls.length === 1, "the resumed-session recovery wait");
    expect(first.interruptCalls).toEqual([]);
    expect(second.interruptCalls).toEqual([]);
    expect(second.pendingCancelCalls).toEqual([]);
    expect(second.waitCalls).toEqual([{ sessionID: native.id }]);
    expect(collector.events).toContainEqual(expect.objectContaining({
      event: "turn:end",
      status: "failed",
    }));
  });
});
