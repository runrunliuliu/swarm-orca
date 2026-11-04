// Offline administration retains fences even when the user discards task history.
export const ADMINISTRATIVE_HISTORY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS administrative_history_receipts (
  id TEXT PRIMARY KEY,
  receipt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS administrative_history_fences (
  kind TEXT NOT NULL CHECK(kind IN ('address', 'pane')),
  identity TEXT NOT NULL,
  receipt_id TEXT NOT NULL REFERENCES administrative_history_receipts(id),
  PRIMARY KEY (kind, identity)
);
CREATE TABLE IF NOT EXISTS administrative_history_permits (
  run_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL REFERENCES administrative_history_receipts(id)
);
CREATE TRIGGER IF NOT EXISTS trg_admin_history_receipt_update
BEFORE UPDATE ON administrative_history_receipts
BEGIN SELECT RAISE(ABORT, 'administrative_history_immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_admin_history_receipt_delete
BEFORE DELETE ON administrative_history_receipts
BEGIN SELECT RAISE(ABORT, 'administrative_history_immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_admin_history_fence_update
BEFORE UPDATE ON administrative_history_fences
BEGIN SELECT RAISE(ABORT, 'administrative_history_immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_admin_history_fence_delete
BEFORE DELETE ON administrative_history_fences
BEGIN SELECT RAISE(ABORT, 'administrative_history_immutable'); END;
DROP TRIGGER IF EXISTS trg_strict_run_delete;
CREATE TRIGGER trg_strict_run_delete BEFORE DELETE ON runs
WHEN EXISTS (SELECT 1 FROM strict_run_coordinators WHERE run_id = OLD.id)
 AND NOT EXISTS (SELECT 1 FROM administrative_history_permits WHERE run_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'strict_coordinator_required: Run cannot be reset'); END;
DROP TRIGGER IF EXISTS trg_strict_policy_delete;
CREATE TRIGGER trg_strict_policy_delete BEFORE DELETE ON strict_run_coordinators
WHEN NOT EXISTS (SELECT 1 FROM administrative_history_permits WHERE run_id = OLD.run_id)
BEGIN SELECT RAISE(ABORT, 'strict_coordinator_required: policy is immutable'); END;
DROP TRIGGER IF EXISTS trg_strict_retirement_delete;
CREATE TRIGGER trg_strict_retirement_delete BEFORE DELETE ON strict_run_retirements
WHEN NOT EXISTS (SELECT 1 FROM administrative_history_permits WHERE run_id = OLD.run_id)
BEGIN SELECT RAISE(ABORT, 'strict_coordinator_required: retirement is immutable'); END;
`
