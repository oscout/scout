import { mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { MessageRecord } from '@openscout/protocol';
import { HistoryGenerations, type GenerationCapture } from './message-history/generations.js';
import { HistoryAdmission } from './message-history/admission.js';
import { registerAsyncMessageRecordView, type AsyncMessageRecordView, type MessageReadOptions, type MessageSelection, type EncodedHistoryMessage } from './broker-message-records.js';
import { BrokerRecordCacheUnavailable } from './broker-record-reader.js';
type Collection = Record<string, MessageRecord>;
export type BrokerMessageHistoryOptions = {
    snapshotReaders?: number;
    coldReaders?: number;
};
export class BrokerMessageHistory {
    readonly records: Collection;
    private readonly streams: HistoryAdmission;
    private readonly reads: HistoryAdmission;
    private count = 0;
    private lastError: string | null = null;
    private closed = false;
    private captureGate?: <T>(work: () => Promise<T>) => Promise<T>;
    private constructor(private readonly generations: HistoryGenerations, options: BrokerMessageHistoryOptions) { this.streams = new HistoryAdmission(options.snapshotReaders ?? 2); this.reads = new HistoryAdmission(options.coldReaders ?? 4); this.records = this.view(); }
    static async create(journal: string, options: BrokerMessageHistoryOptions = {}) {
        const root = join(dirname(journal), 'message-history');
        await mkdir(root, { recursive: true });
        for (const entry of await readdir(root, { withFileTypes: true })) {
            if (!entry.isDirectory() || !entry.name.startsWith('history-generations-')) continue;
            try { await HistoryGenerations.recoverAbandoned(join(root, entry.name)); }
            catch (error) {
                if (String(error).includes('owner_still_live')) continue;
                console.warn('[broker] Retaining unverified history directory', entry.name, String(error));
            }
        }
        const total = (options.snapshotReaders ?? 2) + (options.coldReaders ?? 4);
        const generations = await HistoryGenerations.create(journal, root, { maxCaptures: total, maxOperations: total + 2 });
        return new BrokerMessageHistory(generations, options);
    }
    private view(capture?: GenerationCapture): Collection {
        // A synchronous consumer must migrate; never silently serve a hot subset.
        const records = new Proxy(Object.create(null) as Collection, { get: (_t, key) => { if (typeof key === 'symbol' || key === 'then')
                return undefined; throw new BrokerRecordCacheUnavailable(`Async message history requires an awaited reader (${String(key)})`); }, ownKeys: () => { throw new BrokerRecordCacheUnavailable('Async message history requires paged enumeration'); }, set: () => { throw new Error('Canonical journal owns message history'); } });
        const adapter: AsyncMessageRecordView = { encoded: (options) => this.iterate(capture, options, true), count: () => capture ? this.generations.count(capture) : this.count, read: (id, options) => this.withView(capture, async (c) => { options?.signal?.throwIfAborted(); const result = await this.generations.get(c, id, options?.signal); options?.signal?.throwIfAborted(); if (result.kind === 'unavailable')
                throw new BrokerRecordCacheUnavailable(result.reason); return result.kind === 'found' ? result.value : undefined; }, options), iterate: (options) => this.iterate(capture, options), withCapture: (run, options) => this.withView(capture, c => run(this.view(c)), options) };
        registerAsyncMessageRecordView(records, adapter);
        return records;
    }
    private async withView<T>(bound: GenerationCapture | undefined, run: (capture: GenerationCapture) => Promise<T>, options?: MessageReadOptions & {
        stream?: boolean;
    }): Promise<T> { options?.signal?.throwIfAborted(); if (bound)
        return run(bound); if (this.closed)
        throw new BrokerRecordCacheUnavailable('History closed'); const release = await (options?.stream ? this.streams : this.reads).acquire(options?.signal); let capture: GenerationCapture | undefined; try {
        options?.signal?.throwIfAborted();
        const start = async () => { capture = await this.generations.capture(); options?.signal?.throwIfAborted(); return { result: run(capture) }; };
        const started = options?.stream && this.captureGate ? await this.captureGate(start) : await start();
        return await started.result;
    }
    finally {
        try {
            if (capture)
                await this.generations.release(capture);
        }
        finally {
            release();
        }
    } }
    private iterate(bound: GenerationCapture | undefined, options?: MessageReadOptions & {stream?: boolean; selection?: MessageSelection}): AsyncIterable<MessageRecord>;
    private iterate(bound: GenerationCapture | undefined, options: MessageReadOptions | undefined, encoded: true): AsyncIterable<EncodedHistoryMessage>;
    private async *iterate(bound: GenerationCapture | undefined, options?: MessageReadOptions & {
        stream?: boolean;
        selection?: MessageSelection;
    }, encoded = false): AsyncIterable<MessageRecord | EncodedHistoryMessage> {
        let release: (() => void) | undefined, capture = bound, closing: Promise<void> | undefined;
        const closeLease = () => closing ??= (async () => { try {
            if (!bound && capture)
                await this.generations.release(capture);
        }
        finally {
            release?.();
        } })();
        const abort = () => { if (!bound && capture)
            void closeLease().catch(() => { }); };
        try {
            options?.signal?.throwIfAborted();
            if (this.closed)
                throw new BrokerRecordCacheUnavailable('History closed');
            if (!capture) {
                release = await (options?.stream ? this.streams : this.reads).acquire(options?.signal);
                options?.signal?.throwIfAborted();
                capture = await this.generations.capture();
            }
            options?.signal?.addEventListener('abort', abort, { once: true });
            options?.signal?.throwIfAborted();
            if (encoded) {
                let cursor: {token: string; id: string}|null = null;
                do {
                    options?.signal?.throwIfAborted();
                    const page = await this.generations.pageEncoded(capture, cursor, options?.signal);
                    if (page.kind !== 'found') throw new BrokerRecordCacheUnavailable(page.kind === 'unavailable' ? page.reason : 'Encoded history page unavailable');
                    cursor = page.value.next;
                    for (const record of page.value.records) { options?.signal?.throwIfAborted(); yield record; }
                } while (cursor);
            } else if (options?.selection) {
                let cursor: {
                    token: string;
                    id: string;
                    createdAt: number;
                } | null = null;
                do {
                    options.signal?.throwIfAborted();
                    const page = await this.generations.pageSelected(capture, options.selection, cursor, options.signal);
                    if (page.kind !== 'found')
                        throw new BrokerRecordCacheUnavailable(page.kind === 'unavailable' ? page.reason : 'History page unavailable');
                    cursor = page.value.next;
                    for (const record of page.value.records) {
                        options.signal?.throwIfAborted();
                        yield record;
                    }
                } while (cursor);
            }
            else {
                let cursor: {
                    token: string;
                    id: string;
                } | null = null;
                do {
                    options?.signal?.throwIfAborted();
                    const page = await this.generations.page(capture, cursor, options?.signal);
                    if (page.kind !== 'found')
                        throw new BrokerRecordCacheUnavailable(page.kind === 'unavailable' ? page.reason : 'History page unavailable');
                    cursor = page.value.next;
                    for (const record of page.value.records) {
                        options?.signal?.throwIfAborted();
                        yield record;
                    }
                } while (cursor);
            }
        }
        finally {
            options?.signal?.removeEventListener('abort', abort);
            await closeLease();
        }
    }
    setCaptureGate(gate: <T>(work: () => Promise<T>) => Promise<T>) { this.captureGate = gate; }
    async refresh() { try {
        await this.generations.refresh();
        this.count = this.generations.count();
        this.lastError = null;
    }
    catch (error) {
        this.lastError = String(error).slice(0, 256);
        throw error;
    } }
    /** Publication failure cannot undo an accepted canonical append. */
    async accepted() { try {
        await this.refresh();
    }
    catch { /* Exposed in status; reads fail explicitly until reconstruction succeeds. */ } }
    status() { return { kind: 'canonical_disk_message_history', count: this.count, lastError: this.lastError, streams: this.streams.status(), reads: this.reads.status(), generations: this.generations.status() }; }
    async close() { this.closed = true; const error = new BrokerRecordCacheUnavailable('History closed'); this.streams.close(error); this.reads.close(error); await this.generations.close(); }
}
