import type { RuntimeTypedArray } from "./portable-types.js";
import { createRequire } from "node:module";

import { planRuntimeAdapters, type RuntimeDatabaseAdapterKind } from "./runtime-adapters.js";

export type ControlPlaneSqliteOpenOptions = {
  create?: boolean;
  strict?: boolean;
  readonly?: boolean;
};

export type ControlPlaneSqliteBinding =
  | string
  | bigint
  | RuntimeTypedArray
  | number
  | boolean
  | null
  | Record<string, string | bigint | RuntimeTypedArray | number | boolean | null>;

export type ControlPlaneSqliteStatement<Row = unknown> = {
  all(...params: any[]): Row[];
  get(...params: any[]): Row | null;
  run(...params: any[]): unknown;
};

export type ControlPlaneSqliteDatabase = {
  exec(sql: string): unknown;
  query<Row = unknown>(sql: string): ControlPlaneSqliteStatement<Row>;
  close?(): void;
};

export type ControlPlaneSqliteTransactionalDatabase = ControlPlaneSqliteDatabase & {
  transaction<TArgs extends unknown[], TResult>(
    callback: (...args: TArgs) => TResult
  ): (...args: TArgs) => TResult;
};

type ControlPlaneSqliteDatabaseConstructor = {
  new (path: string, options?: ControlPlaneSqliteOpenOptions): ControlPlaneSqliteDatabase;
};

type NodeSqliteStatementSync = {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown | undefined;
  run(...params: unknown[]): unknown;
};

type NodeSqliteDatabaseSync = {
  exec(sql: string): unknown;
  prepare(sql: string): NodeSqliteStatementSync;
  close(): void;
};

type NodeSqliteDatabaseSyncConstructor = {
  new (
    path: string,
    options: {
      open: true;
      readOnly?: boolean;
    },
  ): NodeSqliteDatabaseSync;
};

type NodeSqliteModule = {
  DatabaseSync: NodeSqliteDatabaseSyncConstructor;
};

const require = createRequire(import.meta.url);

export function controlPlaneSqliteAdapterKind(): RuntimeDatabaseAdapterKind {
  return planRuntimeAdapters().database;
}

export function openControlPlaneSqliteDatabase(
  path: string,
  options?: ControlPlaneSqliteOpenOptions,
): ControlPlaneSqliteDatabase {
  return openRuntimeSqliteDatabase(path, options);
}

export function openRuntimeSqliteDatabase(
  path: string,
  options?: ControlPlaneSqliteOpenOptions,
): ControlPlaneSqliteDatabase {
  const adapter = controlPlaneSqliteAdapterKind();
  if (adapter === "bun-sqlite") {
    const { Database } = require("bun:sqlite") as { Database: ControlPlaneSqliteDatabaseConstructor };
    return new Database(path, options);
  }

  const { DatabaseSync } = require("node:sqlite") as NodeSqliteModule;
  return new NodeSqliteDatabaseAdapter(
    new DatabaseSync(path, {
      open: true,
      readOnly: options?.readonly === true,
    }),
  );
}

type NodeSqlitePreparedSql = {
  sql: string;
  numberedParamIndexes: number[] | null;
};

function prepareNodeSqliteSql(sql: string): NodeSqlitePreparedSql {
  const numberedParamIndexes: number[] = [];
  const normalizedSql = sql.replace(/\?(\d+)/g, (_match, rawIndex: string) => {
    numberedParamIndexes.push(Number.parseInt(rawIndex, 10) - 1);
    return "?";
  });

  return {
    sql: normalizedSql,
    numberedParamIndexes: numberedParamIndexes.length > 0 ? numberedParamIndexes : null,
  };
}

function bindNodeSqliteParams(
  numberedParamIndexes: number[] | null,
  params: unknown[],
): unknown[] {
  if (!numberedParamIndexes) {
    return params;
  }
  return numberedParamIndexes.map((index) => params[index]);
}

class NodeSqliteStatementAdapter<Row = unknown> implements ControlPlaneSqliteStatement<Row> {
  constructor(
    private readonly statement: NodeSqliteStatementSync,
    private readonly numberedParamIndexes: number[] | null,
  ) {}

  all(...params: unknown[]): Row[] {
    return this.statement.all(...bindNodeSqliteParams(this.numberedParamIndexes, params)) as Row[];
  }

  get(...params: unknown[]): Row | null {
    return (this.statement.get(...bindNodeSqliteParams(this.numberedParamIndexes, params)) ?? null) as Row | null;
  }

  run(...params: unknown[]): unknown {
    return this.statement.run(...bindNodeSqliteParams(this.numberedParamIndexes, params));
  }
}

class NodeSqliteDatabaseAdapter implements ControlPlaneSqliteTransactionalDatabase {
  private transactionDepth = 0;
  private savepointId = 0;

  constructor(private readonly database: NodeSqliteDatabaseSync) {}

  exec(sql: string): unknown {
    return this.database.exec(sql);
  }

  query<Row = unknown>(sql: string): ControlPlaneSqliteStatement<Row> {
    const prepared = prepareNodeSqliteSql(sql);
    return new NodeSqliteStatementAdapter<Row>(
      this.database.prepare(prepared.sql),
      prepared.numberedParamIndexes,
    );
  }

  close(): void {
    this.database.close();
  }

  transaction<TArgs extends unknown[], TResult>(
    callback: (...args: TArgs) => TResult,
  ): (...args: TArgs) => TResult {
    return (...args: TArgs): TResult => {
      if (this.transactionDepth > 0) {
        return this.runSavepoint(callback, args);
      }

      this.database.exec("BEGIN IMMEDIATE;");
      this.transactionDepth += 1;
      try {
        const result = callback(...args);
        this.database.exec("COMMIT;");
        return result;
      } catch (error) {
        this.database.exec("ROLLBACK;");
        throw error;
      } finally {
        this.transactionDepth -= 1;
      }
    };
  }

  private runSavepoint<TArgs extends unknown[], TResult>(
    callback: (...args: TArgs) => TResult,
    args: TArgs,
  ): TResult {
    const savepointName = `openscout_nested_${this.savepointId++}`;
    this.database.exec(`SAVEPOINT ${savepointName};`);
    this.transactionDepth += 1;
    try {
      const result = callback(...args);
      this.database.exec(`RELEASE SAVEPOINT ${savepointName};`);
      return result;
    } catch (error) {
      this.database.exec(`ROLLBACK TO SAVEPOINT ${savepointName};`);
      this.database.exec(`RELEASE SAVEPOINT ${savepointName};`);
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }
}
