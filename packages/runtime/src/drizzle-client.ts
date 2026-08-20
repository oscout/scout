import { drizzle } from "drizzle-orm/bun-sqlite";

import type { ControlPlaneSqliteDatabase } from "./sqlite-adapter.js";

import { controlPlaneDrizzleSchema } from "./drizzle-schema.js";

export function openControlPlaneDrizzle(client: ControlPlaneSqliteDatabase): any {
  return drizzle(client as never, { schema: controlPlaneDrizzleSchema }) as any;
}
