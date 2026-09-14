// Canonical-backed derived history index. The journal remains the sole writer.
import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import type { MessageRecord, DeliveryIntent } from '@openscout/protocol';
import { readableCanonicalMessage, readableJournalKinds } from '../broker-journal-record-contract.js';
import type { BrokerRecordReadCoverage } from '../broker-record-reader.js';
import { readableDelivery, readableDeliveryStatus, readableMetadata } from '../broker-record-reader.js';
export type Entry = import('../broker-journal.ts').BrokerJournalEntry;
type Kind = 'message' | 'delivery';
type Value = MessageRecord | DeliveryIntent;
type Coverage = {
    identity: string;
    sequence: number;
    endByte: number;
    validated: true;
};
export type Read<T> = {
    kind: 'found';
    value: T;
    coverage: Coverage;
} | {
    kind: 'not_found';
    coverage: Coverage;
} | {
    kind: 'unavailable';
    reason: string;
};
export type Capture = {
    token: string;
    epoch: string;
    sequence: number;
    endByte: number;
    identity: string;
};
type Row = {
    kind: Kind;
    id: string;
    seq: number;
    offset: number;
    length: number;
    sha: string;
    payload: string | null;
    value_sha: string;
    client_key: string | null;
    conversation: string | null;
    actor: string | null;
    target: string | null;
    status: string | null;
};
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
// JSON escaping preserves NUL and lone UTF-16 surrogates across SQLite TEXT.
const indexKey = (value: string) => JSON.stringify(value).slice(1, -1);
const identity = (s: Awaited<ReturnType<typeof stat>>) => `${s.dev}:${s.ino}`;
export const LIMITS = { pageRecords: 64, pageBytes: 256 * 1024, maxLineBytes: 1024 * 1024, hotRecords: 16, hotBytes: 64 * 1024, captures: 2, sqliteCacheKiB: 1024, scanChunkBytes: 64 * 1024, maxIndexKeyBytes: 1024, queuedOperations: 4 } as const;
export class HistoryLeaf {
    private db: Database;
    private file?: FileHandle;
    private ready = false;
    private reason = 'not_ready';
    private epoch = randomUUID();
    private sequence = 0;
    private endByte = 0;
    private sourceIdentity = '';
    private sourceMtime = 0;
    private captures = new Map<string, Capture>();
    private hot = new Map<string, {
        value: Value;
        bytes: number;
    }>();
    private encodedHot = new Map<string, { value: Readonly<{id: string; json: string}>; bytes: number }>();
    private hotBytes = 0;
    private queue: Promise<unknown> = Promise.resolve();
    private sourceDigest = '';
    private suffixRuns = 0;
    private suffixBytes = 0;
    private rebuilds = 0;
    private scanBytes = 0;
    private maxQueued = 0;
    private queued = 0;
    constructor(readonly journalPath: string, readonly indexPath: string, private readonly options: {
        messageScope?: boolean;
        observeAppendOnly?: boolean;
        maxCaptures?: number;
        maxOperations?: number;
    } = {}) {
        this.db = new Database(indexPath, { create: true });
        this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA mmap_size=0; PRAGMA cache_size=-${LIMITS.sqliteCacheKiB}; PRAGMA temp_store=FILE;`);
        this.db.exec('CREATE TABLE IF NOT EXISTS message_fields(id TEXT,seq INTEGER,created_at REAL,conversation TEXT,actor TEXT,reply_to TEXT,client_key TEXT,PRIMARY KEY(id,seq)) WITHOUT ROWID; CREATE INDEX IF NOT EXISTS message_client ON message_fields(client_key,actor,id,seq); CREATE INDEX IF NOT EXISTS message_time ON message_fields(created_at DESC,id,seq); CREATE INDEX IF NOT EXISTS message_conversation ON message_fields(conversation,created_at DESC,id,seq); CREATE INDEX IF NOT EXISTS message_actor ON message_fields(actor,created_at DESC,id,seq); CREATE TABLE IF NOT EXISTS object_order(kind TEXT,id TEXT,group_id INTEGER,position INTEGER,first_seq INTEGER,PRIMARY KEY(kind,id)) WITHOUT ROWID; CREATE INDEX IF NOT EXISTS object_enumeration ON object_order(kind,group_id,position); CREATE TABLE IF NOT EXISTS framing(end_byte INTEGER PRIMARY KEY, sequence INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS versions(kind TEXT,id TEXT,seq INTEGER,offset INTEGER,length INTEGER,sha TEXT,payload TEXT,value_sha TEXT,client_key TEXT,conversation TEXT,actor TEXT,target TEXT,status TEXT,PRIMARY KEY(kind,id,seq)) WITHOUT ROWID; CREATE INDEX IF NOT EXISTS client_keys ON versions(kind,client_key,conversation,actor,id,seq); CREATE INDEX IF NOT EXISTS target_status ON versions(kind,target,status,id,seq);');
    }
    status() { return { ready: this.ready, reason: this.ready ? null : this.reason, sequence: this.sequence, endByte: this.endByte, rebuildSourceDigest: this.sourceDigest, hotRecords: this.hot.size + this.encodedHot.size, hotBytes: this.hotBytes, captures: this.captures.size, limits: LIMITS, historyKeysResident: 0, suffixRuns: this.suffixRuns, suffixBytes: this.suffixBytes, rebuilds: this.rebuilds, scanBytes: this.scanBytes, maxQueued: this.maxQueued, queued: this.queued }; }
    private unavailable(reason: string): {
        kind: 'unavailable';
        reason: string;
    } { return { kind: 'unavailable', reason }; }
    private invalidate(error: unknown) { this.ready = false; this.reason = error instanceof Error ? error.message : String(error); }
    private async serial<T>(run: () => Promise<T>): Promise<T> { if (this.options.messageScope && this.queued >= (this.options.maxOperations ?? LIMITS.queuedOperations))
        throw Error('index_operation_capacity'); this.queued++; this.maxQueued = Math.max(this.maxQueued, this.queued); const result = this.queue.then(run).finally(() => { this.queued--; }); this.queue = result.catch(() => { }); return result; }
    private async serialRead<T>(run: () => Promise<Read<T>>): Promise<Read<T>> { try {
        return await this.serial(run);
    }
    catch (error) {
        return this.unavailable(String(error));
    } }
    private validate(entry: unknown): asserts entry is Entry {
        if (!entry || typeof entry !== 'object')
            throw Error('invalid_entry');
        const e = entry as Entry;
        if (!Object.hasOwn(readableJournalKinds, e.kind))
            throw Error('unsupported_journal_kind');
        if (this.options.messageScope && e.kind !== 'message.record')
            return;
        if (e.kind === 'message.record') {
            const m = e.message;
            if (!readableCanonicalMessage(m))
                throw Error('invalid_message');
        }
        else if (e.kind === 'deliveries.record') {
            if (!Array.isArray(e.deliveries) || !e.deliveries.every(readableDelivery))
                throw Error('invalid_deliveries');
        }
        else if (e.kind === 'delivery.status.update') {
            if (typeof e.deliveryId !== 'string' || !readableDeliveryStatus(e.status) || !readableMetadata(e.metadata) || (e.leaseOwner != null && typeof e.leaseOwner !== 'string') || (e.leaseExpiresAt != null && (!Number.isFinite(e.leaseExpiresAt))))
                throw Error('invalid_delivery_update');
        }
        else
            return;
        const values = e.kind === 'message.record' ? [e.message] : e.kind === 'deliveries.record' ? e.deliveries : [];
        if (this.options.messageScope)
            return;
        for (const value of values) {
            for (const key of ['id', 'actorId', 'conversationId', 'targetId', 'messageId'] as const) {
                const v = (value as unknown as Record<string, unknown>)[key];
                if (typeof v === 'string' && Buffer.byteLength(v) > LIMITS.maxIndexKeyBytes)
                    throw Error('index_key_exceeds_prototype_limit');
            }
            const client = value.metadata?.clientMessageId;
            if (typeof client === 'string' && Buffer.byteLength(client) > LIMITS.maxIndexKeyBytes)
                throw Error('index_key_exceeds_prototype_limit');
        }
    }
    private insert(kind: Kind, value: Value, offset: number, length: number, digest: string) {
        const json = JSON.stringify(value), m = kind === 'message' ? value as MessageRecord : null, d = kind === 'delivery' ? value as DeliveryIntent : null;
        if (!this.options.messageScope && Buffer.byteLength(json) > LIMITS.maxLineBytes)
            throw Error('reduced_record_exceeds_prototype_limit');
        if (m)
            this.db.query('INSERT OR REPLACE INTO message_fields VALUES(?,?,?,?,?,?,?)').run(indexKey(m.id), this.sequence, m.createdAt, indexKey(m.conversationId), indexKey(m.actorId), typeof m.replyToMessageId === 'string' ? indexKey(m.replyToMessageId) : null, typeof m.metadata?.clientMessageId === 'string' ? indexKey(m.metadata.clientMessageId.trim()) : null);
        const numeric = Number(value.id), arrayIndex = Number.isInteger(numeric) && numeric >= 0 && numeric < 4294967295 && String(numeric) === value.id;
        this.db.query('INSERT OR IGNORE INTO object_order VALUES(?,?,?,?,?)').run(kind, indexKey(value.id), arrayIndex ? 0 : 1, arrayIndex ? numeric : this.sequence, this.sequence);
        this.db.query('INSERT OR REPLACE INTO versions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(kind, indexKey(value.id), this.sequence, offset, length, digest, m ? null : json, sha(json), typeof m?.metadata?.clientMessageId === 'string' ? indexKey(m.metadata.clientMessageId) : null, m ? indexKey(m.conversationId) : null, m ? indexKey(m.actorId) : null, d ? indexKey(d.targetId) : null, d?.status ?? null);
    }
    private apply(entry: Entry, offset: number, length: number, digest: string) {
        this.sequence++;
        if (this.options.messageScope && entry.kind !== 'message.record')
            return;
        if (entry.kind === 'message.record')
            this.insert('message', entry.message, offset, length, digest);
        else if (entry.kind === 'deliveries.record')
            for (const d of entry.deliveries)
                this.insert('delivery', d, offset, length, digest);
        else if (entry.kind === 'delivery.status.update') {
            const row = this.db.query("SELECT payload,value_sha FROM versions WHERE kind='delivery' AND id=? ORDER BY seq DESC LIMIT 1").get(indexKey(entry.deliveryId)) as {
                payload: string;
                value_sha: string;
            } | null;
            // Existing journal semantics: status updates for unknown IDs create nothing.
            if (row) {
                if (sha(row.payload) !== row.value_sha)
                    throw Error('index_payload_checksum');
                const old = JSON.parse(row.payload) as DeliveryIntent;
                this.insert('delivery', { ...old, status: entry.status, leaseOwner: entry.leaseOwner ?? undefined, leaseExpiresAt: entry.leaseExpiresAt ?? undefined, metadata: entry.metadata ? { ...old.metadata, ...entry.metadata } : old.metadata }, offset, length, digest);
            }
        }
    }
    async rebuild(boundary?: {
        endByteExclusive: number;
    }): Promise<{
        ready: boolean;
        reason?: string;
        buildMs: number;
    }> {
        return this.serial(async () => {
            const start = performance.now();
            this.rebuilds++;
            this.ready = false;
            this.reason = 'rebuilding';
            this.epoch = randomUUID();
            this.captures.clear();
            this.hot.clear(); this.encodedHot.clear();
            this.hotBytes = 0;
            this.sequence = 0;
            this.endByte = 0;
            try {
                await this.file?.close();
                this.file = await open(this.journalPath, 'r');
                const before = await this.file.stat();
                this.sourceIdentity = identity(before);
                const end = boundary?.endByteExclusive ?? before.size;
                if (!Number.isSafeInteger(end) || end < 0 || end > before.size)
                    throw Error('invalid_rebuild_boundary');
                this.db.exec('DELETE FROM versions; DELETE FROM framing; DELETE FROM object_order; DELETE FROM message_fields; BEGIN; INSERT INTO framing VALUES(0,0)');
                const digest = createHash('sha256');
                await this.scan(0, end, digest);
                const after = await stat(this.journalPath);
                if (identity(after) !== this.sourceIdentity || (this.options.observeAppendOnly ? after.size < end : after.size !== before.size || after.mtimeMs !== before.mtimeMs))
                    throw Error('journal_changed_during_build');
                this.db.exec('COMMIT');
                this.endByte = end;
                this.sourceMtime = after.mtimeMs;
                this.sourceDigest = digest.digest('hex');
                this.ready = true;
                return { ready: true, buildMs: performance.now() - start };
            }
            catch (error) {
                try {
                    this.db.exec('ROLLBACK');
                }
                catch { }
                this.invalidate(error);
                return { ready: false, reason: this.reason, buildMs: performance.now() - start };
            }
        });
    }
    private async scan(start: number, end: number, digest?: ReturnType<typeof createHash>) {
        let position = start, lineOffset = start, parts: Buffer[] = [], length = 0, lines = 0;
        const consume = async (final: boolean) => {
            const raw = parts.length === 1 ? parts[0]! : Buffer.concat(parts, length);
            parts = [];
            length = 0;
            const text = raw.toString('utf8').trim();
            if (text) {
                const entry = JSON.parse(text);
                this.validate(entry);
                this.apply(entry, lineOffset, raw.length, sha(raw));
            }
            lineOffset += raw.length + (final ? 0 : 1);
            this.db.query('INSERT OR REPLACE INTO framing VALUES(?,?)').run(lineOffset, this.sequence);
            if (++lines % 128 === 0)
                await yieldTurn();
        };
        while (position < end) {
            const chunk = Buffer.alloc(Math.min(LIMITS.scanChunkBytes, end - position));
            const { bytesRead } = await this.file!.read(chunk, 0, chunk.length, position);
            if (!bytesRead)
                throw Error('journal_truncated');
            position += bytesRead;
            this.scanBytes += bytesRead;
            digest?.update(chunk.subarray(0, bytesRead));
            let cursor = 0, newline: number;
            while ((newline = chunk.indexOf(10, cursor)) >= 0 && newline < bytesRead) {
                const part = chunk.subarray(cursor, newline);
                parts.push(part);
                length += part.length;
                if (!this.options.messageScope && length > LIMITS.maxLineBytes)
                    throw Error('record_exceeds_prototype_limit');
                await consume(false);
                cursor = newline + 1;
            }
            if (cursor < bytesRead) {
                parts.push(chunk.subarray(cursor, bytesRead));
                length += bytesRead - cursor;
                if (!this.options.messageScope && length > LIMITS.maxLineBytes)
                    throw Error('record_exceeds_prototype_limit');
            }
        }
        if (length)
            await consume(true);
    }
    /** Validate only an append suffix. Existing versions/captures remain in place. */
    async catchUp(coverage: BrokerRecordReadCoverage): Promise<{
        ready: boolean;
        reason?: string;
        bytes: number;
        elapsedMs: number;
    }> {
        return this.serial(async () => {
            const start = performance.now(), previous = this.endByte, sequence = this.sequence;
            let transaction = false;
            try {
                if (!this.ready)
                    throw Error(this.reason);
                const source = await stat(this.journalPath), end = coverage.endByteExclusive;
                if (coverage.source !== 'broker_journal' || coverage.fileIdentity !== this.sourceIdentity || identity(source) !== this.sourceIdentity)
                    throw Error('journal_identity_changed');
                if (!Number.isSafeInteger(end) || end < previous || end > source.size)
                    throw Error('invalid_suffix_boundary');
                if (end === previous)
                    return { ready: true, bytes: 0, elapsedMs: performance.now() - start };
                // A valid EOF without LF cannot simply be followed by another record.
                // Refuse incremental publication; rebuilding rechecks actual framing.
                if (previous) {
                    const tail = Buffer.alloc(1);
                    await this.file!.read(tail, 0, 1, previous - 1);
                    if (tail[0] !== 10)
                        throw Error('suffix_requires_framing_rebuild');
                }
                this.db.exec('BEGIN');
                transaction = true;
                await this.scan(previous, end);
                const after = await stat(this.journalPath);
                if (identity(after) !== this.sourceIdentity || after.size < end)
                    throw Error('journal_changed_during_catchup');
                this.db.exec('COMMIT');
                transaction = false;
                this.endByte = end;
                this.sourceMtime = after.mtimeMs;
                this.suffixRuns++;
                this.suffixBytes += end - previous;
                return { ready: true, bytes: end - previous, elapsedMs: performance.now() - start };
            }
            catch (error) {
                if (transaction)
                    this.db.exec('ROLLBACK');
                this.sequence = sequence;
                // A rolled-back suffix publication does not invalidate the
                // already validated prefix held by existing readers. A new
                // capture still has to catch up successfully in its manager.
                this.reason = String(error);
                return { ready: false, reason: this.reason, bytes: 0, elapsedMs: performance.now() - start };
            }
        });
    }
    private async covered(capture?: Capture): Promise<Coverage> {
        if (!this.ready)
            throw Error(this.reason);
        if (capture && (capture.epoch !== this.epoch || this.captures.get(capture.token) !== capture))
            throw Error('expired_capture');
        try {
            const source = await stat(this.journalPath);
            if (identity(source) !== this.sourceIdentity || (this.options.observeAppendOnly ? source.size < this.endByte : source.size !== this.endByte) || (source.size === this.endByte && source.mtimeMs !== this.sourceMtime))
                throw Error('journal_coverage_changed');
        }
        catch (error) {
            this.invalidate(error);
            throw error;
        }
        return { identity: this.sourceIdentity, sequence: capture?.sequence ?? this.sequence, endByte: capture?.endByte ?? this.endByte, validated: true };
    }
    async capture(): Promise<Read<Capture>> { return this.serialRead(async () => { try {
        const coverage = await this.covered();
        if (this.captures.size >= (this.options.maxCaptures ?? LIMITS.captures))
            return this.unavailable('capture_capacity');
        const c = Object.freeze({ token: randomUUID(), epoch: this.epoch, sequence: coverage.sequence, endByte: coverage.endByte, identity: coverage.identity });
        this.captures.set(c.token, c);
        return { kind: 'found', value: c, coverage };
    }
    catch (e) {
        return this.unavailable(String(e));
    } }); }
    release(capture: Capture) { this.captures.delete(capture.token); }
    /** Immutable encoded records let snapshot readers reuse the validation
     * serialization, without cloning and serializing the same body again. */
    private async messageJson(row: Row, signal?: AbortSignal): Promise<Readonly<{id: string; json: string}>> {
        signal?.throwIfAborted();
        const key = `${row.kind}:${row.id}:${row.seq}`;
        const known = this.encodedHot.get(key);
        if (known) {
            this.encodedHot.delete(key); this.encodedHot.set(key, known);
            return known.value;
        }
        if (row.kind !== 'message' || !Number.isSafeInteger(row.length) || row.length < 1 ||
            !Number.isSafeInteger(row.offset) || row.offset < 0 || row.offset + row.length > this.endByte) {
            throw Error('invalid_index_reference');
        }
        const bytes = Buffer.alloc(row.length);
        let offset = 0;
        while (offset < bytes.length) {
            signal?.throwIfAborted();
            const result = await this.file!.read(bytes, offset, bytes.length-offset, row.offset+offset);
            if (!result.bytesRead) throw Error('journal_truncated');
            offset += result.bytesRead;
        }
        signal?.throwIfAborted();
        if (sha(bytes) !== row.sha) throw Error('canonical_record_checksum');
        const entry = JSON.parse(bytes.toString('utf8').trim());
        this.validate(entry);
        if (entry.kind !== 'message.record') throw Error('index_record_kind');
        const json = JSON.stringify(entry.message);
        if (indexKey(entry.message.id) !== row.id || sha(json) !== row.value_sha) throw Error('index_value_checksum');
        const value = Object.freeze({ id: entry.message.id as string, json });
        const size = Buffer.byteLength(json);
        if (size <= LIMITS.hotBytes) {
            while (this.encodedHot.size && (this.encodedHot.size >= LIMITS.hotRecords || this.hotBytes+size > LIMITS.hotBytes)) {
                const first = this.encodedHot.keys().next().value!;
                this.hotBytes -= this.encodedHot.get(first)!.bytes; this.encodedHot.delete(first);
            }
            this.encodedHot.set(key, { value, bytes: size }); this.hotBytes += size;
        }
        return value;
    }
    private async decode(row: Row, signal?: AbortSignal): Promise<Value> {
        if (this.options.messageScope && row.kind === 'message') {
            return JSON.parse((await this.messageJson(row, signal)).json) as MessageRecord;
        }
        signal?.throwIfAborted();
        const key = `${row.kind}:${row.id}:${row.seq}`, known = this.hot.get(key);
        if (known) {
            this.hot.delete(key);
            this.hot.set(key, known);
            return structuredClone(known.value);
        }
        if (!Number.isSafeInteger(row.length) || row.length < 1 || (!this.options.messageScope && row.length > LIMITS.maxLineBytes) || !Number.isSafeInteger(row.offset) || row.offset < 0 || row.offset + row.length > this.endByte)
            throw Error('invalid_index_reference');
        const bytes = Buffer.alloc(row.length);
        let n = 0;
        while (n < bytes.length) {
            signal?.throwIfAborted();
            const r = await this.file!.read(bytes, n, bytes.length - n, row.offset + n);
            if (!r.bytesRead)
                throw Error('journal_truncated');
            n += r.bytesRead;
        }
        signal?.throwIfAborted();
        if (sha(bytes) !== row.sha)
            throw Error('canonical_record_checksum');
        const entry = JSON.parse(bytes.toString('utf8').trim());
        this.validate(entry);
        if (row.kind === 'delivery' && row.payload === null) {
            const stored = this.db.query('SELECT payload FROM versions WHERE kind=? AND id=? AND seq=?').get(row.kind, row.id, row.seq) as {
                payload: string;
            } | null;
            if (!stored)
                throw Error('index_record_unavailable');
            row.payload = stored.payload;
        }
        const value: Value = row.kind === 'message' && entry.kind === 'message.record' ? entry.message : JSON.parse(row.payload!);
        if (row.kind === 'delivery' && entry.kind === 'delivery.status.update') {
            const d = value as DeliveryIntent;
            d.leaseOwner = entry.leaseOwner ?? undefined;
            d.leaseExpiresAt = entry.leaseExpiresAt ?? undefined;
            if (!Object.hasOwn(d, 'metadata'))
                d.metadata = undefined;
        }
        if (indexKey(value.id) !== row.id || sha(JSON.stringify(value)) !== row.value_sha)
            throw Error('index_value_checksum');
        const size = Buffer.byteLength(JSON.stringify(value));
        if (size <= LIMITS.hotBytes) {
            while (this.hot.size && (this.hot.size >= LIMITS.hotRecords || this.hotBytes + size > LIMITS.hotBytes)) {
                const first = this.hot.keys().next().value!;
                this.hotBytes -= this.hot.get(first)!.bytes;
                this.hot.delete(first);
            }
            this.hot.set(key, { value, bytes: size });
            this.hotBytes += size;
        }
        return structuredClone(value);
    }
    async get<T extends Value>(kind: Kind, id: string, capture?: Capture, signal?: AbortSignal): Promise<Read<T>> { return this.serialRead<T>(async () => { try {
        const coverage = await this.covered(capture);
        const row = this.db.query('SELECT * FROM versions WHERE kind=? AND id=? AND seq<=? ORDER BY seq DESC LIMIT 1').get(kind, indexKey(id), coverage.sequence) as Row | null;
        if (!row)
            return { kind: 'not_found', coverage };
        return { kind: 'found', value: await this.decode(row, signal) as T, coverage };
    }
    catch (e) {
        return this.unavailable(String(e));
    } }); }
    async page(kind: Kind, capture: Capture, after: string | null = null, filter: {
        target?: string;
        statuses?: string[];
    } = {}): Promise<Read<{
        records: Value[];
        next: string | null;
        bytes: number;
    }>> {
        return this.serialRead(async () => {
            try {
                const coverage = await this.covered(capture);
                const args: Array<string | number> = [kind, ...(after === null ? [] : [indexKey(after)]), coverage.sequence, coverage.sequence];
                let extra = '';
                if (filter.target !== undefined) {
                    extra += ' AND v.target=?';
                    args.push(indexKey(filter.target));
                }
                if (filter.statuses?.length) {
                    extra += ` AND v.status IN (${filter.statuses.map(() => '?').join(',')})`;
                    args.push(...filter.statuses);
                }
                const rows = this.db.query(`SELECT v.kind,v.id,v.seq,v.offset,v.length,v.sha,NULL AS payload,v.value_sha FROM versions v WHERE v.kind=? ${after === null ? '' : 'AND v.id>?'} AND v.seq<=? AND NOT EXISTS(SELECT 1 FROM versions n WHERE n.kind=v.kind AND n.id=v.id AND n.seq>v.seq AND n.seq<=?)${extra} ORDER BY v.id LIMIT ${LIMITS.pageRecords + 1}`).all(...args) as Row[];
                const records: Value[] = [];
                let bytes = 0;
                for (const row of rows) {
                    if (records.length === LIMITS.pageRecords)
                        break;
                    const value = await this.decode(row);
                    const size = Buffer.byteLength(JSON.stringify(value));
                    if (records.length && bytes + size > LIMITS.pageBytes)
                        break;
                    records.push(value);
                    bytes += size;
                }
                const more = rows.length > records.length;
                return { kind: 'found', value: { records, next: more ? records.at(-1)!.id : null, bytes }, coverage };
            }
            catch (e) {
                return this.unavailable(String(e));
            }
        });
    }
    /** Baseline production plain-object own-key order: array indices first,
     * then first insertion order. __proto__ assignments are not own properties. */
    async pageProduction(capture: Capture, cursor: {
        token: string;
        id: string;
    } | null = null, signal?: AbortSignal): Promise<Read<{
        records: MessageRecord[];
        next: {
            token: string;
            id: string;
        } | null;
        bytes: number;
    }>> {
        return this.serialRead(async () => {
            try {
                const coverage = await this.covered(capture);
                let group = -1, position = -1;
                if (cursor) {
                    if (cursor.token !== capture.token)
                        throw Error('cursor_capture_mismatch');
                    const order = this.db.query("SELECT group_id,position FROM object_order WHERE kind='message' AND id=? AND id!='__proto__' AND first_seq<=?").get(indexKey(cursor.id), capture.sequence) as {
                        group_id: number;
                        position: number;
                    } | null;
                    if (!order)
                        throw Error('cursor_not_in_capture');
                    group = order.group_id;
                    position = order.position;
                }
                const rows = this.db.query(`SELECT v.kind,v.id,v.seq,v.offset,v.length,v.sha,NULL AS payload,v.value_sha FROM object_order o INDEXED BY object_enumeration JOIN versions v ON v.kind=o.kind AND v.id=o.id AND v.seq=(SELECT MAX(n.seq) FROM versions n WHERE n.kind=o.kind AND n.id=o.id AND n.seq<=?) WHERE o.kind='message' AND o.id!='__proto__' AND o.first_seq<=? AND (o.group_id,o.position)>(?,?) ORDER BY o.group_id,o.position LIMIT ${LIMITS.pageRecords + 1}`).all(capture.sequence, capture.sequence, group, position) as Row[];
                const records: MessageRecord[] = [];
                let bytes = 0;
                for (const row of rows) {
                    if (records.length === LIMITS.pageRecords)
                        break;
                    const value = await this.decode(row, signal) as MessageRecord, size = Buffer.byteLength(JSON.stringify(value));
                    if (records.length && bytes + size > LIMITS.pageBytes)
                        break;
                    records.push(value);
                    bytes += size;
                }
                return { kind: 'found', value: { records, next: rows.length > records.length ? { token: capture.token, id: records.at(-1)!.id } : null, bytes }, coverage };
            }
            catch (error) {
                return this.unavailable(String(error));
            }
        });
    }
    async pageEncoded(capture: Capture, cursor: {
        token: string;
        id: string;
    } | null = null, signal?: AbortSignal): Promise<Read<{
        records: Readonly<{id: string; json: string}>[];
        next: {
            token: string;
            id: string;
        } | null;
        bytes: number;
    }>> {
        return this.serialRead(async () => {
            try {
                const coverage = await this.covered(capture);
                let group = -1, position = -1;
                if (cursor) {
                    if (cursor.token !== capture.token)
                        throw Error('cursor_capture_mismatch');
                    const order = this.db.query("SELECT group_id,position FROM object_order WHERE kind='message' AND id=? AND id!='__proto__' AND first_seq<=?").get(indexKey(cursor.id), capture.sequence) as {
                        group_id: number;
                        position: number;
                    } | null;
                    if (!order)
                        throw Error('cursor_not_in_capture');
                    group = order.group_id;
                    position = order.position;
                }
                const rows = this.db.query(`SELECT v.kind,v.id,v.seq,v.offset,v.length,v.sha,NULL AS payload,v.value_sha FROM object_order o INDEXED BY object_enumeration JOIN versions v ON v.kind=o.kind AND v.id=o.id AND v.seq=(SELECT MAX(n.seq) FROM versions n WHERE n.kind=o.kind AND n.id=o.id AND n.seq<=?) WHERE o.kind='message' AND o.id!='__proto__' AND o.first_seq<=? AND (o.group_id,o.position)>(?,?) ORDER BY o.group_id,o.position LIMIT ${LIMITS.pageRecords + 1}`).all(capture.sequence, capture.sequence, group, position) as Row[];
                const records: Readonly<{id: string; json: string}>[] = [];
                let bytes = 0;
                for (const row of rows) {
                    if (records.length === LIMITS.pageRecords)
                        break;
                    const value = await this.messageJson(row, signal), size = Buffer.byteLength(value.json);
                    if (records.length && bytes + size > LIMITS.pageBytes)
                        break;
                    records.push(value);
                    bytes += size;
                }
                return { kind: 'found', value: { records, next: rows.length > records.length ? { token: capture.token, id: records.at(-1)!.id } : null, bytes }, coverage };
            }
            catch (error) {
                return this.unavailable(String(error));
            }
        });
    }
    countMessages(capture?: Capture): number { return (this.db.query("SELECT COUNT(*) AS count FROM object_order WHERE kind='message' AND id!='__proto__' AND first_seq<=?").get(capture?.sequence ?? this.sequence) as {
        count: number;
    }).count; }
    async pageSelected(capture: Capture, selection: import('../broker-message-records.js').MessageSelection, cursor: {
        token: string;
        id: string;
        createdAt: number;
    } | null = null, signal?: AbortSignal): Promise<Read<{
        records: MessageRecord[];
        next: {
            token: string;
            id: string;
            createdAt: number;
        } | null;
        bytes: number;
    }>> {
        return this.serialRead(async () => {
            try {
                signal?.throwIfAborted();
                const coverage = await this.covered(capture);
                let where = "o.id!='__proto__' AND o.first_seq<=?", args: Array<string | number> = [capture.sequence];
                if (selection.conversationIds) {
                    if (!selection.conversationIds.length)
                        return { kind: 'found', value: { records: [], next: null, bytes: 0 }, coverage };
                    where += ` AND f.conversation IN (${selection.conversationIds.map(() => '?').join(',')})`;
                    args.push(...selection.conversationIds.map(indexKey));
                }
                if (selection.clientMessageId !== undefined) {
                    where += ' AND f.client_key=?';
                    args.push(indexKey(selection.clientMessageId));
                }
                if (selection.actorId !== undefined) {
                    where += ' AND f.actor=?';
                    args.push(indexKey(selection.actorId));
                }
                if (selection.replyToMessageId !== undefined) {
                    where += ' AND f.reply_to=?';
                    args.push(indexKey(selection.replyToMessageId));
                }
                if (selection.since !== undefined) {
                    where += ' AND f.created_at>=?';
                    args.push(selection.since);
                }
                if (cursor) {
                    if (cursor.token !== capture.token)
                        throw Error('cursor_capture_mismatch');
                    const order = this.db.query("SELECT group_id,position FROM object_order WHERE kind='message' AND id=? AND first_seq<=?").get(indexKey(cursor.id), capture.sequence) as {
                        group_id: number;
                        position: number;
                    } | null;
                    if (!order)
                        throw Error('cursor_not_in_capture');
                    if (selection.newestFirst) {
                        where += ' AND (f.created_at<? OR(f.created_at=? AND (o.group_id,o.position)>(?,?)))';
                        args.push(cursor.createdAt, cursor.createdAt, order.group_id, order.position);
                    }
                    else {
                        where += ' AND (o.group_id,o.position)>(?,?)';
                        args.push(order.group_id, order.position);
                    }
                }
                const rows = this.db.query(`SELECT v.* FROM message_fields f JOIN versions v ON v.kind='message' AND v.id=f.id AND v.seq=f.seq JOIN object_order o ON o.kind=v.kind AND o.id=v.id WHERE ${where} AND f.seq=(SELECT MAX(n.seq) FROM versions n WHERE n.kind='message' AND n.id=f.id AND n.seq<=?) ORDER BY ${selection.newestFirst ? 'f.created_at DESC,' : ''}o.group_id,o.position LIMIT ${LIMITS.pageRecords + 1}`).all(...args, capture.sequence) as Row[];
                const records: MessageRecord[] = [];
                let bytes = 0;
                for (const row of rows) {
                    if (records.length === LIMITS.pageRecords)
                        break;
                    const value = await this.decode(row, signal) as MessageRecord, size = Buffer.byteLength(JSON.stringify(value));
                    if (records.length && bytes + size > LIMITS.pageBytes)
                        break;
                    records.push(value);
                    bytes += size;
                }
                const last = records.at(-1);
                return { kind: 'found', value: { records, next: rows.length > records.length && last ? { token: capture.token, id: last.id, createdAt: last.createdAt } : null, bytes }, coverage };
            }
            catch (error) {
                return this.unavailable(String(error));
            }
        });
    }
    async findClientMessage(conversation: string, actor: string, key: string, capture?: Capture): Promise<Read<MessageRecord>> {
        return this.serialRead<MessageRecord>(async () => {
            try {
                const coverage = await this.covered(capture);
                const rows = this.db.query("SELECT v.* FROM versions v INDEXED BY client_keys WHERE v.kind='message' AND v.client_key=? AND v.conversation=? AND v.actor=? AND v.seq<=? AND NOT EXISTS(SELECT 1 FROM versions n WHERE n.kind=v.kind AND n.id=v.id AND n.seq>v.seq AND n.seq<=?) LIMIT 2").all(indexKey(key), indexKey(conversation), indexKey(actor), coverage.sequence, coverage.sequence) as Row[];
                if (rows.length > 1)
                    return this.unavailable('ambiguous_client_key');
                if (!rows.length)
                    return { kind: 'not_found', coverage };
                return { kind: 'found', value: await this.decode(rows[0]!) as MessageRecord, coverage };
            }
            catch (e) {
                return this.unavailable(String(e));
            }
        });
    }
    /** Shadow-only read at an already validated canonical reader boundary. */
    async getAtCanonicalCoverage(id: string, coverage: BrokerRecordReadCoverage): Promise<Read<MessageRecord>> {
        return this.serialRead<MessageRecord>(async () => {
            try {
                if (!this.options.messageScope)
                    throw Error('message_scope_required');
                if (!this.ready)
                    throw Error(this.reason);
                if (coverage.source !== 'broker_journal' || coverage.fileIdentity !== this.sourceIdentity || coverage.endByteExclusive > this.endByte)
                    throw Error('shadow_coverage_not_ready');
                const boundary = this.db.query('SELECT sequence FROM framing WHERE end_byte=?').get(coverage.endByteExclusive) as {
                    sequence: number;
                } | null;
                if (!boundary)
                    throw Error('unvalidated_byte_boundary');
                const source = await stat(this.journalPath);
                if (identity(source) !== this.sourceIdentity || source.size < this.endByte || (source.size === this.endByte && source.mtimeMs !== this.sourceMtime)) {
                    this.invalidate(Error('journal_coverage_changed'));
                    throw Error(this.reason);
                }
                const mapped = { identity: this.sourceIdentity, sequence: boundary.sequence, endByte: coverage.endByteExclusive, validated: true as const };
                const row = this.db.query("SELECT * FROM versions WHERE kind='message' AND id=? AND seq<=? ORDER BY seq DESC LIMIT 1").get(indexKey(id), boundary.sequence) as Row | null;
                if (!row)
                    return { kind: 'not_found', coverage: mapped };
                return { kind: 'found', value: await this.decode(row) as MessageRecord, coverage: mapped };
            }
            catch (e) {
                return this.unavailable(String(e));
            }
        });
    }
    // Test-only canonical writer. Serialized eligibility and append precede index publication.
    async appendForExperiment(entry: Entry): Promise<{
        accepted: boolean;
        ready: boolean;
        writeOutcome?: string;
        reason?: string;
    }> { return this.serial(() => this.appendOwned(entry)); }
    private async appendOwned(entry: Entry) {
        let accepted = false, attempted = false;
        try {
            await this.covered();
            const encoded = Buffer.from(JSON.stringify(entry));
            if (!this.options.messageScope && encoded.length > LIMITS.maxLineBytes)
                throw Error('record_exceeds_prototype_limit');
            const canonical = JSON.parse(encoded.toString());
            this.validate(canonical);
            const writer = await open(this.journalPath, 'a');
            try {
                attempted = true;
                await writer.writeFile(Buffer.concat([encoded, Buffer.from('\n')]));
                await writer.sync();
                accepted = true;
            }
            finally {
                await writer.close();
            }
            const previous = this.endByte, source = await stat(this.journalPath);
            this.endByte = source.size;
            this.sourceMtime = source.mtimeMs;
            this.db.exec('BEGIN');
            this.apply(canonical, previous, encoded.length, sha(encoded));
            this.db.query('INSERT OR REPLACE INTO framing VALUES(?,?)').run(this.endByte, this.sequence);
            this.db.exec('COMMIT');
            return { accepted: true, ready: true };
        }
        catch (e) {
            try {
                this.db.exec('ROLLBACK');
            }
            catch { }
            if (attempted)
                this.invalidate(e);
            return { accepted, ready: this.ready, writeOutcome: attempted && !accepted ? 'unconfirmed' : accepted ? 'durable' : 'not_attempted', reason: String(e) };
        }
    }
    async updateDeliveryIf(id: string, predicate: (record: DeliveryIntent) => boolean, update: Omit<Extract<Entry, {
        kind: 'delivery.status.update';
    }>, 'kind' | 'deliveryId'>): Promise<{
        changed: boolean;
        accepted?: boolean;
        reason?: string;
    }> {
        return this.serial(async () => {
            try {
                await this.covered();
                const row = this.db.query("SELECT * FROM versions WHERE kind='delivery' AND id=? ORDER BY seq DESC LIMIT 1").get(indexKey(id)) as Row | null;
                if (!row)
                    return { changed: false };
                const value = await this.decode(row) as DeliveryIntent;
                if (!predicate(value))
                    return { changed: false };
                const result = await this.appendOwned({ kind: 'delivery.status.update', deliveryId: id, ...update });
                return { changed: result.accepted, ...result };
            }
            catch (e) {
                return { changed: false, reason: String(e) };
            }
        });
    }
    async close() { await this.queue; this.ready = false; this.reason = 'closed'; this.captures.clear(); this.hot.clear(); this.encodedHot.clear(); this.hotBytes = 0; await this.file?.close(); this.file = undefined; this.db.close(); }
}
