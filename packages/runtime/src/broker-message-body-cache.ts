import { createHash, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { MessageRecord } from "@openscout/protocol";

export type MessageBodyCacheOptions = {
  maxResidentBytes?: number;
  maxResidentBodies?: number;
  minBodyBytes?: number;
  encodedSnapshots?: boolean;
};
type BodyReference = { offset: number; length: number; sha256: string };
const SCRATCH_BYTES = 64 * 1024;
const MAX_READ_SCRATCH_BYTES = 1024 * 1024;

export class BrokerMessageBodyCacheUnavailable extends Error {
  readonly code = "body_cache_unavailable";
  constructor(cause?: unknown) {
    super("Historical message body cache is unavailable; restart reconstructs it from the broker journal", { cause });
    this.name = "BrokerMessageBodyCacheUnavailable";
  }
}

/** Discardable process cache. The broker journal remains the reconstruction source. */
export class BrokerMessageBodyCache {
  private readonly fd: number;
  private readonly maxResidentBytes: number;
  private readonly maxResidentBodies: number;
  private readonly minBodyBytes: number;
  private readonly encodedSnapshots: boolean;
  private writeScratch: Buffer | null = Buffer.allocUnsafe(SCRATCH_BYTES);
  private readScratch: Buffer | null = null;
  private readonly encoder = new TextEncoder();
  private readonly hot = new Map<number, { body: string; bytes: number }>();
  private closed = false;
  private diskBytes = 0;
  private residentBytes = 0;
  private records = 0;
  private hits = 0;
  private misses = 0;
  private decodedJsonUtf8Bytes = 0;
  private decodedBodyCodeUnits = 0;
  private encodedBodyReadBytes = 0;

  constructor(directory: string, options: MessageBodyCacheOptions = {}) {
    this.maxResidentBytes = options.maxResidentBytes ?? 8 * 1024 * 1024;
    this.maxResidentBodies = options.maxResidentBodies ?? 256;
    this.minBodyBytes = options.minBodyBytes ?? 1024;
    this.encodedSnapshots = options.encodedSnapshots ?? false;
    for (const value of [this.maxResidentBytes, this.maxResidentBodies, this.minBodyBytes]) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid message body cache limit");
    }
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `.broker-body-cache-${process.pid}-${randomUUID()}`);
    this.fd = openSync(path, "wx+", 0o600);
    // The descriptor owns the spill file. Exit/crash releases it without a janitor.
    try { unlinkSync(path); } catch (error) { closeSync(this.fd); throw error; }
  }

  prepare(message: MessageRecord): MessageRecord {
    try { return this.prepareBody(message); }
    catch (error) { throw new BrokerMessageBodyCacheUnavailable(error); }
  }

  private prepareBody(message: MessageRecord): MessageRecord {
    if (this.closed) throw new Error("Broker message body cache is closed");
    if (Buffer.byteLength(message.body) < this.minBodyBytes) return message;
    const bodyReference = this.spool(message.body);
    const { body: _body, ...header } = message;
    this.records += 1;
    // Construct the getter in a separate scope that never holds the source body.
    return this.encodedSnapshots ? withEncodedBody(header, this, bodyReference) : withCachedBody(header, this, bodyReference);
  }

  private spool(value: string): BodyReference {
    // JSON encoding preserves lone UTF-16 surrogates as well as ordinary Unicode.
    const encoded = JSON.stringify(value);
    const reference = { offset: this.diskBytes, length: 0, sha256: "" };
    const hash = createHash("sha256");
    let consumed = 0;
    while (consumed < encoded.length) {
      const { read, written } = this.encoder.encodeInto(encoded.slice(consumed), this.writeScratch!);
      if (read === 0 || written === 0) throw new Error("Broker message body encoding made no progress");
      const chunk = this.writeScratch!.subarray(0, written);
      hash.update(chunk);
      let offset = 0;
      while (offset < written) {
        const count = writeSync(this.fd, chunk, offset, written - offset, reference.offset + reference.length + offset);
        if (count <= 0) throw new Error("Broker message body cache write made no progress");
        offset += count;
      }
      consumed += read;
      reference.length += written;
    }
    reference.sha256 = hash.digest("hex");
    this.diskBytes += reference.length;
    return reference;
  }

  read(reference: BodyReference): string {
    try { return this.readBody(reference); }
    catch (error) { throw new BrokerMessageBodyCacheUnavailable(error); }
  }

  private readBody(reference: BodyReference): string {
    if (this.closed) throw new Error("Broker message body cache is unavailable");
    const cached = this.hot.get(reference.offset);
    if (cached) {
      this.hits += 1;
      this.hot.delete(reference.offset);
      this.hot.set(reference.offset, cached);
      return cached.body;
    }
    this.misses += 1;
    const { value: body } = this.readValue(reference);
    if (typeof body !== "string") throw new Error("Broker message body cache contains an invalid body");
    this.decodedBodyCodeUnits += body.length;
    // Conservative character storage estimate, not an exact retained-heap metric.
    const bytes = body.length * 2;
    if (this.maxResidentBodies > 0 && bytes <= this.maxResidentBytes) {
      while (this.hot.size && (this.hot.size >= this.maxResidentBodies || this.residentBytes + bytes > this.maxResidentBytes)) {
        const oldest = this.hot.keys().next().value!;
        this.residentBytes -= this.hot.get(oldest)!.bytes;
        this.hot.delete(oldest);
      }
      this.hot.set(reference.offset, { body, bytes });
      this.residentBytes += bytes;
    }
    return body;
  }

  private readValue(reference: BodyReference): { value: unknown; encodedBytes: number } {
    // Typical bodies share one bounded scratch allocation. A body above the
    // ceiling owns a temporary buffer for that read only; it is never retained.
    let encoded: Buffer;
    if (reference.length <= MAX_READ_SCRATCH_BYTES) {
      if (!this.readScratch || this.readScratch.length < reference.length) {
        this.readScratch = Buffer.allocUnsafe(Math.min(MAX_READ_SCRATCH_BYTES,
          Math.max(SCRATCH_BYTES, reference.length)));
      }
      encoded = this.readScratch.subarray(0, reference.length);
    } else {
      encoded = Buffer.allocUnsafe(reference.length);
    }
    let read = 0;
    while (read < encoded.length) {
      const count = readSync(this.fd, encoded, read, encoded.length - read, reference.offset + read);
      if (count <= 0) throw new Error("Broker message body cache is incomplete");
      read += count;
    }
    if (createHash("sha256").update(encoded).digest("hex") !== reference.sha256) {
      throw new Error("Broker message body cache checksum mismatch");
    }
    this.decodedJsonUtf8Bytes += reference.length;
    return { value: JSON.parse(encoded.toString("utf8")) as unknown, encodedBytes: reference.length };
  }

  encodedReader(reference: BodyReference): EncodedBodyReader {
    let offset = 0;
    const hash = createHash("sha256");
    return {
      get remaining() { return reference.length - offset; },
      readInto: (buffer, start, length) => {
        try {
          if (this.closed) throw new Error("Broker message body cache is closed");
          const count = readSync(this.fd, buffer, start, Math.min(length, reference.length-offset), reference.offset+offset);
          if (count <= 0) throw new Error("Broker message body cache is incomplete");
          hash.update(buffer.subarray(start,start+count));
          offset += count;
          this.encodedBodyReadBytes += count;
          if (offset === reference.length && hash.digest("hex") !== reference.sha256) throw new Error("Broker message body cache checksum mismatch");
          return count;
        } catch (error) { throw new BrokerMessageBodyCacheUnavailable(error); }
      },
    };
  }

  status() {
    return {
      enabled: true, diskBytes: this.diskBytes, spooledBodies: this.records,
      hotBodies: this.hot.size, hotUtf16Bytes: this.residentBytes,
      maxResidentBytes: this.maxResidentBytes, maxResidentBodies: this.maxResidentBodies,
      minBodyBytes: this.minBodyBytes, hits: this.hits, misses: this.misses,
      decodedJsonUtf8Bytes: this.decodedJsonUtf8Bytes, decodedBodyCodeUnits: this.decodedBodyCodeUnits, encodedBodyReadBytes: this.encodedBodyReadBytes,
      encodedSnapshots: this.encodedSnapshots,
      scratchBytes: (this.writeScratch?.length ?? 0) + (this.readScratch?.length ?? 0),
      maxScratchBytes: SCRATCH_BYTES + MAX_READ_SCRATCH_BYTES,
      closed: this.closed,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.writeScratch = null;
    this.readScratch = null;
    this.hot.clear();
    this.residentBytes = 0;
    closeSync(this.fd);
  }
}

function withCachedBody(
  header: Omit<MessageRecord, "body">,
  cache: BrokerMessageBodyCache,
  reference: BodyReference,
): MessageRecord {
  return Object.defineProperty(header, "body", {
    enumerable: true,
    get: () => cache.read(reference),
  }) as MessageRecord;
}



export type EncodedBodyReader = { readonly remaining: number; readInto(buffer: Buffer, start: number, length: number): number };
const encodedBodyCache = Symbol("brokerEncodedBodyCache");
const encodedBodyReference = Symbol("brokerEncodedBodyReference");
type EncodedMessage = MessageRecord & { [encodedBodyCache]: BrokerMessageBodyCache; [encodedBodyReference]: BodyReference };
function readSharedBody(this: EncodedMessage): string { return this[encodedBodyCache].read(this[encodedBodyReference]); }
function withEncodedBody(header: Omit<MessageRecord,"body">, cache: BrokerMessageBodyCache, reference: BodyReference): MessageRecord {
  return Object.defineProperties(header, {
    [encodedBodyCache]: { value: cache },
    [encodedBodyReference]: { value: reference },
    body: { enumerable: true, get: readSharedBody },
  }) as MessageRecord;
}
export function encodedBodyReaderFor(record: unknown): EncodedBodyReader | undefined {
  if (!record || typeof record !== "object" || Object.getOwnPropertyDescriptor(record,"body")?.get !== readSharedBody) return undefined;
  // Preserve ordinary JSON behavior if a caller deliberately supplies toJSON.
  if (typeof (record as {toJSON?:unknown}).toJSON === "function") return undefined;
  const message = record as EncodedMessage;
  return message[encodedBodyCache].encodedReader(message[encodedBodyReference]);
}
