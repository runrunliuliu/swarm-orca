# Worktree create sparse checkout and long-checkout recovery plan

## Status

Design proposal. Not implemented, not deployed, and not a claim that current
Orca releases support CLI sparse worktree creation. The observed failure mode is
from a public-safe `swarm-orca` checkout and contains no private runtime IDs or
session excerpts.

## Problem

Creating a new `swarm-orca` worktree through Orca can be slow enough that the
caller sees `runtime_unavailable` even though the runtime is still healthy and
the host-side `git worktree add` may still be running.

The high-level cause is a mismatch between operation size and transport shape:

- `swarm-orca` has roughly 31k tracked files.
- The worktree base directory can live on network / NAS-backed storage.
- A normal `git worktree add` eagerly checks out every tracked file.
- The current `worktree.create` RPC waits synchronously for the whole create
  path: base resolution, `git worktree add`, re-listing, metadata persistence,
  symlinks / shared paths / `.worktreeinclude`, setup preparation, and startup
  terminal creation.
- When checkout takes longer than the CLI / transport wait budget, the caller may
  receive `runtime_unavailable` while the underlying Git process is still active.
- Retrying immediately can create duplicate branches / directories or leave
  `locked initializing`, `index.lock`, and an index that appears to delete most
  tracked files.

Skipping setup hooks (`--setup skip`) avoids `pnpm install`, but it does not
avoid the eager checkout of tens of thousands of files.

## Goals

1. Make large-repository worktree creation fast for scoped tasks by checking out
   only the directories that are needed.
2. Keep the existing full-checkout behavior as the default unless the caller
   explicitly asks for sparse checkout or selects a preset.
3. Make long create operations observable and recoverable: a transport timeout
   must not look the same as a runtime crash.
4. Avoid duplicate creates after ambiguous failures.
5. Preserve current lineage, metadata, setup, terminal startup, and catalog
   invalidation semantics for full checkouts.

## Non-goals

- Do not make sparse checkout the default for every repository.
- Do not silently hide files from an agent that was not told it is running in a
  sparse workspace.
- Do not change Git history, branch naming, or worktree path rules.
- Do not treat `runtime_unavailable` as proof that the create failed.
- Do not bypass Git's `locked initializing` protection by default.

## Existing implementation hooks

Several pieces already exist in the codebase:

- `CreateWorktreeArgs.sparseCheckout?: { directories: string[], presetId?: string }`
  in `src/shared/worktree/create-types.ts`.
- `createLocalWorktree` / `createRemoteWorktree` already branch into
  `addSparseWorktree(...)` when `sparseCheckout.directories` is non-empty.
- Worktree metadata already records `sparseDirectories`, `sparseBaseRef`, and
  `sparsePresetId` for created sparse worktrees.
- The create timing payload already reports phases and can distinguish
  `preparedCheckout` misses with reason `sparse_checkout`.

The gap is primarily product / CLI / orchestration plumbing plus ambiguous
long-operation recovery.

## Proposal

### Phase 1: expose explicit sparse creation in CLI

Add CLI flags to `worktree create`:

```text
orca worktree create \
  --repo id:<repo-id> \
  --name <name> \
  --base-branch <sha-or-ref> \
  --setup skip \
  --sparse-dir swarm \
  --sparse-dir orca/src/main/ipc \
  --json
```

Suggested shape:

- `--sparse-dir <repo-relative-directory>` may be repeated.
- `--sparse-dirs <json_array>` is optional for automation-friendly callers.
- Reject mixing `--sparse-dir` and `--sparse-dirs` unless their normalized sets
  are identical.
- Normalize with the same rules as `normalizeSparseDirectories` on the runtime
  side; the CLI should fail early for absolute paths, `..`, empty entries, and
  file-looking values.
- Require at least one directory when any sparse flag is present.
- Include the sparse selection in JSON output so callers can print a clear
  warning that the workspace is sparse.

Implementation touch points:

- `src/cli/specs/core.ts`: document flags and examples.
- `src/cli/handlers/worktree.ts`: parse sparse flags and pass
  `sparseCheckout: { directories }` to `worktree.create`.
- `src/cli/flag-help-text.ts` and root help snapshots/tests.
- CLI tests next to existing `index-worktree-create-*.test.ts`.

### Phase 2: expose sparse placement for supervised workers

Add the same sparse selection to `orchestration worker-start` only when the
placement creates a new worktree:

```text
orca orchestration worker-start \
  --task <task-id> \
  --worktree new-top-level \
  --repo id:<repo-id> \
  --name <name> \
  --base-branch <sha> \
  --setup skip \
  --sparse-dir swarm \
  --agent codex \
  --json
```

Rules:

- Reject sparse flags for `current`, exact existing worktrees, and
  `--terminal <handle>` reuse.
- Forward sparse directories through orchestration placement / worker start to
  the underlying `worktree.create` call.
- Record sparse selection in Dispatch / resource metadata if the worker owns the
  created worktree, so recovery and release messages can warn about sparse
  scope.

Implementation touch points:

- `src/cli/specs/orchestration-worker-specs.ts`.
- `src/cli/handlers/orchestration/worker-placement-flags.ts`.
- `src/cli/handlers/orchestration/worker-launch-handler.ts`.
- Native orchestration worker-start request / placement schema and tests.
- `swarm/supervisor/engine.py` can later opt in for Swarm tasks whose allowed
  paths are entirely contained by the sparse directories.

### Phase 3: presets for common large repositories

Support named presets in the existing `SparsePreset` model:

- CLI: `--sparse-preset <id-or-name>`.
- UI / project settings: save reusable sparse sets per repo.
- Repo-local public suggestions may be documented, but do not auto-apply a
  private user's preset in a public checkout.

Example `swarm-orca` presets:

| Preset | Directories | Intended use |
| --- | --- | --- |
| `swarm-only` | `swarm` | Python supervisor, skills, docs, tests |
| `orca-worktree-create` | `orca/src/cli`, `orca/src/main/ipc`, `orca/src/main/git`, `orca/src/shared/worktree` | Worktree create / removal code |
| `orca-runtime` | `orca/src/main/runtime`, `orca/src/shared`, `orca/src/cli` | Runtime / CLI protocol changes |

### Phase 4: make create recoverable after transport timeout

Sparse checkout reduces runtime, but full checkout must still be safe. Add an
operation identity and recovery surface around `worktree.create`.

Suggested behavior:

1. Every create mutation gets a `creationId` / request ID before Git starts.
2. The runtime persists an in-flight create receipt with repo, target path,
   branch, base, sparse request, setup decision, and current phase.
3. The CLI prints the request ID when a transport timeout occurs.
4. `orca worktree create-status --request <id> --json` (or the existing
   mutation request recovery surface if it can be shared) reports:
   - `pending`: Git process still running or metadata not finalized;
   - `completed`: worktree ID and startup terminal if available;
   - `failed`: stable failure and cleanup state;
   - `unknown`: runtime restarted before it could seal the receipt.
5. Repeating create with the same request ID joins / replays the original
   operation; repeating without it is refused when the same repo/path/branch is
   still `initializing`.

Minimum viable version:

- Do not add a new UI; add CLI and tests for idempotent create recovery.
- Persist enough information to avoid duplicate branch/path attempts.
- Preserve current create response on success.

### Phase 5: safer cleanup for initializing worktrees

When a create times out and `git worktree list` shows `locked initializing`:

- Do not auto-unlock or remove while the creator process is still alive.
- If the process is gone, classify the state before cleanup:
  - directory absent;
  - directory present with valid `.git` file;
  - metadata has `index.lock`;
  - index appears empty / all tracked files look deleted;
  - branch exists and is checked out only by this worktree.
- Provide a guided cleanup command that reports exactly what it will delete.
- Prefer native catalog / Git cleanup first; raw filesystem deletion is only a
  documented last step after ownership is proven.

This phase should align with `swarm/skills/worktree-delivery/SKILL.md` guidance:
ambiguous transport errors need reconciliation before replay or cleanup.

## User-visible semantics

A sparse worktree must be obvious:

- `worktree show/list` should expose `isSparse: true` and sparse directories.
- CLI create output should include a warning such as:
  `Workspace is sparse; files outside [swarm, orca/src/main/ipc] are intentionally absent.`
- `terminal create` / `worker-start` should not hide sparse state from the
  prompt generation path; workers should be told their checkout is sparse.

## Validation plan

### Unit / deterministic tests

- CLI parser accepts repeated `--sparse-dir` and JSON `--sparse-dirs`.
- CLI rejects absolute paths, `..`, empty entries, and sparse flags with existing
  worktree placement.
- `worktree.create` receives `sparseCheckout.directories` exactly once after
  normalization.
- Local create calls `addSparseWorktree` and records `sparseDirectories` metadata.
- Create timing reports sparse path and does not attempt prepared checkout.
- Worker-start passes sparse only for `new-top-level` / `new-child`.
- Idempotent create recovery joins an in-flight request and refuses duplicate
  path/branch creation without a matching request ID.

### Integration / manual acceptance

On a large repo fixture or `swarm-orca`:

1. Full create still succeeds and reports timing.
2. Sparse create of `swarm` materializes far fewer files than full checkout.
3. Sparse create is visible in `worktree show/list`.
4. Agent startup in a sparse worktree receives a sparse warning.
5. Killing or timing out the CLI during create does not cause a duplicate create;
   status / replay recovers the receipt.
6. A stale `locked initializing` worktree is not removed while a live
   `git worktree add` process still owns it.

## Rollout plan

1. Implement CLI sparse flags for `worktree create` only.
2. Validate on `swarm-orca` with `--setup skip --sparse-dir swarm`.
3. Add orchestration worker-start sparse placement.
4. Add create recovery / idempotency improvements for long full checkouts.
5. Add UI preset support only after CLI and native behavior are stable.

## Open questions

- Should `--sparse-dir` accept files, or only directories? Directory-only is
  simpler and matches cone mode; file support would require non-cone behavior and
  different performance expectations.
- Should sparse worktrees be allowed with setup hooks? Setup may assume the full
  repository exists. The safe default is to allow it only when the user explicitly
  passes `--setup run`, and to warn when hooks are present.
- Should sparse directories be stored in public repo config or only user profile
  presets? Public suggestions are useful; automatic private policy is not.
- Can prepared checkout be extended to sparse checkouts, or should sparse always
  bypass the prepared pool? Initial implementation should bypass; later work can
  add sparse-keyed preparation.
