import { desc as drizzleDesc, eq as drizzleEq, sql as drizzleSql } from "drizzle-orm";

import { openControlPlaneDrizzle as openControlPlaneDrizzleImpl } from "./drizzle-client.js";
import { briefingsTable as runtimeBriefingsTable } from "./drizzle-schema.js";
import type { ControlPlaneSqliteDatabase } from "./sqlite-adapter.js";

export type ControlPlaneBriefingRow = {
  id: string;
  kind: string;
  title: string;
  summary: string;
  recommendation: string | null;
  preparedAt: number;
  ttlMs: number;
  briefJson: string;
  observationsJson: string;
  snapshotJson: string;
  callJson: string;
  markdown: string | null;
  createdAt: number;
};

export type ControlPlaneBriefingsTable = {
  readonly $inferSelect: ControlPlaneBriefingRow;
  readonly id: unknown;
  readonly kind: unknown;
  readonly title: unknown;
  readonly summary: unknown;
  readonly recommendation: unknown;
  readonly preparedAt: unknown;
  readonly ttlMs: unknown;
  readonly briefJson: unknown;
  readonly observationsJson: unknown;
  readonly snapshotJson: unknown;
  readonly callJson: unknown;
  readonly markdown: unknown;
  readonly createdAt: unknown;
};

export type ControlPlaneDrizzleDatabase = any;
export type ControlPlaneDrizzlePredicate = unknown;
export type ControlPlaneDrizzleOperator = (...args: readonly unknown[]) => ControlPlaneDrizzlePredicate;
export type ControlPlaneDrizzleSqlTag = (
  strings: TemplateStringsArray,
  ...params: readonly unknown[]
) => ControlPlaneDrizzlePredicate;

export const briefingsTable =
  runtimeBriefingsTable as unknown as ControlPlaneBriefingsTable;
export const desc = drizzleDesc as unknown as ControlPlaneDrizzleOperator;
export const eq = drizzleEq as unknown as ControlPlaneDrizzleOperator;
export const sql = drizzleSql as unknown as ControlPlaneDrizzleSqlTag;

/**
 * Host-bound Drizzle bridge for internal control-plane DB consumers.
 *
 * This subpath intentionally keeps Drizzle/Bun SQLite off the root export while
 * preserving a narrow in-repo escape hatch for web/server code that queries
 * runtime-owned tables.
 */
export function openControlPlaneDrizzle(
  client: ControlPlaneSqliteDatabase,
): ControlPlaneDrizzleDatabase {
  return openControlPlaneDrizzleImpl(client);
}
