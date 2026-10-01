// Broker-owned setup records, retained independently of runtime projections.
// No credentials or arbitrary request JSON are stored here.
export const INTEGRATION_SETUP_SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS integration_setup_operations (
  id TEXT PRIMARY KEY,
  owner_realm_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  app_id TEXT,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  record_json TEXT NOT NULL,
  UNIQUE (owner_realm_id, scope_key, workspace_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_integration_setup_app
  ON integration_setup_operations (owner_realm_id, workspace_key, app_id)
  WHERE app_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS integration_setup_requests (
  owner_realm_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  operation_id TEXT NOT NULL REFERENCES integration_setup_operations(id) ON DELETE RESTRICT,
  PRIMARY KEY (owner_realm_id, request_key)
);
`;
