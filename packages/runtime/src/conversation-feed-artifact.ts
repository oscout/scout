import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import {
  compareConversationProjectionItems,
  type ConversationProjectionIdentityRedirect,
  type ConversationProjectionItem,
  type ConversationProjectionSnapshot,
} from "@openscout/protocol";

export const NATIVE_READ_FEED_ARTIFACT_FILENAME = "native-read-feed-v1.json";
export const NATIVE_READ_FEED_ARTIFACT_SCHEMA = "openscout.native.read.feed-cache/v1";
export const NATIVE_READ_FEED_ARTIFACT_VERSION = 1;
export const NATIVE_READ_FEED_MAX_ITEMS = 160;
export const NATIVE_READ_FEED_MAX_BYTES = 256 * 1024;
export const NATIVE_READ_FEED_TARGET_ROW_BYTES = 1_280;
export const NATIVE_READ_FEED_MAX_ROW_BYTES = 2 * 1024;
export const NATIVE_READ_FEED_MAX_REDIRECTS = 160;

const MAX_TRUNCATABLE_FIELD_BYTES = 4 * 1024;

type TruncatableItemKey =
  | "preview"
  | "projectRoot"
  | "title"
  | "agentName"
  | "authorityNodeName"
  | "currentBranch"
  | "alias"
  | "naturalKey"
  | "model"
  | "effort"
  | "harness";

const TRUNCATION_ORDER: readonly TruncatableItemKey[] = [
  "preview",
  "projectRoot",
  "title",
  "agentName",
  "authorityNodeName",
  "currentBranch",
  "alias",
  "naturalKey",
  "model",
  "effort",
  "harness",
];

const NON_TRUNCATABLE_IDENTITY_KEYS = [
  "feedId",
  "conversationId",
  "runtimeSessionId",
  "source",
  "sourceSessionId",
  "agentId",
  "authorityNodeId",
  "parentConversationId",
  "anchorMessageId",
  "lastMessageId",
] as const satisfies readonly (keyof ConversationProjectionItem)[];

export type NativeReadFeedArtifact = {
  schema: typeof NATIVE_READ_FEED_ARTIFACT_SCHEMA;
  version: typeof NATIVE_READ_FEED_ARTIFACT_VERSION;
  projectionId: string;
  projectionVersion: number;
  sequence: number;
  generatedAt: number;
  sourceFreshAt: number | null;
  items: ConversationProjectionItem[];
  total: number;
  hasMore: boolean;
  engagedFeedId: string | null;
  identityRedirects: ConversationProjectionIdentityRedirect[];
};

export type ConversationFeedArtifactPublishResult =
  | {
    status: "written";
    outputPath: string;
    bytes: number;
    itemCount: number;
    artifact: NativeReadFeedArtifact;
  }
  | {
    status: "skipped";
    reason: "identical_projection_cursor";
    outputPath: string;
    projectionId: string;
    sequence: number;
  };

type ProjectionCursor = {
  projectionId: string;
  sequence: number;
};

export class ConversationFeedArtifactSizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversationFeedArtifactSizeError";
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

function boundedNullableText(value: string | null): string | null {
  if (value === null) return null;
  return truncateUtf8(value, MAX_TRUNCATABLE_FIELD_BYTES);
}

function canonicalItem(item: ConversationProjectionItem): ConversationProjectionItem {
  return {
    feedId: item.feedId,
    entityKind: item.entityKind,
    kind: item.kind,
    conversationId: item.conversationId,
    runtimeSessionId: item.runtimeSessionId,
    source: item.source,
    sourceSessionId: item.sourceSessionId,
    title: boundedNullableText(item.title),
    alias: boundedNullableText(item.alias),
    naturalKey: boundedNullableText(item.naturalKey),
    projectRoot: boundedNullableText(item.projectRoot),
    harness: boundedNullableText(item.harness),
    model: boundedNullableText(item.model),
    effort: boundedNullableText(item.effort),
    agentId: item.agentId,
    agentName: boundedNullableText(item.agentName),
    currentBranch: boundedNullableText(item.currentBranch),
    authorityNodeId: item.authorityNodeId,
    authorityNodeName: boundedNullableText(item.authorityNodeName),
    parentConversationId: item.parentConversationId,
    anchorMessageId: item.anchorMessageId,
    activityState: item.activityState,
    lastMessageId: item.lastMessageId,
    lastMessageAt: item.lastMessageAt,
    lastActivityAt: item.lastActivityAt,
    messageCount: item.messageCount,
    unreadCount: item.unreadCount,
    participantCount: item.participantCount,
    preview: boundedNullableText(item.preview),
    lastEngagedAt: item.lastEngagedAt,
    sourceFreshAt: item.sourceFreshAt,
    visibilityState: item.visibilityState,
    updatedSeq: item.updatedSeq,
    updatedAt: item.updatedAt,
  };
}

function fitItemToRowLimit(
  item: ConversationProjectionItem,
  maximumBytes: number,
): ConversationProjectionItem | null {
  for (const key of NON_TRUNCATABLE_IDENTITY_KEYS) {
    const value = item[key];
    if (typeof value === "string" && Buffer.byteLength(value, "utf8") > maximumBytes) {
      return null;
    }
  }

  const fitted = canonicalItem(item);
  if (encodedBytes(fitted) <= maximumBytes) return fitted;

  for (const key of TRUNCATION_ORDER) {
    const original = fitted[key];
    if (original === null) continue;

    fitted[key] = null;
    if (encodedBytes(fitted) > maximumBytes) continue;

    let low = 0;
    let high = original.length;
    let best: string | null = null;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = middle === 0
        ? null
        : `${safeUtf16Prefix(original, middle)}${middle < original.length ? "…" : ""}`;
      fitted[key] = candidate;
      if (encodedBytes(fitted) <= maximumBytes) {
        best = candidate;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    fitted[key] = best;
    return encodedBytes(fitted) <= maximumBytes ? fitted : null;
  }

  return encodedBytes(fitted) <= maximumBytes ? fitted : null;
}

function normalizedRedirects(
  redirects: ConversationProjectionIdentityRedirect[],
  visibleFeedIds: ReadonlySet<string>,
): ConversationProjectionIdentityRedirect[] {
  const seen = new Set<string>();
  return redirects
    .filter((redirect) => visibleFeedIds.has(redirect.toFeedId))
    .sort((left, right) => (
      left.fromFeedId.localeCompare(right.fromFeedId)
      || left.toFeedId.localeCompare(right.toFeedId)
    ))
    .filter((redirect) => {
      const key = `${redirect.fromFeedId}\0${redirect.toFeedId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return encodedBytes(redirect) <= NATIVE_READ_FEED_MAX_ROW_BYTES;
    })
    .slice(0, NATIVE_READ_FEED_MAX_REDIRECTS)
    .map((redirect) => ({
      fromFeedId: redirect.fromFeedId,
      toFeedId: redirect.toFeedId,
    }));
}

function encodedArtifact(artifact: NativeReadFeedArtifact): string {
  return `${JSON.stringify(artifact)}\n`;
}

function artifactBytes(artifact: NativeReadFeedArtifact): number {
  return Buffer.byteLength(encodedArtifact(artifact), "utf8");
}

export function buildNativeReadFeedArtifact(
  snapshot: ConversationProjectionSnapshot,
): NativeReadFeedArtifact {
  const visibleItems = snapshot.items
    .filter((item) => item.visibilityState === "visible")
    .sort(compareConversationProjectionItems);
  const launchItems = visibleItems.slice(0, NATIVE_READ_FEED_MAX_ITEMS);
  const candidateItems = launchItems
    .map((item) => (
      fitItemToRowLimit(item, NATIVE_READ_FEED_TARGET_ROW_BYTES)
      ?? fitItemToRowLimit(item, NATIVE_READ_FEED_MAX_ROW_BYTES)
    ))
    .filter((item): item is ConversationProjectionItem => item !== null);

  const artifact: NativeReadFeedArtifact = {
    schema: NATIVE_READ_FEED_ARTIFACT_SCHEMA,
    version: NATIVE_READ_FEED_ARTIFACT_VERSION,
    projectionId: snapshot.projectionId,
    projectionVersion: snapshot.projectionVersion,
    sequence: snapshot.sequence,
    generatedAt: snapshot.generatedAt,
    sourceFreshAt: snapshot.sourceFreshAt,
    items: [],
    total: snapshot.total,
    hasMore: snapshot.hasMore
      || visibleItems.length > candidateItems.length
      || snapshot.total > candidateItems.length,
    engagedFeedId: snapshot.engagedFeedId
      && Buffer.byteLength(snapshot.engagedFeedId, "utf8") <= NATIVE_READ_FEED_MAX_ROW_BYTES
      ? snapshot.engagedFeedId
      : null,
    identityRedirects: [],
  };

  let encodedSize = artifactBytes(artifact);
  if (encodedSize > NATIVE_READ_FEED_MAX_BYTES) {
    throw new ConversationFeedArtifactSizeError(
      `native feed artifact metadata exceeds ${NATIVE_READ_FEED_MAX_BYTES} bytes`,
    );
  }

  for (const item of candidateItems) {
    const addedBytes = encodedBytes(item) + (artifact.items.length > 0 ? 1 : 0);
    if (encodedSize + addedBytes <= NATIVE_READ_FEED_MAX_BYTES) {
      artifact.items.push(item);
      encodedSize += addedBytes;
      continue;
    }
    artifact.hasMore = true;
    break;
  }

  const visibleFeedIds = new Set(artifact.items.map((item) => item.feedId));
  for (const redirect of normalizedRedirects(snapshot.identityRedirects, visibleFeedIds)) {
    const addedBytes = encodedBytes(redirect) + (artifact.identityRedirects.length > 0 ? 1 : 0);
    if (encodedSize + addedBytes > NATIVE_READ_FEED_MAX_BYTES) continue;
    artifact.identityRedirects.push(redirect);
    encodedSize += addedBytes;
  }

  return artifact;
}

function encodedNativeReadFeedArtifact(snapshot: ConversationProjectionSnapshot): {
  artifact: NativeReadFeedArtifact;
  contents: string;
} {
  const artifact = buildNativeReadFeedArtifact(snapshot);
  const contents = encodedArtifact(artifact);
  if (Buffer.byteLength(contents, "utf8") > NATIVE_READ_FEED_MAX_BYTES) {
    throw new ConversationFeedArtifactSizeError(
      `native feed artifact exceeds ${NATIVE_READ_FEED_MAX_BYTES} bytes`,
    );
  }
  return { artifact, contents };
}

export function serializeNativeReadFeedArtifact(
  snapshot: ConversationProjectionSnapshot,
): string {
  return encodedNativeReadFeedArtifact(snapshot).contents;
}

function readExistingCursor(path: string): ProjectionCursor | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<NativeReadFeedArtifact>;
    if (
      parsed.schema !== NATIVE_READ_FEED_ARTIFACT_SCHEMA
      || parsed.version !== NATIVE_READ_FEED_ARTIFACT_VERSION
      || typeof parsed.projectionId !== "string"
      || typeof parsed.sequence !== "number"
      || !Number.isFinite(parsed.sequence)
    ) {
      return null;
    }
    return { projectionId: parsed.projectionId, sequence: parsed.sequence };
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
  mkdirSync(directory, { recursive: true });
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

export class ConversationFeedArtifactPublisher {
  readonly outputPath: string;
  #publishedCursor: ProjectionCursor | null;

  constructor(outputPath: string) {
    this.outputPath = outputPath;
    this.#publishedCursor = readExistingCursor(outputPath);
  }

  publish(snapshot: ConversationProjectionSnapshot): ConversationFeedArtifactPublishResult {
    if (
      this.#publishedCursor?.projectionId === snapshot.projectionId
      && this.#publishedCursor.sequence === snapshot.sequence
      && existsSync(this.outputPath)
    ) {
      return {
        status: "skipped",
        reason: "identical_projection_cursor",
        outputPath: this.outputPath,
        projectionId: snapshot.projectionId,
        sequence: snapshot.sequence,
      };
    }

    const { artifact, contents } = encodedNativeReadFeedArtifact(snapshot);
    writeAtomically(this.outputPath, contents);
    this.#publishedCursor = {
      projectionId: snapshot.projectionId,
      sequence: snapshot.sequence,
    };
    return {
      status: "written",
      outputPath: this.outputPath,
      bytes: Buffer.byteLength(contents, "utf8"),
      itemCount: artifact.items.length,
      artifact,
    };
  }
}
