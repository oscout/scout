declare module "bun:sqlite" {
  export interface Statement<T = unknown> {
    all(...params: unknown[]): T[];
    get(...params: unknown[]): T | null;
    run(...params: unknown[]): unknown;
  }

  export class Database {
    constructor(filename?: string, options?: { create?: boolean; strict?: boolean });
    exec(sql: string): void;
    run(sql: string, ...params: unknown[]): unknown;
    query<T = unknown>(sql: string): Statement<T>;
    close(): void;
  }
}
