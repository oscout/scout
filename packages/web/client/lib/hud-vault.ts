export type HudVaultErrorCode =
  | "idb_unsupported"
  | "crypto_unsupported"
  | "encoding_failed"
  | "idb_failed"
  | "crypto_failed";

export class HudVaultError extends Error {
  readonly code: HudVaultErrorCode;
  readonly cause?: unknown;

  constructor(code: HudVaultErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "HudVaultError";
    this.code = code;
    this.cause = cause;
  }
}

export type HudVaultOptions = {
  service: string;
};

type StoredItem = {
  iv: Uint8Array;
  ct: Uint8Array;
};

/**
 * Return a view whose backing store is a concrete `ArrayBuffer`, satisfying
 * `BufferSource` for WebCrypto. `Uint8Array<ArrayBufferLike>` (the default in
 * recent lib.dom typings) is not assignable to `BufferSource` because a
 * `SharedArrayBuffer` lacks `resize`; copying into a fresh buffer narrows it.
 */
function toBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

const ITEMS_STORE = "items";
const KEYS_STORE = "keys";
const MASTER_KEY_NAME = "master";

export class HudVault {
  readonly service: string;
  private dbPromise?: Promise<IDBDatabase>;
  private cryptoKeyPromise?: Promise<CryptoKey>;

  constructor(options: HudVaultOptions) {
    this.service = options.service;
  }

  async set(key: string, value: string): Promise<void> {
    const bytes = new TextEncoder().encode(value);
    await this.setBytes(key, bytes);
  }

  async get(key: string): Promise<string | null> {
    const bytes = await this.getBytes(key);
    if (!bytes) return null;
    try {
      return new TextDecoder().decode(bytes);
    } catch (error) {
      throw new HudVaultError("encoding_failed", "value is not valid UTF-8", error);
    }
  }

  async delete(key: string): Promise<void> {
    await this.idbDelete(ITEMS_STORE, key);
  }

  private async setBytes(key: string, value: Uint8Array): Promise<void> {
    const cryptoKey = await this.getOrCreateCryptoKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    let ct: ArrayBuffer;
    try {
      ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, toBufferSource(value));
    } catch (error) {
      throw new HudVaultError("crypto_failed", "AES-GCM encrypt failed", error);
    }
    await this.idbWrite(ITEMS_STORE, key, { iv, ct: new Uint8Array(ct) });
  }

  private async getBytes(key: string): Promise<Uint8Array | null> {
    const stored = await this.idbRead<StoredItem>(ITEMS_STORE, key);
    if (!stored) return null;
    const cryptoKey = await this.getOrCreateCryptoKey();
    try {
      const pt = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: toBufferSource(stored.iv) },
        cryptoKey,
        toBufferSource(stored.ct),
      );
      return new Uint8Array(pt);
    } catch (error) {
      throw new HudVaultError("crypto_failed", "AES-GCM decrypt failed", error);
    }
  }

  private getOrCreateCryptoKey(): Promise<CryptoKey> {
    if (this.cryptoKeyPromise) return this.cryptoKeyPromise;
    this.cryptoKeyPromise = (async () => {
      if (typeof crypto === "undefined" || !crypto.subtle) {
        throw new HudVaultError("crypto_unsupported", "crypto.subtle is not available");
      }

      const existing = await this.idbRead<CryptoKey>(KEYS_STORE, MASTER_KEY_NAME);
      if (existing) return existing;

      let fresh: CryptoKey;
      try {
        fresh = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
          "encrypt",
          "decrypt",
        ]);
      } catch (error) {
        throw new HudVaultError("crypto_failed", "AES-GCM key generation failed", error);
      }
      await this.idbWrite(KEYS_STORE, MASTER_KEY_NAME, fresh);
      return fresh;
    })();
    return this.cryptoKeyPromise;
  }

  private getDB(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new HudVaultError("idb_unsupported", "IndexedDB is not available"));
        return;
      }

      const req = indexedDB.open(`hudvault:${this.service}`, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(ITEMS_STORE)) db.createObjectStore(ITEMS_STORE);
        if (!db.objectStoreNames.contains(KEYS_STORE)) db.createObjectStore(KEYS_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(new HudVaultError("idb_failed", idbErrorMessage("open", req.error), req.error));
    });
    return this.dbPromise;
  }

  private async idbRead<T>(store: string, key: string): Promise<T | undefined> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readonly");
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => reject(new HudVaultError("idb_failed", idbErrorMessage("read", req.error), req.error));
    });
  }

  private async idbWrite(store: string, key: string, value: unknown): Promise<void> {
    const db = await this.getDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new HudVaultError("idb_failed", idbErrorMessage("write", tx.error), tx.error));
      tx.objectStore(store).put(value, key);
    });
  }

  private async idbDelete(store: string, key: string): Promise<void> {
    const db = await this.getDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new HudVaultError("idb_failed", idbErrorMessage("delete", tx.error), tx.error));
      tx.objectStore(store).delete(key);
    });
  }
}

function idbErrorMessage(action: string, error: DOMException | null): string {
  return `IndexedDB ${action} failed${error?.message ? `: ${error.message}` : ""}`;
}
