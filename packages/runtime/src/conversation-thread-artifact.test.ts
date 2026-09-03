import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import type { ConversationThreadLaunchSnapshot } from "@openscout/protocol";

import {
  buildNativeReadThreadArtifact,
  ConversationThreadArtifactError,
  ConversationThreadArtifactPublisher,
  nativeReadThreadArtifactPath,
  NATIVE_READ_THREAD_ARTIFACT_SCHEMA,
  NATIVE_READ_THREAD_ARTIFACT_VERSION,
  NATIVE_READ_THREAD_MAX_BYTES,
  NATIVE_READ_THREAD_MAX_MESSAGE_BYTES,
  serializeNativeReadThreadArtifact,
  type NativeReadThreadArtifact,
} from "./conversation-thread-artifact.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "openscout-thread-artifact-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function snapshot(
  conversationId = "conversation-1",
  overrides: Partial<ConversationThreadLaunchSnapshot> = {},
): ConversationThreadLaunchSnapshot {
  return {
    projectionId: "projection-1",
    projectionVersion: 1,
    sequence: 7,
    feedId: `conv:${conversationId}`,
    entityKind: "scout_conversation",
    conversationId,
    cursor: "message-1",
    hasEarlier: false,
    generatedAt: 2_000,
    messages: [
      {
        id: "message-1",
        actorId: "operator",
        actorName: "Operator",
        body: "hello",
        class: "agent",
        createdAt: 1_000,
      },
    ],
    ...overrides,
  };
}

describe("ConversationThreadArtifactPublisher", () => {
  test("atomically publishes by hashed feed identity and rejects stale same-lineage writes", () => {
    const outputDirectory = temporaryDirectory();
    const input = snapshot("../../not-a-path");
    const outputPath = nativeReadThreadArtifactPath(outputDirectory, input.feedId);
    expect(outputPath.startsWith(`${outputDirectory}/native-read-thread-`)).toBe(true);
    expect(outputPath).not.toContain("not-a-path");

    const publisher = new ConversationThreadArtifactPublisher(outputDirectory);
    const first = publisher.publish(input);
    const firstInode = statSync(outputPath, { bigint: true }).ino;
    expect(first.status).toBe("written");
    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toMatchObject({
      schema: NATIVE_READ_THREAD_ARTIFACT_SCHEMA,
      version: NATIVE_READ_THREAD_ARTIFACT_VERSION,
      projectionId: "projection-1",
      sequence: 7,
      feedId: "conv:../../not-a-path",
      entityKind: "scout_conversation",
      conversationId: "../../not-a-path",
      contentCursor: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    const restarted = new ConversationThreadArtifactPublisher(outputDirectory);
    expect(restarted.publish({ ...input, sequence: 6 })).toMatchObject({
      status: "skipped",
      reason: "stale_or_identical_projection_cursor",
    });
    expect(statSync(outputPath, { bigint: true }).ino).toBe(firstInode);

    expect(restarted.publish(input)).toMatchObject({
      status: "skipped",
      reason: "stale_or_identical_projection_cursor",
    });
    expect(statSync(outputPath, { bigint: true }).ino).toBe(firstInode);

    const replacement = restarted.publish({ ...input, sequence: 8 });
    expect(replacement.status).toBe("written");
    expect(statSync(outputPath, { bigint: true }).ino).not.toBe(firstInode);
  });

  test("replaces a corrected retained message at the same feed projection sequence", () => {
    const outputDirectory = temporaryDirectory();
    const publisher = new ConversationThreadArtifactPublisher(outputDirectory);
    const input = snapshot("corrected", {
      messages: [
        { ...snapshot().messages[0]!, id: "message-old", body: "before", createdAt: 1_000 },
        { ...snapshot().messages[0]!, id: "message-latest", body: "latest", createdAt: 2_000 },
      ],
    });
    const outputPath = nativeReadThreadArtifactPath(outputDirectory, input.feedId);

    const first = publisher.publish(input);
    expect(first.status).toBe("written");
    const firstArtifact = JSON.parse(readFileSync(outputPath, "utf8")) as NativeReadThreadArtifact;

    const corrected = publisher.publish({
      ...input,
      generatedAt: input.generatedAt + 1,
      messages: input.messages.map((message) => (
        message.id === "message-old" ? { ...message, body: "after" } : message
      )),
    });
    expect(corrected.status).toBe("written");
    const correctedArtifact = JSON.parse(
      readFileSync(outputPath, "utf8"),
    ) as NativeReadThreadArtifact;
    expect(correctedArtifact.sequence).toBe(firstArtifact.sequence);
    expect(correctedArtifact.contentCursor).not.toBe(firstArtifact.contentCursor);
    expect(correctedArtifact.messages.map((message) => message.body)).toEqual(["after", "latest"]);

    expect(publisher.publish({ ...input, sequence: input.sequence - 1 })).toMatchObject({
      status: "skipped",
      reason: "stale_or_identical_projection_cursor",
    });
    expect((JSON.parse(readFileSync(outputPath, "utf8")) as NativeReadThreadArtifact)
      .contentCursor).toBe(correctedArtifact.contentCursor);
  });

  test("keeps one bounded contiguous newest page and adjusts the paging cursor", () => {
    const messages = Array.from({ length: 90 }, (_, index) => ({
      id: `message-${String(index).padStart(3, "0")}`,
      actorId: "agent-1",
      actorName: "Agent One",
      body: `${index}:${"🧭".repeat(20_000)}`,
      class: "agent",
      createdAt: 1_000 + index,
    } as const));
    const serialized = serializeNativeReadThreadArtifact(snapshot("bounded", {
      cursor: messages[0]!.id,
      messages,
    }));
    const artifact = JSON.parse(serialized) as NativeReadThreadArtifact;

    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(NATIVE_READ_THREAD_MAX_BYTES);
    expect(artifact.messages.length).toBeGreaterThan(0);
    expect(artifact.messages.length).toBeLessThan(64);
    expect(artifact.messages.at(-1)?.id).toBe("message-089");
    expect(artifact.cursor).toBe(artifact.messages[0]?.id);
    expect(artifact.hasEarlier).toBe(true);
    expect(artifact.messages.every((message) => (
      Buffer.byteLength(JSON.stringify(message), "utf8") <= NATIVE_READ_THREAD_MAX_MESSAGE_BYTES
    ))).toBe(true);

    const escaped = buildNativeReadThreadArtifact(snapshot("escaped", {
      messages: [{
        ...snapshot().messages[0]!,
        body: "\"\\\n".repeat(50_000),
      }],
    }));
    expect(Buffer.byteLength(JSON.stringify(escaped.messages[0]), "utf8"))
      .toBeLessThanOrEqual(NATIVE_READ_THREAD_MAX_MESSAGE_BYTES);
    expect(escaped.messages[0]?.body.endsWith("…")).toBe(true);
  });

  test("refuses observed-session or mismatched feed identity coercion", () => {
    expect(() => buildNativeReadThreadArtifact({
      ...snapshot(),
      entityKind: "observed_session" as "scout_conversation",
      feedId: "obs:codex:session-1",
    })).toThrow(ConversationThreadArtifactError);
    expect(() => buildNativeReadThreadArtifact({
      ...snapshot(),
      feedId: "conv:other",
    })).toThrow("feedId does not identify");
  });

  test("prunes only owned artifacts to the configured retention budget", () => {
    const outputDirectory = temporaryDirectory();
    const publisher = new ConversationThreadArtifactPublisher(outputDirectory, {
      maximumRetainedArtifacts: 2,
    });
    publisher.publish(snapshot("one", { sequence: 1 }));
    publisher.publish(snapshot("two", { sequence: 2 }));
    publisher.publish(snapshot("three", { sequence: 3 }));
    writeFileSync(join(outputDirectory, "unrelated.json"), "{}\n", "utf8");
    publisher.prune();

    const names = readdirSync(outputDirectory);
    expect(names.filter((name) => name.startsWith("native-read-thread-"))).toHaveLength(2);
    expect(names).toContain("unrelated.json");
  });
});
