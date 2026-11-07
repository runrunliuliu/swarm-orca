// Why its own module: these are M0 wire-contract limits a client must be able to check before it
// sends a task sparse request, so they cannot live in main-only code — but they are values, and
// `create-types.ts` stays a pure type module. Only the `task-workspace-v1` request path applies
// them; a legacy sparse payload keeps its historical behavior (no count or byte cap added here).
export const SPARSE_TASK_MAX_DIRECTORY_COUNT = 128
export const SPARSE_TASK_MAX_DIRECTORY_UTF8_BYTES = 16 * 1024
export const SPARSE_TASK_MAX_REQUIRED_PATH_COUNT = 256
export const SPARSE_TASK_MAX_REQUIRED_PATH_UTF8_BYTES = 32 * 1024
