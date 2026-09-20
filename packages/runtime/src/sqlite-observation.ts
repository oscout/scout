import { createHash } from "node:crypto";

export type SlowSqliteEvent = {
  event: "slow_sqlite";
  database: "runtime" | "web-control-plane";
  pid: number;
  operation: string;
  queryId: string;
  durationMs: number;
  outcome: "ok" | "error";
  suppressed: number;
  caller: string[];
};

type Options = {
  database: SlowSqliteEvent["database"];
  thresholdMs?: number;
  now?: () => number;
  emit?: (event: SlowSqliteEvent) => void;
};

/** No SQL text, bindings, results, database paths, or exception messages leave this wrapper. */
export function observeSqliteDatabase<T extends object>(database: T, options: Options): T {
  const configured = options.thresholdMs ?? Number(process.env.OPENSCOUT_SLOW_DB_MS ?? 100);
  const threshold = Number.isFinite(configured) && configured >= 0 ? configured : 100;
  if (threshold === 0) return database;
  const now = options.now ?? (() => performance.now());
  const emit = options.emit ?? ((event) => console.warn("[scout-db]", JSON.stringify(event)));
  const statements = new WeakMap<object, object>();
  let windowStart = -Infinity;
  let emitted = 0;
  let suppressed = 0;

  function timed<R>(operation: string, sql: string, call: () => R): R {
    const start = now();
    let outcome: SlowSqliteEvent["outcome"] = "error";
    try {
      const result = call();
      outcome = "ok";
      return result;
    } finally {
      // Observability must never replace a database result or its original error.
      try {
        const end = now();
        const duration = end - start;
        if (duration >= threshold) {
          if (end - windowStart >= 60_000) {
            windowStart = end;
            emitted = 0;
          }
          if (emitted >= 10) {
            suppressed += 1;
          } else {
            emitted += 1;
            const caller = (new Error().stack ?? "").split("\n")
              .filter((line) => !/sqlite-observation\.(?:ts|js):/.test(line))
              .map((line) => line.match(/(?:packages|apps)\/[\w./-]+:\d+:\d+/)?.[0])
              .filter((line): line is string => Boolean(line)).slice(0, 4);
            emit({
              event: "slow_sqlite", database: options.database, pid: process.pid,
              operation, queryId: createHash("sha256").update(sql).digest("hex").slice(0, 16),
              durationMs: Math.round(duration * 100) / 100, outcome, suppressed, caller,
            });
            suppressed = 0;
          }
        }
      } catch { /* Logging is best effort, never part of the database contract. */ }
    }
  }

  function statementProxy(statement: object, sql: string): object {
    const existing = statements.get(statement);
    if (existing) return existing;
    const proxy = bindProxy(statement, (key, method, args) => {
      if (["all", "get", "run", "values"].includes(key)) {
        return timed(key, sql, () => Reflect.apply(method, statement, args));
      }
      return Reflect.apply(method, statement, args);
    });
    statements.set(statement, proxy);
    return proxy;
  }

  return bindProxy(database, (key, method, args) => {
    if (["query", "prepare"].includes(key) && typeof args[0] === "string") {
      const sql = args[0];
      const statement = timed(`${key}.prepare`, sql, () => Reflect.apply(method, database, args));
      return statementProxy(statement, sql);
    }
    if (["exec", "run"].includes(key) && typeof args[0] === "string") {
      return timed(key, args[0], () => Reflect.apply(method, database, args));
    }
    return Reflect.apply(method, database, args);
  });
}

/** Bind native methods to the real SQLite receiver; preserve cached function identity. */
function bindProxy<T extends object>(target: T, invoke: (key: string, method: Function, args: unknown[]) => unknown): T {
  const methods = new Map<PropertyKey, { original: Function; wrapped: Function }>();
  return new Proxy(target, {
    get(object, key) {
      const value = Reflect.get(object, key, object);
      if (typeof value !== "function" || key === "constructor") return value;
      const cached = methods.get(key);
      if (cached?.original === value) return cached.wrapped;
      const wrapped = (...args: unknown[]) => invoke(String(key), value, args);
      methods.set(key, { original: value, wrapped });
      return wrapped;
    },
  });
}
