import { defineConfig } from "drizzle-kit";

// The full control-plane schema is modeled declaratively in src/drizzle-schema.ts
// (re-exported through src/schema.ts) and schema changes flow through
// `bun run db:generate`. CONTROL_PLANE_SQLITE_SCHEMA remains the runtime repair
// layer; the parity test (drizzle-schema-parity.test.ts) keeps the two in lockstep.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema.ts",
  out: "./drizzle",
  strict: true,
  verbose: true,
});
