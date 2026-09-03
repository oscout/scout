import type {
  ControlPlaneSqliteDatabase,
  ControlPlaneSqliteStatement,
  ControlPlaneSqliteTransactionalDatabase,
} from "./sqlite-adapter.js";
import type { SQLiteControlPlaneStore } from "./sqlite-store.js";

type SharedStoreSurface = Pick<
  SQLiteControlPlaneStore,
  | "isClosed"
  | "writerDb"
  | "trustedPeer"
  | "listTrustedPeers"
  | "upsertTrustedPeer"
  | "revokeTrustedPeer"
  | "claimPeerNonce"
  | "compactAndPruneMeshNodes"
  | "close"
>;

/**
 * Owns the broker's one lazily-opened control-plane store.
 *
 * Constructing this provider and wiring its database/trust facades performs no
 * SQLite work. The projection normally becomes the first consumer after both
 * broker listeners bind; aliases and mesh trust then reuse that same store.
 */
export class LazyControlPlaneStore<TStore extends SharedStoreSurface = SQLiteControlPlaneStore> {
  private current: TStore | null = null;
  private permanentlyClosed = false;

  readonly routeAliasDatabase: ControlPlaneSqliteTransactionalDatabase;

  constructor(private readonly createStore: () => TStore) {
    this.routeAliasDatabase = new SharedStoreDatabase(this);
  }

  readonly createProjectionStore = (_dbPath: string): TStore => this.get();

  get(): TStore {
    if (this.permanentlyClosed) {
      throw new Error("control-plane SQLite store is closed");
    }
    if (!this.current || this.current.isClosed) {
      this.current = this.createStore();
    }
    return this.current;
  }

  trustedPeer(...args: Parameters<SQLiteControlPlaneStore["trustedPeer"]>): ReturnType<SQLiteControlPlaneStore["trustedPeer"]> {
    return this.get().trustedPeer(...args);
  }

  listTrustedPeers(...args: Parameters<SQLiteControlPlaneStore["listTrustedPeers"]>): ReturnType<SQLiteControlPlaneStore["listTrustedPeers"]> {
    return this.get().listTrustedPeers(...args);
  }

  upsertTrustedPeer(...args: Parameters<SQLiteControlPlaneStore["upsertTrustedPeer"]>): ReturnType<SQLiteControlPlaneStore["upsertTrustedPeer"]> {
    return this.get().upsertTrustedPeer(...args);
  }

  revokeTrustedPeer(...args: Parameters<SQLiteControlPlaneStore["revokeTrustedPeer"]>): ReturnType<SQLiteControlPlaneStore["revokeTrustedPeer"]> {
    return this.get().revokeTrustedPeer(...args);
  }

  claimPeerNonce(...args: Parameters<SQLiteControlPlaneStore["claimPeerNonce"]>): ReturnType<SQLiteControlPlaneStore["claimPeerNonce"]> {
    return this.get().claimPeerNonce(...args);
  }

  compactAndPruneMeshNodes(...args: Parameters<SQLiteControlPlaneStore["compactAndPruneMeshNodes"]>): ReturnType<SQLiteControlPlaneStore["compactAndPruneMeshNodes"]> {
    return this.get().compactAndPruneMeshNodes(...args);
  }

  close(): void {
    if (this.permanentlyClosed) {
      return;
    }
    this.permanentlyClosed = true;
    const current = this.current;
    this.current = null;
    current?.close();
  }
}

class SharedStoreDatabase implements ControlPlaneSqliteTransactionalDatabase {
  constructor(private readonly provider: LazyControlPlaneStore<SharedStoreSurface>) {}

  exec(sql: string): unknown {
    return this.database().exec(sql);
  }

  query<Row = unknown>(sql: string): ControlPlaneSqliteStatement<Row> {
    return this.database().query<Row>(sql);
  }

  transaction<TArgs extends unknown[], TResult>(
    callback: (...args: TArgs) => TResult,
  ): (...args: TArgs) => TResult {
    return (...args: TArgs): TResult => this.transactionalDatabase()
      .transaction(callback)(...args);
  }

  private database(): ControlPlaneSqliteDatabase {
    return this.provider.get().writerDb;
  }

  private transactionalDatabase(): ControlPlaneSqliteTransactionalDatabase {
    return this.database() as ControlPlaneSqliteTransactionalDatabase;
  }
}
