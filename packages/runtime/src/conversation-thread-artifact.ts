import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import {
  scoutConversationFeedId,
  type ConversationThreadLaunchSnapshot,
} from "@openscout/protocol";

export const NATIVE_READ_THREAD_ARTIFACT_DIRECTORY = "native-read-threads-v1";
export const NATIVE_READ_THREAD_ARTIFACT_SCHEMA = "openscout.native.read.thread-cache/v1";
export const NATIVE_READ_THREAD_ARTIFACT_VERSION = 1;
export const NATIVE_READ_THREAD_MAX_BYTES = 256 * 1024;
export const NATIVE_READ_THREAD_MAX_MESSAGES = 64;
export const NATIVE_READ_THREAD_MAX_MESSAGE_BYTES = 32 * 1024;
export const NATIVE_READ_THREAD_MAX_RETAINED = 32;

const ARTIFACT_PREFIX = "native-read-thread-";
const ARTIFACT_SUFFIX = ".json";
const MAX_TEXT_FIELD_BYTES = 4 * 1024;

export type NativeReadThreadArtifact = ConversationThreadLaunchSnapshot & {
  schema: typeof NATIVE_READ_THREAD_ARTIFACT_SCHEMA;
  version: typeof NATIVE_READ_THREAD_ARTIFACT_VERSION;
  /**
   * Digest of the bounded thread page itself. The feed projection sequence can
   * remain unchanged when an older retained message is corrected, so thread
   * replacement needs an independent content identity.
   */
  contentCursor: string;
};

export type ConversationThreadArtifactPublishResult =
  | {
    status: "written";
    outputPath: string;
    bytes: number;
    messageCount: number;
    artifact: NativeReadThreadArtifact;
  }
  | {
    status: "skipped";
    reason: "stale_or_identical_projection_cursor";
    outputPath: string;
    projectionId: string;
    sequence: number;
  };

type ProjectionCursor = {
  projectionId: string;
  sequence: number;
  contentCursor: string | null;
};

export class ConversationThreadArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversationThreadArtifactError";
  }
}

function encodedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function safeUtf16Prefix(value: string, end: number): string {
  let safeEnd = Math.max(0, Math.min(value.length, end));
  if (
    safeEnd > 0
    && safeEnd < value.length
    && value.charCodeAt(safeEnd - 1) >= 0xd800
    && value.charCodeAt(safeEnd - 1) <= 0xdbff
    && value.charCodeAt(safeEnd) >= 0xdc00
    && value.charCodeAt(safeEnd) <= 0xdfff
  ) {
    safeEnd -= 1;
  }
  return value.slice(0, safeEnd);
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  const ellipsis = "…";
  const ellipsisBytes = Buffer.byteLength(ellipsis, "utf8");
  if (maximumBytes <= ellipsisBytes) return "";

  let low = 0;
  let high = value.length;
  let best = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = `${safeUtf16Prefix(value, middle)}${ellipsis}`;
    if (Buffer.byteLength(candidate, "utf8") <= maximumBytes) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function validateBoundedIdentity(label: string, value: string): void {
  if (value.trim().length === 0) {
    throw new ConversationThreadArtifactError(`${label} is empty`);
  }
  if (Buffer.byteLength(value, "utf8") > MAX_TEXT_FIELD_BYTES) {
    throw new ConversationThreadArtifactError(`${label} exceeds ${MAX_TEXT_FIELD_BYTES} bytes`);
  }
}

function validateNonnegativeInteger(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ConversationThreadArtifactError(`${label} must be a nonnegative safe integer`);
  }
}

/** Longest safe prefix of an already oversized body, including its ellipsis.
 * Count JSON string-content bytes directly instead of allocating candidate JSON. */
function truncateJsonBody(value: string, maximumContentBytes: number): string {
  const prefixBudget = maximumContentBytes - 3; // UTF-8 ellipsis
  if (prefixBudget < 0) return "";
  let end = 0;
  let bytes = 0;
  while (end < value.length) {
    const code = value.charCodeAt(end);
    let width = 1;
    let cost: number;
    if (code < 0x20) {
      cost = code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 2 : 6;
    } else if (code === 0x22 || code === 0x5c) {
      cost = 2;
    } else if (code < 0x80) {
      cost = 1;
    } else if (code < 0x800) {
      cost = 2;
    } else if (code >= 0xd800 && code <= 0xdbff
      && value.charCodeAt(end + 1) >= 0xdc00 && value.charCodeAt(end + 1) <= 0xdfff) {
      width = 2;
      cost = 4;
    } else if (code >= 0xd800 && code <= 0xdfff) {
      cost = 6; // Well-formed JSON escapes each unpaired surrogate.
    } else {
      cost = 3;
    }
    if (bytes + cost > prefixBudget) break;
    bytes += cost;
    end += width;
  }
  return `${value.slice(0, end)}…`;
}

function canonicalMessage(
  message: ConversationThreadLaunchSnapshot["messages"][number],
): ConversationThreadLaunchSnapshot["messages"][number] {
  validateBoundedIdentity("message id", message.id);
  validateBoundedIdentity("message actorId", message.actorId);
  validateNonnegativeInteger("message createdAt", message.createdAt);
  const canonical = {
    id: message.id,
    actorId: message.actorId,
    actorName: message.actorName === null
      ? null
      : truncateUtf8(message.actorName, MAX_TEXT_FIELD_BYTES),
    body: message.body,
    class: message.class,
    createdAt: message.createdAt,
  };
  const metadataBytes = encodedBytes({ ...canonical, body: "" });
  if (metadataBytes > NATIVE_READ_THREAD_MAX_MESSAGE_BYTES) {
    throw new ConversationThreadArtifactError(
      `message ${message.id} metadata exceeds ${NATIVE_READ_THREAD_MAX_MESSAGE_BYTES} bytes`,
    );
  }
  const bodyBudget = NATIVE_READ_THREAD_MAX_MESSAGE_BYTES - metadataBytes;
  // JSON escaping can only increase the body's UTF-8 byte cost. Avoid
  // serializing an oversized source body just to establish that it cannot fit.
  if (Buffer.byteLength(message.body, "utf8") <= bodyBudget
    && encodedBytes(canonical) <= NATIVE_READ_THREAD_MAX_MESSAGE_BYTES) return canonical;

  canonical.body = truncateJsonBody(message.body, bodyBudget);
  return canonical;
}

function encodedArtifact(artifact: NativeReadThreadArtifact): string {
  return `${JSON.stringify(artifact)}\n`;
}

function artifactBytes(artifact: NativeReadThreadArtifact): number {
  return Buffer.byteLength(encodedArtifact(artifact), "utf8");
}

function contentCursorForArtifact(
  artifact: Pick<
    NativeReadThreadArtifact,
    "feedId" | "entityKind" | "conversationId" | "cursor" | "hasEarlier" | "messages"
  >,
): string {
  return createHash("sha256")
    .update(JSON.stringify({
      feedId: artifact.feedId,
      entityKind: artifact.entityKind,
      conversationId: artifact.conversationId,
      cursor: artifact.cursor,
      hasEarlier: artifact.hasEarlier,
      messages: artifact.messages,
    }))
    .digest("hex");
}

export function nativeReadThreadArtifactPath(outputDirectory: string, feedId: string): string {
  const digest = createHash("sha256").update(feedId).digest("hex");
  return join(outputDirectory, `${ARTIFACT_PREFIX}${digest}${ARTIFACT_SUFFIX}`);
}

export function buildNativeReadThreadArtifact(
  snapshot: ConversationThreadLaunchSnapshot,
): NativeReadThreadArtifact {
  validateBoundedIdentity("projectionId", snapshot.projectionId);
  validateBoundedIdentity("feedId", snapshot.feedId);
  validateBoundedIdentity("conversationId", snapshot.conversationId);
  validateNonnegativeInteger("projectionVersion", snapshot.projectionVersion);
  validateNonnegativeInteger("sequence", snapshot.sequence);
  validateNonnegativeInteger("generatedAt", snapshot.generatedAt);
  if (snapshot.entityKind !== "scout_conversation") {
    throw new ConversationThreadArtifactError("native thread artifacts only support Scout conversations");
  }
  if (snapshot.feedId !== scoutConversationFeedId(snapshot.conversationId)) {
    throw new ConversationThreadArtifactError("feedId does not identify the supplied Scout conversation");
  }

  const candidates = snapshot.messages
    .slice(-NATIVE_READ_THREAD_MAX_MESSAGES)
    .map(canonicalMessage);
  const artifact: NativeReadThreadArtifact = {
    schema: NATIVE_READ_THREAD_ARTIFACT_SCHEMA,
    version: NATIVE_READ_THREAD_ARTIFACT_VERSION,
    projectionId: snapshot.projectionId,
    projectionVersion: snapshot.projectionVersion,
    sequence: snapshot.sequence,
    feedId: snapshot.feedId,
    entityKind: "scout_conversation",
    conversationId: snapshot.conversationId,
    cursor: null,
    hasEarlier: snapshot.hasEarlier || snapshot.messages.length > candidates.length,
    generatedAt: snapshot.generatedAt,
    messages: [],
    // Keep the final digest's fixed-width storage in every byte-budget check.
    contentCursor: "0".repeat(64),
  };

  let pageBytes = artifactBytes(artifact);
  let cursorBytes = encodedBytes(artifact.cursor);
  if (pageBytes > NATIVE_READ_THREAD_MAX_BYTES) {
    throw new ConversationThreadArtifactError(
      `native thread artifact metadata exceeds ${NATIVE_READ_THREAD_MAX_BYTES} bytes`,
    );
  }

  // Retain a contiguous newest page. Iterating backwards ensures an older
  // oversized row can never evict a newer message from first paint.
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index]!;
    const nextCursorBytes = encodedBytes(candidate.id);
    // Only the inserted message, an optional array comma, and the cursor
    // change. Quote their exact JSON bytes without re-encoding prior bodies.
    const nextPageBytes = pageBytes + encodedBytes(candidate)
      + (artifact.messages.length > 0 ? 1 : 0)
      + nextCursorBytes - cursorBytes;
    artifact.messages.unshift(candidate);
    artifact.cursor = artifact.messages[0]?.id ?? null;
    if (nextPageBytes <= NATIVE_READ_THREAD_MAX_BYTES) {
      pageBytes = nextPageBytes;
      cursorBytes = nextCursorBytes;
      continue;
    }
    artifact.messages.shift();
    artifact.cursor = artifact.messages[0]?.id ?? null;
    artifact.hasEarlier = true;
    break;
  }

  if (artifact.messages.length < candidates.length) {
    artifact.hasEarlier = true;
  }
  artifact.contentCursor = contentCursorForArtifact(artifact);
  return artifact;
}

export function serializeNativeReadThreadArtifact(
  snapshot: ConversationThreadLaunchSnapshot,
): string {
  const serialized = encodedArtifact(buildNativeReadThreadArtifact(snapshot));
  if (Buffer.byteLength(serialized, "utf8") > NATIVE_READ_THREAD_MAX_BYTES) {
    throw new ConversationThreadArtifactError(
      `native thread artifact exceeds ${NATIVE_READ_THREAD_MAX_BYTES} bytes`,
    );
  }
  return serialized;
}

function readExistingCursor(path: string): ProjectionCursor | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<NativeReadThreadArtifact>;
    if (
      parsed.schema !== NATIVE_READ_THREAD_ARTIFACT_SCHEMA
      || parsed.version !== NATIVE_READ_THREAD_ARTIFACT_VERSION
      || typeof parsed.projectionId !== "string"
      || typeof parsed.sequence !== "number"
      || !Number.isFinite(parsed.sequence)
    ) {
      return null;
    }
    return {
      projectionId: parsed.projectionId,
      sequence: parsed.sequence,
      contentCursor: typeof parsed.contentCursor === "string"
        && /^[a-f0-9]{64}$/.test(parsed.contentCursor)
        ? parsed.contentCursor
        : null,
    };
  } catch {
    return null;
  }
}

function writeAtomically(path: string, contents: string): void {
  const directory = dirname(path);
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(temporaryPath, contents, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function retainedArtifactPaths(outputDirectory: string): string[] {
  try {
    return readdirSync(outputDirectory)
      .filter((name) => name.startsWith(ARTIFACT_PREFIX) && name.endsWith(ARTIFACT_SUFFIX))
      .map((name) => join(outputDirectory, name));
  } catch {
    return [];
  }
}

export class ConversationThreadArtifactPublisher {
  readonly outputDirectory: string;
  readonly maximumRetainedArtifacts: number;
  #publishedCursors = new Map<string, ProjectionCursor>();

  constructor(
    outputDirectory: string,
    options: { maximumRetainedArtifacts?: number } = {},
  ) {
    this.outputDirectory = outputDirectory;
    this.maximumRetainedArtifacts = Math.max(
      1,
      Math.floor(options.maximumRetainedArtifacts ?? NATIVE_READ_THREAD_MAX_RETAINED),
    );
  }

  publish(snapshot: ConversationThreadLaunchSnapshot): ConversationThreadArtifactPublishResult {
    const outputPath = nativeReadThreadArtifactPath(this.outputDirectory, snapshot.feedId);
    const existing = this.#publishedCursors.get(outputPath) ?? readExistingCursor(outputPath);
    if (
      existing?.projectionId === snapshot.projectionId
      && existing.sequence > snapshot.sequence
      && existsSync(outputPath)
    ) {
      this.#publishedCursors.set(outputPath, existing);
      return {
        status: "skipped",
        reason: "stale_or_identical_projection_cursor",
        outputPath,
        projectionId: snapshot.projectionId,
        sequence: snapshot.sequence,
      };
    }

    const artifact = buildNativeReadThreadArtifact(snapshot);
    if (
      existing?.projectionId === snapshot.projectionId
      && existing.sequence === snapshot.sequence
      && existing.contentCursor === artifact.contentCursor
      && existsSync(outputPath)
    ) {
      this.#publishedCursors.set(outputPath, existing);
      return {
        status: "skipped",
        reason: "stale_or_identical_projection_cursor",
        outputPath,
        projectionId: snapshot.projectionId,
        sequence: snapshot.sequence,
      };
    }

    const contents = encodedArtifact(artifact);
    if (Buffer.byteLength(contents, "utf8") > NATIVE_READ_THREAD_MAX_BYTES) {
      throw new ConversationThreadArtifactError(
        `native thread artifact exceeds ${NATIVE_READ_THREAD_MAX_BYTES} bytes`,
      );
    }
    writeAtomically(outputPath, contents);
    this.#publishedCursors.set(outputPath, {
      projectionId: snapshot.projectionId,
      sequence: snapshot.sequence,
      contentCursor: artifact.contentCursor,
    });
    this.prune();
    return {
      status: "written",
      outputPath,
      bytes: Buffer.byteLength(contents, "utf8"),
      messageCount: artifact.messages.length,
      artifact,
    };
  }

  prune(): void {
    const retained = retainedArtifactPaths(this.outputDirectory)
      .map((path) => {
        try {
          return { path, modifiedAt: statSync(path).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((entry): entry is { path: string; modifiedAt: number } => entry !== null)
      .sort((left, right) => (
        right.modifiedAt - left.modifiedAt || left.path.localeCompare(right.path)
      ));
    for (const entry of retained.slice(this.maximumRetainedArtifacts)) {
      rmSync(entry.path, { force: true });
      this.#publishedCursors.delete(entry.path);
    }
  }
}
