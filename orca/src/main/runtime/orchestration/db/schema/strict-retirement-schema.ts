export const STRICT_RETIREMENT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS strict_run_retirements (
  run_id TEXT PRIMARY KEY REFERENCES strict_run_coordinators(run_id),
  generation INTEGER NOT NULL,
  receipt TEXT NOT NULL
);
DROP TRIGGER IF EXISTS trg_strict_run_binding;
CREATE TRIGGER trg_strict_run_binding
BEFORE UPDATE ON runs
WHEN EXISTS (SELECT 1 FROM strict_run_coordinators WHERE run_id = OLD.id)
 AND (NEW.id IS NOT OLD.id OR NEW.coordinator_handle IS NOT OLD.coordinator_handle
   OR NEW.coordinator_pane_key IS NOT OLD.coordinator_pane_key
   OR NEW.coordinator_orca_session_id IS NOT OLD.coordinator_orca_session_id
   OR NEW.coordinator_orca_session_id_generation IS NOT OLD.coordinator_orca_session_id_generation
   OR NEW.consumer_generation IS NOT OLD.consumer_generation OR NEW.legacy IS NOT OLD.legacy)
 AND NOT (NEW.id = OLD.id AND NEW.legacy = OLD.legacy
   AND NEW.coordinator_handle IS NULL AND NEW.coordinator_pane_key IS NULL
   AND NEW.coordinator_orca_session_id IS NULL
   AND NEW.coordinator_orca_session_id_generation IS NULL
   AND NEW.consumer_generation = OLD.consumer_generation + 1
   AND EXISTS (SELECT 1 FROM strict_run_retirements
     WHERE run_id = OLD.id AND generation = OLD.consumer_generation))
BEGIN SELECT RAISE(ABORT, 'strict_coordinator_required: Run binding is pinned'); END;
CREATE TRIGGER IF NOT EXISTS trg_strict_retirement_update
BEFORE UPDATE ON strict_run_retirements
BEGIN SELECT RAISE(ABORT, 'strict_coordinator_required: retirement is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_strict_retirement_delete
BEFORE DELETE ON strict_run_retirements
BEGIN SELECT RAISE(ABORT, 'strict_coordinator_required: retirement is immutable'); END;
`
