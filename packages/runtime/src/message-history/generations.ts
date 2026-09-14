// Captures pin source generations and derived indexes without full ID maps.
import { mkdtemp, mkdir, link, stat, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { HistoryLeaf, type Capture, type Read } from './store.js';
import type { MessageRecord } from '@openscout/protocol';
import type { BrokerRecordReadCoverage } from '../broker-record-reader.js';
type Generation = {
    id: number;
    root: string;
    leaf: HistoryLeaf;
    identity: string;
    refs: number;
};
export type GenerationCapture = Readonly<{
    id: string;
    generation: number;
    capture: Capture;
}>;
export class HistoryGenerations {
    private generations = new Map<number, Generation>();
    private captures = new Map<string, GenerationCapture>();
    private current?: Generation;
    private sequence = 0;
    private closed = false;
    private lifecycle: Promise<unknown> = Promise.resolve();
    private pending = 0;
    private releasing = new Map<string, Promise<void>>();
    private maxGenerations = 0;
    private released = 0;
    private cleanupErrors = 0;
    private lastCleanupError: string | undefined;
    private constructor(readonly journal: string, readonly root: string, private readonly options: {
        maxCaptures?: number;
        maxOperations?: number;
    } = {}) { }
    static async create(journal: string, parent: string, options: {
        maxCaptures?: number;
        maxOperations?: number;
    } = {}) { const root = await mkdtemp(join(parent, 'history-generations-')); await writeFile(join(root, 'owner.json'), JSON.stringify({ magic: 'scout-owned-history-generations-v1', pid: process.pid })); return new HistoryGenerations(journal, root, options); }
    // Fail closed for a live/reused PID or unknown directory content. Only this
    // experiment's private links/indexes are removed; canonical journal is outside.
    static async recoverAbandoned(root: string) { if (!basename(root).startsWith('history-generations-'))
        throw Error('not_owned_root'); const owner = JSON.parse(await readFile(join(root, 'owner.json'), 'utf8')); if (owner.magic !== 'scout-owned-history-generations-v1' || !Number.isSafeInteger(owner.pid) || owner.pid <= 0)
        throw Error('invalid_owner'); try {
        process.kill(owner.pid, 0);
        throw Error('owner_still_live');
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ESRCH')
            throw e;
    } for (const name of await readdir(root)) {
        if (name !== 'owner.json' && !/^g-\d+$/.test(name))
            throw Error('unknown_owned_content');
    } await rm(root, { recursive: true }); }
    private async serial<T>(run: () => Promise<T>, cleanup = false) { if (!cleanup && this.pending >= (this.options.maxOperations ?? 4))
        throw Error('diagnostic_lifecycle_capacity'); this.pending++; const result = this.lifecycle.then(run).finally(() => this.pending--); this.lifecycle = result.catch(() => { }); return result; }
    private async discard(g: Generation) { await g.leaf.close(); await rm(g.root, { recursive: true, force: true }); this.generations.delete(g.id); if (this.current === g)
        this.current = undefined; }
    private async ensure() {
        if (this.closed)
            throw Error('closed');
        for (const g of [...this.generations.values()])
            if (g !== this.current && !g.refs)
                await this.discard(g);
        const source = await stat(this.journal), identity = `${source.dev}:${source.ino}`;
        if (this.current?.identity === identity) {
            const c: BrokerRecordReadCoverage = { source: 'broker_journal', fileIdentity: identity, endByteExclusive: source.size };
            const caught = await this.current.leaf.catchUp(c);
            if (caught.ready)
                return this.current;
            if (this.current.refs)
                throw Error('current_generation_unavailable');
            await this.discard(this.current);
        }
        if (this.current && !this.current.refs)
            await this.discard(this.current);
        const id = ++this.sequence, root = join(this.root, `g-${id}`);
        await mkdir(root);
        let leaf: HistoryLeaf | undefined;
        try {
            await link(this.journal, join(root, 'journal.jsonl'));
            const linked = await stat(join(root, 'journal.jsonl'));
            if (`${linked.dev}:${linked.ino}` !== identity)
                throw Error('source_changed_during_pin');
            leaf = new HistoryLeaf(join(root, 'journal.jsonl'), join(root, 'index.sqlite'), { messageScope: true, observeAppendOnly: true, ...this.options });
            const built = await leaf.rebuild({ endByteExclusive: source.size });
            if (!built.ready)
                throw Error(built.reason);
            const g = { id, root, leaf, identity, refs: 0 };
            this.generations.set(id, g);
            this.current = g;
            this.maxGenerations = Math.max(this.maxGenerations, this.generations.size);
            return g;
        }
        catch (e) {
            await leaf?.close();
            await rm(root, { recursive: true, force: true });
            throw e;
        }
    }
    async capture(): Promise<GenerationCapture> { return this.serial(async () => { if (this.captures.size >= (this.options.maxCaptures ?? 2))
        throw Error('diagnostic_capture_capacity'); const g = await this.ensure(), c = await g.leaf.capture(); if (c.kind !== 'found')
        throw Error('capture_unavailable'); const capture = Object.freeze({ id: c.value.token, generation: g.id, capture: c.value }); this.captures.set(capture.id, capture); g.refs++; return capture; }); }
    async refresh() { return this.serial(async () => { await this.ensure(); return this.status(); }); }
    private generation(c: GenerationCapture) { if (this.captures.get(c.id) !== c)
        throw Error('expired_generation_capture'); const g = this.generations.get(c.generation); if (!g)
        throw Error('generation_missing'); return g; }
    async get(c: GenerationCapture, id: string, signal?: AbortSignal): Promise<Read<MessageRecord>> { try {
        return await this.generation(c).leaf.get<MessageRecord>('message', id, c.capture, signal);
    }
    catch (e) {
        return { kind: 'unavailable', reason: String(e) };
    } }
    async page(c: GenerationCapture, cursor: {
        token: string;
        id: string;
    } | null = null, signal?: AbortSignal) { return this.generation(c).leaf.pageProduction(c.capture, cursor, signal); }
    async pageEncoded(c: GenerationCapture, cursor: {token: string; id: string}|null = null, signal?: AbortSignal) {
        return this.generation(c).leaf.pageEncoded(c.capture, cursor, signal);
    }
    count(c?: GenerationCapture) { return c ? this.generation(c).leaf.countMessages(c.capture) : this.current?.leaf.countMessages() ?? 0; }
    async pageSelected(c: GenerationCapture, selection: import('../broker-message-records.js').MessageSelection, cursor: {
        token: string;
        id: string;
        createdAt: number;
    } | null = null, signal?: AbortSignal) { return this.generation(c).leaf.pageSelected(c.capture, selection, cursor, signal); }
    release(c: GenerationCapture): Promise<void> { const pending = this.releasing.get(c.id); if (pending)
        return pending; if (this.captures.get(c.id) !== c)
        return Promise.resolve(); const result = this.serial(async () => { if (this.captures.get(c.id) !== c)
        return; const g = this.generation(c); this.captures.delete(c.id); g.leaf.release(c.capture); g.refs--; this.released++; if (!g.refs) {
        const live = g === this.current ? await stat(this.journal).then(s => `${s.dev}:${s.ino}` === g.identity).catch(() => true) : false;
        if (!live)
            await this.discard(g);
    } }, true).catch(error => { this.cleanupErrors++; this.lastCleanupError = String(error).slice(0, 256); throw error; }).finally(() => this.releasing.delete(c.id)); this.releasing.set(c.id, result); return result; }
    // Acquires lazily; completion, consumer return(), exception and AbortSignal
    // release the pin. Abort also releases a generator suspended after a yield.
    async *pages(signal?: AbortSignal) { let c: GenerationCapture | undefined; let release: Promise<void> | undefined; const abort = () => { if (c) {
        release = this.release(c);
        void release.catch(() => { });
    } }; try {
        if (signal?.aborted)
            throw Error('aborted');
        c = await this.capture();
        signal?.addEventListener('abort', abort, { once: true });
        let cursor: {
            token: string;
            id: string;
        } | null = null;
        do {
            if (signal?.aborted)
                throw Error('aborted');
            const page = await this.page(c, cursor);
            if (page.kind !== 'found')
                throw Error(page.kind === 'unavailable' ? page.reason : 'page_unavailable');
            if (signal?.aborted)
                throw Error('aborted');
            cursor = page.value.next;
            yield page.value.records;
        } while (cursor !== null);
    }
    finally {
        signal?.removeEventListener('abort', abort);
        if (release)
            await release;
        else if (c)
            await this.release(c);
    } }
    async diskUsage() { let journalBytes = 0, indexBytes = 0; const rows = []; for (const g of this.generations.values()) {
        const journal = await stat(join(g.root, 'journal.jsonl')), index = await stat(join(g.root, 'index.sqlite'));
        journalBytes += journal.size;
        indexBytes += index.size;
        rows.push({ generation: g.id, refs: g.refs, current: g === this.current, journalBytes: journal.size, indexBytes: index.size });
    } return { journalBytes, indexBytes, rows, note: 'Logical lengths of pinned inodes and index files; not APFS physical reclaim.' }; }
    status() { return { generations: this.generations.size, captures: this.captures.size, maxGenerations: this.maxGenerations, released: this.released, cleanupErrors: this.cleanupErrors, lastCleanupError: this.lastCleanupError, current: this.current?.id, limits: { captures: this.options.maxCaptures ?? 2, generations: (this.options.maxCaptures ?? 2) + 1, lifecycleOperations: this.options.maxOperations ?? 4 }, rows: [...this.generations.values()].map(g => ({ id: g.id, refs: g.refs, current: g === this.current, hotBytes: g.leaf.status().hotBytes })) }; }
    async close() { await this.lifecycle; this.closed = true; for (const c of [...this.captures.values()])
        await this.release(c); for (const g of [...this.generations.values()])
        await this.discard(g); await rm(this.root, { recursive: true, force: true }); }
}
