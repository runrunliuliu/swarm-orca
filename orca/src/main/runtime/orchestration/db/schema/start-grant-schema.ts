// A start grant is minted *before* any Run exists, so it cannot hang off `strict_run_coordinators`
// (whose primary key is `run_id` and which references `runs(id)`). Three insert-only tables instead:
// the grant record, the one Run it may cover, and its revocations.
//
// Why insert-only: `strict_run_coordinators` is worth something exactly because a policy row cannot
// be rewritten, and a grant is that same kind of fact — "who approved what, until when" must not be
// editable by the party being approved. Revocation is therefore a *second* row rather than an update
// of the first, which also keeps "when was this withdrawn, and by whom" durable.
//
// Foreign keys are enforced on both drivers — `node:sqlite`'s DatabaseSync defaults
// `enableForeignKeyConstraints` to true and the bun driver sets `PRAGMA foreign_keys = ON`
// (sqlite/bun-sqlite-database.ts). They are still not the contract: a reader that finds a binding
// without its grant reports it as an invalid record rather than assuming the state is impossible.
// `start-grant-policy.readGrantForRun` does that.
export const START_GRANT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS start_grants (
  grant_id TEXT PRIMARY KEY,
  receipt  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS start_grant_runs (
  grant_id TEXT PRIMARY KEY REFERENCES start_grants(grant_id),
  run_id   TEXT NOT NULL UNIQUE REFERENCES runs(id),
  receipt  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS start_grant_revocations (
  grant_id TEXT PRIMARY KEY REFERENCES start_grants(grant_id),
  receipt  TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS trg_start_grant_update
BEFORE UPDATE ON start_grants
BEGIN SELECT RAISE(ABORT, 'start_grant_immutable: a grant record cannot be changed'); END;
CREATE TRIGGER IF NOT EXISTS trg_start_grant_delete
BEFORE DELETE ON start_grants
BEGIN SELECT RAISE(ABORT, 'start_grant_immutable: a grant record cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS trg_start_grant_binding_update
BEFORE UPDATE ON start_grant_runs
BEGIN SELECT RAISE(ABORT, 'start_grant_immutable: a grant binding cannot be changed'); END;
CREATE TRIGGER IF NOT EXISTS trg_start_grant_binding_delete
BEFORE DELETE ON start_grant_runs
BEGIN SELECT RAISE(ABORT, 'start_grant_immutable: a grant binding cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS trg_start_grant_revocation_update
BEFORE UPDATE ON start_grant_revocations
BEGIN SELECT RAISE(ABORT, 'start_grant_immutable: a revocation cannot be changed'); END;
CREATE TRIGGER IF NOT EXISTS trg_start_grant_revocation_delete
BEFORE DELETE ON start_grant_revocations
BEGIN SELECT RAISE(ABORT, 'start_grant_immutable: a revocation cannot be deleted'); END;
`
