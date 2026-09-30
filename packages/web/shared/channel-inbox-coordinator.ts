/** Revision latch: registration before reading avoids a change/read/wait race. */
export class InboxChangeSignal {
  version = 0;
  private listeners = new Set<() => void>();
  notify() { this.version++; for (const listener of [...this.listeners]) listener(); }
  wait(after: number, signal: AbortSignal): Promise<void> {
    if (this.version !== after || signal.aborted) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => { this.listeners.delete(done); signal.removeEventListener("abort", done); resolve(); };
      this.listeners.add(done); signal.addEventListener("abort", done, { once: true });
    });
  }
}

/** One cheap check and one cached projection per revision, not per held HTTP request.
 * Entries live only while leased. Errors invalidate the revision so every waiter
 * revalidates and fails its stream rather than retaining a stale authorization. */
export class ChannelInboxCoordinator<T> {
  private entries = new Map<string, { refs: number; changes: InboxChangeSignal; read: () => Promise<T>; stop: () => void }>();
  acquire(key: string, options: { check: () => Promise<string>; load: () => Promise<T>; intervalMs?: number; subscribe?: (changed: () => void) => () => void }) {
    let entry = this.entries.get(key);
    if (!entry) {
      const changes = new InboxChangeSignal();
      let fingerprint: string | undefined, failure: unknown, cached: Promise<T> | undefined;
      let checking = false;
      let stopped = false, timer: ReturnType<typeof setTimeout>;
      const check = async () => {
        if (checking || stopped) return;
        checking = true; clearTimeout(timer);
        try {
          const next = await options.check();
          if (stopped) return;
          if (next !== fingerprint || failure) { fingerprint = next; failure = undefined; cached = undefined; changes.notify(); }
        } catch (error) { if (!stopped) { failure = error; cached = undefined; changes.notify(); } }
        finally { checking = false; if (!stopped) timer = setTimeout(() => { void check(); }, options.intervalMs ?? 1000); }
      };
      let unsubscribe: (() => void) | undefined;
      entry = { refs: 0, changes, read: () => {
        if (failure) return Promise.reject(failure);
        if (!cached) {
          const pending = options.load(); cached = pending;
          void pending.catch(() => { if (cached === pending) cached = undefined; });
        }
        return cached;
      }, stop: () => { stopped = true; clearTimeout(timer); unsubscribe?.(); } };
      this.entries.set(key, entry);
      // Establish the cheap baseline before serving the initial shared projection.
      const ready = options.check().then(value => { fingerprint = value; }, error => { failure = error; });
      const read = entry.read;
      entry.read = async () => { await ready; return read(); };
      void ready.then(() => {
        if (stopped) return;
        unsubscribe = options.subscribe?.(() => {
          if (stopped) return;
          cached = undefined; failure = undefined; changes.notify();
        });
        timer = setTimeout(() => { void check(); }, options.intervalMs ?? 1000);
      });
    }
    entry.refs++;
    const selected = entry;
    let released = false;
    return { changes: selected.changes, read: selected.read, release: () => {
      if (released) return; released = true;
      if (--selected.refs === 0) { selected.stop(); this.entries.delete(key); }
    } };
  }
}
