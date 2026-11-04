// A pinned Run cannot be silently rebound by run-use, run-create, reset, or an older writer.
export const STRICT_COORDINATOR_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS strict_run_coordinators (
  run_id TEXT PRIMARY KEY REFERENCES runs(id),
  authority TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS trg_strict_run_binding
BEFORE UPDATE ON runs
WHEN EXISTS (SELECT 1 FROM strict_run_coordinators WHERE run_id = OLD.id)
 AND (NEW.id IS NOT OLD.id OR NEW.coordinator_handle IS NOT OLD.coordinator_handle
   OR NEW.coordinator_pane_key IS NOT OLD.coordinator_pane_key
   OR NEW.coordinator_orca_session_id IS NOT OLD.coordinator_orca_session_id
   OR NEW.consumer_generation IS NOT OLD.consumer_generation OR NEW.legacy IS NOT OLD.legacy)
BEGIN SELECT RAISE(ABORT, 'strict_coordinator_required: Run binding is pinned'); END;
CREATE TRIGGER IF NOT EXISTS trg_strict_run_delete
BEFORE DELETE ON runs
WHEN EXISTS (SELECT 1 FROM strict_run_coordinators WHERE run_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'strict_coordinator_required: Run cannot be reset'); END;
CREATE TRIGGER IF NOT EXISTS trg_strict_policy_update
BEFORE UPDATE ON strict_run_coordinators
BEGIN SELECT RAISE(ABORT, 'strict_coordinator_required: policy is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_strict_policy_delete
BEFORE DELETE ON strict_run_coordinators
BEGIN SELECT RAISE(ABORT, 'strict_coordinator_required: policy is immutable'); END;
`
