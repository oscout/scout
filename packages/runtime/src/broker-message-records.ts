import type { MessageRecord } from "@openscout/protocol";
type Collection = Record<string, MessageRecord>;
/** Preserve snapshot membership/version without decoding every cold header. */
export function captureMessageRecords(records: Collection): Collection {
    if (asyncViews.has(records))
        return records;
    return { ...records };
}
/** Keys/counts do not resolve headers or invoke one proxy descriptor per ID. */
export function messageRecordKeys(records: object): string[] {
    return Object.keys(records);
}
export function messageRecordCount(records: object): number {
    return asyncViews.get(records)?.count() ?? Object.keys(records).length;
}
/** Complete iteration, retaining only the current record unless the caller opts
 * into materialization. Capturing the collection first fixes its version set. */
export function* iterateMessageRecords<T>(records: Record<string, T>): IterableIterator<T> {
    for (const id of messageRecordKeys(records))
        yield records[id]!;
}
export function filterMessageRecords(records: Collection, predicate: (record: MessageRecord) => boolean): Collection {
    const selected: Collection = {};
    for (const record of iterateMessageRecords(records))
        if (predicate(record))
            selected[record.id] = record;
    return selected;
}
/** Stable bounded selection with the same tie behavior as sort().slice(0,n). */
export function selectMessageRecords<T>(records: Record<string, T>, limit: number, compare: (left: T, right: T) => number, predicate: (record: T) => boolean = () => true): T[] {
    const selected: T[] = [];
    if (limit <= 0)
        return selected;
    for (const record of iterateMessageRecords(records)) {
        if (!predicate(record))
            continue;
        if (selected.length === limit && compare(record, selected[selected.length - 1]!) >= 0)
            continue;
        let low = 0, high = selected.length;
        while (low < high) {
            const mid = (low + high) >>> 1;
            if (compare(record, selected[mid]!) < 0)
                high = mid;
            else
                low = mid + 1;
        }
        selected.splice(low, 0, record);
        if (selected.length > limit)
            selected.pop();
    }
    return selected;
}
/** Async owner seam. A view is lightweight until a reader is admitted. */
export type MessageReadOptions = {
    signal?: AbortSignal;
};
export type MessageSelection = {
    clientMessageId?: string;
    conversationIds?: string[];
    actorId?: string;
    since?: number;
    replyToMessageId?: string;
    newestFirst?: boolean;
};
export type EncodedHistoryMessage = Readonly<{id: string; json: string}>;
export interface AsyncMessageRecordView {
    encoded?(options?: MessageReadOptions): AsyncIterable<EncodedHistoryMessage>;
    count(): number;
    read(id: string, options?: MessageReadOptions): Promise<MessageRecord | undefined>;
    iterate(options?: MessageReadOptions & {
        stream?: boolean;
        selection?: MessageSelection;
    }): AsyncIterable<MessageRecord>;
    withCapture<T>(run: (records: Collection) => Promise<T>, options?: MessageReadOptions & {
        stream?: boolean;
    }): Promise<T>;
}
const asyncViews = new WeakMap<object, AsyncMessageRecordView>();
export function registerAsyncMessageRecordView(records: Collection, view: AsyncMessageRecordView): void { asyncViews.set(records, view); }
export function asyncMessageRecordView(records: object): AsyncMessageRecordView | undefined { return asyncViews.get(records); }
export async function readMessageRecord(records: Collection, id: string, options?: MessageReadOptions): Promise<MessageRecord | undefined> {
    options?.signal?.throwIfAborted();
    const view = asyncViews.get(records);
    return view ? view.read(id, options) : Object.hasOwn(records, id) ? records[id] : undefined;
}
export async function* iterateMessageRecordsAsync(records: Collection, options?: MessageReadOptions & {
    stream?: boolean;
    selection?: MessageSelection;
}): AsyncIterableIterator<MessageRecord> {
    const view = asyncViews.get(records);
    if (view) {
        yield* view.iterate(options);
        return;
    }
    for (const value of iterateMessageRecords(records)) {
        options?.signal?.throwIfAborted();
        yield value;
    }
}
export async function selectMessageRecordsAsync(records: Collection, limit: number, compare: (a: MessageRecord, b: MessageRecord) => number, predicate: (m: MessageRecord) => boolean = () => true, options?: MessageReadOptions & {
    selection?: MessageSelection;
}): Promise<MessageRecord[]> {
    const selected: MessageRecord[] = [];
    if (limit <= 0)
        return selected;
    for await (const value of iterateMessageRecordsAsync(records, options)) {
        if (!predicate(value))
            continue;
        if (selected.length === limit && compare(value, selected[selected.length - 1]!) >= 0)
            continue;
        let low = 0, high = selected.length;
        while (low < high) {
            const mid = (low + high) >>> 1;
            if (compare(value, selected[mid]!) < 0)
                high = mid;
            else
                low = mid + 1;
        }
        selected.splice(low, 0, value);
        if (selected.length > limit)
            selected.pop();
        if (asyncViews.has(records) && options?.selection?.newestFirst && selected.length === limit)
            break;
    }
    return selected;
}
export async function withMessageCapture<T>(records: Collection, run: (captured: Collection) => Promise<T>, options?: MessageReadOptions & {
    stream?: boolean;
}): Promise<T> { const view = asyncViews.get(records); return view ? view.withCapture(run, options) : run(captureMessageRecords(records)); }
export async function readRuntimeMessage(runtime: {
    message(id: string): MessageRecord | undefined;
    readMessage?: (id: string, options?: MessageReadOptions) => Promise<MessageRecord | undefined>;
}, id: string, options?: MessageReadOptions) { return runtime.readMessage ? runtime.readMessage(id, options) : runtime.message(id); }
export async function filterMessageRecordsAsync(records: Collection, predicate: (m: MessageRecord) => boolean, options?: MessageReadOptions): Promise<Collection> {
    const base = asyncViews.get(records);
    if (!base)
        return filterMessageRecords(records, predicate);
    let count = 0;
    for await (const record of base.iterate(options))
        if (predicate(record))
            count++;
    const filtered = new Proxy(Object.create(null) as Collection, { get: (_target, key) => { if (typeof key === 'symbol' || key === 'then')
            return undefined; throw Error('Filtered history requires async access'); }, ownKeys: () => { throw Error('Filtered history requires async enumeration'); } });
    registerAsyncMessageRecordView(filtered, { count: () => count, read: async (id, opts) => { const value = await base.read(id, opts); return value && predicate(value) ? value : undefined; }, iterate: async function* (opts) { for await (const value of base.iterate(opts))
            if (predicate(value))
                yield value; }, withCapture: (run, opts) => base.withCapture(async (bound) => run(await filterMessageRecordsAsync(bound, predicate, opts)), opts) });
    return filtered;
}
export async function materializeMessageRecords(records: Collection, options?: MessageReadOptions): Promise<Collection> { const result: Collection = Object.create(null); for await (const value of iterateMessageRecordsAsync(records, options))
    result[value.id] = value; return result; }

export async function* iterateEncodedMessageRecordsAsync(records: Collection, options?: MessageReadOptions): AsyncIterable<EncodedHistoryMessage> {
    const encoded = asyncViews.get(records)?.encoded;
    if (encoded) { yield* encoded(options); return; }
    for await (const value of iterateMessageRecordsAsync(records, options)) yield {id: value.id, json: JSON.stringify(value)};
}
