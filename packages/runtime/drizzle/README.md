# Control-plane managed migrations

Authoring runbook for the Drizzle-managed migration chain that builds and
upgrades the control-plane SQLite database. Read this before your first schema
change on these rails.

## What this folder is

Managed migrations for the control-plane schema: a journal (`meta/_journal.json`)
plus versioned SQL files (`NNNN_<name>.sql`, starting at the baseline
`0000_curly_iron_monger.sql`). drizzle-kit generates these from the declarative
model in `../src/drizzle-schema.ts`; the boot migrator
(`applyControlPlaneDrizzleMigrations` in `../src/control-plane-migrations.ts`)
applies any pending migrations when a database is opened.

This chain is **append-only**. Never edit or delete an already-committed
migration or its `meta/NNNN_snapshot.json`: the ledger keys off the file hash
(`__drizzle_migrations`, hash from drizzle-orm's `readMigrationFiles`), so
changing a committed file re-hashes it and desyncs every database that already
recorded the old hash. Fix mistakes with a new migration, not an edit.

Migration identity is global across worktrees that share
`OPENSCOUT_CONTROL_HOME`. A feature worktree must not install or restart the
machine-wide Scout service against that shared database with a private
migration chain. Run migration experiments with an isolated control home,
service label, and ports. The machine-wide launchd service should point at one
stable canonical runtime checkout or an installed package artifact.

## How to make a schema change

Run these from `packages/runtime`.

1. **Edit the model** in `../src/drizzle-schema.ts`, and only the model. Never
   author schema in the raw string (`CONTROL_PLANE_SQLITE_SCHEMA`) or the
   imperative array (`CONTROL_PLANE_SCHEMA_MIGRATIONS`); those follow the model.
2. **Generate** the migration: `bun run db:generate`
   (`drizzle-kit generate`, reading `drizzle.config.ts`, whose `schema` points at
   `src/schema.ts`, which re-exports the model). Review the generated
   `NNNN_*.sql` before committing.
3. **Hand-fix `sql`-literal index expressions** if the change touches one.
   drizzle-kit 0.31.x comma-splits any `sql`-literal index body when it renders
   the migration, so the generated statement will be mangled. Rewrite it to the
   correct DDL; follow the precedent comment and the corrected
   `idx_durable_actions_kind_due_at_updated_at` statement in
   `0000_curly_iron_monger.sql`, whose canonical form is the exported constant
   `DURABLE_ACTIONS_DUE_AT_INDEX_SQL` in `../src/drizzle-schema.ts`.
4. **Mirror into the repair layer.** Apply the same change to
   `CONTROL_PLANE_SQLITE_SCHEMA` in `../src/schema.ts` (the idempotent repair
   layer for existing databases), and bump `CONTROL_PLANE_SCHEMA_VERSION` when
   the change warrants a new stamped version.
5. **Run the gates:**
   `bun test src/drizzle-schema-parity.test.ts src/control-plane-migrations.test.ts`
   The parity gates fail on any drift between the model, the raw string, and the
   checked-in migration chain, so a green run proves all three agree. The
   boot-path test pins virgin-boot, seeding, and downgrade-guard behavior.
6. **Commit together, in one commit:** the generated `NNNN_*.sql`,
   `meta/_journal.json`, `meta/NNNN_snapshot.json`, the `drizzle-schema.ts` edit,
   and the `CONTROL_PLANE_SQLITE_SCHEMA` mirror.

## Constraints that keep existing installs safe

- The migrator applies each pending migration in a transaction, so a partial
  migration does not leave a half-applied schema.
- A generated migration's plain `ALTER`/`CREATE` statements only ever execute on
  databases sitting at the prior ledger position. Baseline seeding
  (`seedControlPlaneDrizzleBaseline`) records the baseline as already-applied for
  any pre-baseline database that already has tables, so those databases skip the
  baseline's `CREATE TABLE`s entirely; only a truly virgin database runs the
  baseline for real.
- Column ADDs that must also repair very old databases do **not** belong in a
  generated migration; a `CREATE TABLE IF NOT EXISTS` repair layer cannot add a
  column to a table that already exists. Put those in the guarded imperative
  array `CONTROL_PLANE_SCHEMA_MIGRATIONS` (`../src/control-plane-migrations.ts`),
  each guarded by a `hasColumn` check. See the `briefings-markdown-column` entry.
- When in doubt: generated migration for the new-database shape, plus an
  imperative-array entry for old-database repair.

## Version pin

drizzle-kit is pinned exactly to `0.31.10` (`../package.json` devDependencies).
Do not bump it casually: the `db:generate` output format and the comma-split
workaround above are both sensitive to the drizzle-kit version.

## Pointers

- ADR: `../../../docs/eng/sco-075-drizzle-managed-migrations.md`.
- Gates: `../src/drizzle-schema-parity.test.ts` (model vs raw string vs
  checked-in chain) and `../src/control-plane-migrations.test.ts` (boot path).
