/** FIFO admission holds only resolvers/signals, never records or captures.
 * Cancellation removes the waiting node immediately; no timeout is introduced.
 * Queued-call metadata is observable and scales with already accepted readers.
 */
export class HistoryAdmission {
    private active = 0;
    private waiting = new Set<{
        resolve: (release: () => void) => void;
        reject: (e: unknown) => void;
        signal?: AbortSignal;
        abort: () => void;
    }>();
    constructor(readonly capacity: number) { if (!Number.isSafeInteger(capacity) || capacity < 1)
        throw Error('Invalid history reader capacity'); }
    status() { return { active: this.active, waiting: this.waiting.size, capacity: this.capacity, queuedCaptures: 0, queuedPayloadBytes: 0 }; }
    async acquire(signal?: AbortSignal): Promise<() => void> { signal?.throwIfAborted(); if (this.active < this.capacity && !this.waiting.size) {
        this.active++;
        return this.releaseHandle();
    } return new Promise((resolve, reject) => { const item = { resolve, reject, signal, abort: () => { this.waiting.delete(item); reject(signal?.reason ?? Error('aborted')); } }; this.waiting.add(item); signal?.addEventListener('abort', item.abort, { once: true }); if (signal?.aborted)
        item.abort(); }); }
    private releaseHandle() { let released = false; return () => { if (released)
        return; released = true; this.active--; this.pump(); }; }
    private pump() { while (this.active < this.capacity && this.waiting.size) {
        const item = this.waiting.values().next().value!;
        this.waiting.delete(item);
        item.signal?.removeEventListener('abort', item.abort);
        if (item.signal?.aborted) {
            item.reject(item.signal.reason);
            continue;
        }
        this.active++;
        item.resolve(this.releaseHandle());
    } }
    close(error: unknown) { for (const item of this.waiting) {
        item.signal?.removeEventListener('abort', item.abort);
        item.reject(error);
    } this.waiting.clear(); }
}
