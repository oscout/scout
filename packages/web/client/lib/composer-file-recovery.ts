/** Browser-local file drafts. Separate records make late removals safe across tabs. */
const identities = new WeakMap<File, string>();
const positions = new WeakMap<File, number>();
let lastPosition = 0;
export function composerFileId(file: File): string {
  let id = identities.get(file);
  if (!id) { id = crypto.randomUUID(); identities.set(file, id); }
  return id;
}
export function composerFileFingerprint(file: Pick<File, "name" | "size" | "lastModified">): string {
  return JSON.stringify([file.name, file.size, file.lastModified]);
}
export function mergeComposerFiles(current: readonly File[], incoming: readonly File[]): File[] {
  const seen = new Set(current.map(composerFileFingerprint));
  const result = [...current];
  for (const file of incoming) {
    const key = composerFileFingerprint(file);
    if (!seen.has(key)) { seen.add(key); result.push(file); }
  }
  return result;
}
export interface ComposerFileChange { scope: string; added: string[]; removed: string[]; }
const listeners = new Set<(change: ComposerFileChange) => void>();
let channel: BroadcastChannel | undefined;
function changesChannel() {
  if (!channel && typeof window !== "undefined" && typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel("openscout-composer-files");
    channel.onmessage = event => {
      const change = event.data as ComposerFileChange;
      if (typeof change?.scope !== "string" || !Array.isArray(change.added) || !Array.isArray(change.removed)
        || [...change.added, ...change.removed].some(id => typeof id !== "string")) return;
      for (const listener of listeners) listener(change);
    };
  }
  return channel;
}
export function subscribeComposerFiles(listener: (change: ComposerFileChange) => void): () => void {
  listeners.add(listener);
  try { changesChannel(); } catch { /* Reopening still reads committed files. */ }
  return () => { listeners.delete(listener); if (!listeners.size) { channel?.close(); channel = undefined; } };
}
function publish(change: ComposerFileChange) {
  for (const listener of listeners) listener(change);
  try { changesChannel()?.postMessage(change); } catch { /* Persistence already committed. */ }
}
interface StoredFile { key: string; scope: string; id: string; blob: Blob; name: string; type: string; lastModified: number; order: number; }
let database: Promise<IDBDatabase> | undefined;
function open(): Promise<IDBDatabase> {
  if (!database) database = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("openscout-composer-files", 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore("files", { keyPath: "key" });
      store.createIndex("scope", "scope");
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); database = undefined; };
      resolve(request.result);
    };
    request.onerror = () => { database = undefined; reject(request.error); };
    request.onblocked = () => { database = undefined; reject(new Error("Attachment storage is busy in another tab.")); };
  });
  return database;
}
export async function readComposerFiles(scope: string): Promise<File[]> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("files", "readonly");
    const request = transaction.objectStore("files").index("scope").getAll(scope);
    transaction.oncomplete = () => resolve((request.result as StoredFile[]).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id)).map(record => {
      const file = new File([record.blob], record.name, { type: record.type, lastModified: record.lastModified });
      identities.set(file, record.id);
      positions.set(file, record.order ?? 0);
      lastPosition = Math.max(lastPosition, record.order ?? 0);
      return file;
    }));
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}
export async function updateComposerFiles(scope: string, add: readonly File[], remove: readonly File[]): Promise<void> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("files", "readwrite");
    const store = transaction.objectStore("files");
    // IndexedDB serializes read/write transactions across tabs. Reuse the
    // stored identity for an identical capture instead of creating two chips
    // with independent remove/send lifecycles.
    const existing = store.index("scope").getAll(scope);
    const removedIds: string[] = [];
    existing.onsuccess = () => {
      let records = existing.result as StoredFile[];
      const removals = new Set(remove.map(composerFileFingerprint));
      for (const record of records) {
        if (removals.has(composerFileFingerprint({ name: record.name, size: record.blob.size, lastModified: record.lastModified }))) {
          store.delete(record.key); removedIds.push(record.id);
        }
      }
      records = records.filter(record => !removedIds.includes(record.id));
      for (const file of add) {
        const prior = records.find(record => composerFileFingerprint({ name: record.name, size: record.blob.size, lastModified: record.lastModified }) === composerFileFingerprint(file));
        if (prior) identities.set(file, prior.id);
        const id = composerFileId(file);
        const order = prior?.order ?? positions.get(file) ?? (lastPosition = Math.max(Date.now(), lastPosition + 1));
        positions.set(file, order);
        const record = { key: JSON.stringify([scope, id]), scope, id, blob: file, name: file.name, type: file.type, lastModified: file.lastModified, order } satisfies StoredFile;
        store.put(record);
        if (!prior) records.push(record);
      }
    };
    transaction.oncomplete = () => {
      if (add.length || remove.length) publish({ scope, added: add.map(composerFileId), removed: [...new Set([...removedIds, ...remove.map(composerFileId)])] });
      resolve();
    };
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}
