import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database } from "bun:sqlite";

import {
  configureControlPlaneDatabase,
  migrateControlPlaneDatabaseSchema,
  resolveControlPlaneDatabasePath,
} from "./control-plane-migrations.js";

if (import.meta.main) {
  const dbPath = resolveControlPlaneDatabasePath();
  mkdirSync(dirname(dbPath), { recursive: true });

  const database = new Database(dbPath, { create: true });
  try {
    configureControlPlaneDatabase(database);
    migrateControlPlaneDatabaseSchema(database);
    console.log(`Control-plane migration check completed for ${dbPath}`);
  } finally {
    database.close();
  }
}
