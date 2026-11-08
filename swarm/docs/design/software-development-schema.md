# Software development v1 wire contract

This is the local implementation contract for `software-development-v1`, not live
acceptance or authorization. Python is standard-library only. `ref` below always means
the existing exact `{path, sha256}` raw-byte pin. Paths are canonical absolute paths;
timestamps include a timezone. Unknown fields on domain records are rejected.

## Versions and actual callers

| Record / entry | Version and behavior |
| --- | --- |
| Startup contract | Existing v2 plus explicit `domain_binding`; included in `identity()` |
| Original S0 handoff | JSON object containing the exact `domain_binding` and original task prose/metadata; remains pinned by existing `handoff` |
| Prepare inputs | v2 requires `domain_binding`; v1 remains RSI only |
| Continuation config | Existing v2 plus exact startup `domain_binding`; no v3 scheduler fork |
| Software binding / task / source / receipt | Each has integer `schema_version: 1` |
| Task `sparse_task_binding` | Optional mirror of Orca `WorktreeMeta.sparseTaskBinding`; absent means legacy |
| Acceptance | Existing exact `{"requirements": [...]}`; no new top-level fields |
| RSI configurations | Existing v1/v2 authority behavior and pins retained; no implicit migration |

The original fixed handoff prevents removing domain selection while preparing session
fields. Startup identity prevents changing it between session and first-dispatch gates.
Config must match startup; mixing `authority_binding` with software is rejected. Software
contracts are TUI-only. New session builders preserve the extra field with existing TTLs.
Strict-start also matches objective and `max_workers`; original task deadline matches the
request and continuation, not the separate bounded bootstrap handshake deadline.

| Existing caller | Added responsibility |
| --- | --- |
| `coordinator_startup.validate/identity` | Fixed handoff, binding, role reads; domain is part of startup identity |
| `coordinator_request_prepare` / `coordinator_strict_start` | Original task limits remain bound during request/start validation |
| `startup_handoff.candidate_template` | Project software binding, acceptance and deadline into prepare v2 |
| `coordinator_tui_prepare` | Static selection and current snapshot before exclusive publication; continuation ref still last |
| `coordinator_tui_checkpoint` → `coordinator_domain` | One projection validator, fixed dispatch to historical RSI or software checker |
| `coordinator_tui_continue` | Same config/gates/claim/settle journal; current bytes before a new claim |
| `coordinator_tui_workflow` | Current next checkpoint before submission; historical claimed checkpoint still settles after edits |
| `coordinator_tui_turn_end` / scheduler pre-send | Current frontier bytes; unchanged owner, generation, STOP, timing, send reconciliation and ACK boundaries |
| `operator_monitor_deploy.sources` | Existing transitive Python source inventory already includes both new modules |

Historical checkpoint validation reads archived snapshot bytes, not whatever an action
has since written to the worktree. New prepare/claim/workflow submission/turn-end/send
boundaries verify current bytes. `complete` always verifies current bytes, even when read
as history. No source timestamps or pins are refreshed automatically.

## Binding and original task

`domain_binding` exact fields:

```text
schema_version: 1
adapter: software-development-v1
contract: ref                 # software task below
checker: ref                  # exact running software_development.py, never imported from input
materials: {skill: ref, coordinator: ref, implementation: ref, review: ref}
reads: {operator: ref, coordinator: ref}
```

Materials are the four files under the verified workspace's
`swarm/skills/software-development/`. An operator/coordinator read record is exactly
`{actor, materials, source_records}`: actor equals its startup identity, materials equals
`[skill, coordinator]`, and source_records is a nonempty list of readable actual tool records.
Keep these refs in the startup handoff. Existing generic bootstrap prompt bytes are unchanged;
the explicit domain handoff and role reference supply software instructions, not RSI recipes.
Preparing this declaration does not prove actual full reading; the independent audit must do so.

Task exact fields:

```text
schema_version: 1
task_id: nonempty string
objective: original objective string
acceptance: ref
repository: {root, worktree, branch, base_commit}
baseline: ref
scope: {read_roots: [path], write_roots: [path], exclude_paths: [path], operations: [string]}
policy: {max_workers, token_budget, cost_budget, deadline, retry_limit, stop_conditions}
authority_review: ref
sparse_task_binding: optional {pinned_sha, worktree_path, branch,
                               requested_sparse_cone: [string], required_paths: [string]}
```

Repository root/worktree are existing directories; worktree equals startup workspace.
Base commit is a full 40/64-character Git hash. Branch/commit/native ownership remain
externally audited facts, not a claim the checker invoked Git or Orca.

Read roots include the worktree and necessary evidence locations. Write roots stay inside
the worktree. Exclusions are explicit, including `.git` and any deliberately unreadable
subtrees; the checker does **not** attest excluded contents/changes. There are no implicit
Gitignore exclusions: visible untracked files count. Excluded files never become writable
by declaring them in a change manifest. Archive evidence outside the worktree so creating
records cannot change the snapshot being certified. Output receipt must be outside the
worktree, within both observation roots and task `read_roots`, and outside exclusions,
so the consumer can read it under the same task scope. An output outside this intersection
is rejected with `software_receipt_output_outside_scope` before publication. No implicit
directory creation.

Operations are a nonempty subset of `modify, create, delete, test, review`. `max_workers`
is a positive integer; token budget/retry limit are nonnegative integers or explicit null;
cost budget is nonnegative numeric or null; deadline is a timestamp or explicit null.
Null records an unknown/unspecified value, not a fresh grant of infinite budget or retries.
Nonempty stop conditions preserve the operator's decision rules. The checker does not
execute operations or account tokens; normal native admission and approved policy still apply.

Every acceptance requirement keeps its original specs and adds `verification: test|manual`.
Manual verification requires a nonempty immutable `manual_method`. Completion requires
applicable validation and independent review, not just a successful command exit status.
For manual validation, `command` must equal that original `manual_method`. Both test and
manual validation require the `test` operation; review records require `review`.

The authority review is exactly `{actor, approved, inputs, source_records}`. Actor equals
startup Operator, approved is true, and inputs equals all original task fields except
schema_version and authority_review. Source records must include original authorization
and the independently produced review record, not evidence invented by the candidate.

## Optional sparse task workspace binding

`sparse_task_binding` is written only for a workspace created from a task sparse receipt. It is
a written-down mirror of the Orca `WorktreeMeta.sparseTaskBinding`, copied into the reviewed
record so a later reader can cross-check the handoff without re-reading Orca metadata. Its keys
are exactly `{pinned_sha, worktree_path, branch, requested_sparse_cone, required_paths}`:
`pinned_sha` is a full 40/64-character lowercase Git hash, `worktree_path` and `branch` are
nonempty strings, and both lists are deduplicated string lists (empty allowed, because Orca allows
a create with no required paths and an empty cone). Anything else,
including an extra or missing key, fails with `software_sparse_binding_invalid` without echoing
record contents.

Absence is the normal legacy state, not a broken record: full checkouts, legacy sparse worktrees,
externally adopted folders and every existing record and caller simply carry no binding, so no
migration is implied and no workspace is silently upgraded. Presence is also not an equality
claim: this record does not require `worktree_path` to equal `repository.worktree`, because one
logical task may bind several repository worktrees, and `pinned_sha` is not compared with
`repository.base_commit`.

The binding is reference material only. It grants no scope, authority, write permission or
isolation, and it is not a readiness or existence proof: the checker opens no path from it and
probes no HEAD. Readiness is decided by re-reading the live worktree and its
`WorktreeMeta.sparseTaskBinding` (Orca start gate), and any drift there is not repaired or
reported by this record. An empty cone or required-path list is accepted here for the same
reason Orca accepts it: rejecting it would make a real workspace impossible to mirror. Because the review signs
the task as written, a task carrying the field also carries it in `authority_review.inputs`;
that keeps the generic "all task fields" rule true without making the mirror an authorization.

## Baseline, current snapshot and changes

Baseline exact fields: `{repository, files, inventory_records}`.
Each file is `{path, content: ref|null, tracked: bool, dirty: bool, owner, diff: ref|null}`.
Content must be an archived copy outside the worktree, not a pin of a live file that will be modified. Untracked
files are dirty. Tracked dirty files require archived diff evidence. Content may be null
only for an initially deleted tracked dirty file. Other rows have null diff unless tracked
and dirty. Initial dirty files can change only when owner equals task_id; ownership is
independently reviewed with the baseline. A new task does not acquire old dirty files.

The first inventory record is a normalized Git/tool export containing `repository` and
`files: [{path, sha256, tracked, dirty}]` in baseline order; sha256 is null for initial deletion.
The checker matches every row, including untracked files. Keep raw inventory/diff records in
the remaining inventory_records. Export authenticity and capture-time completeness require
outer audit; a self-authored normalized export is not Git execution proof.

Source snapshot rows are `{path, sha256, content: ref}` in path order, unique by path.
The snapshot hash is SHA256 of canonical `[{path, sha256}, ...]`, **not** archive locations.
Every content hash must match. Current verification inventories all visible worktree files,
rejects symlinks, and compares the entire snapshot before and after evidence IO. Scope is
checked before content reads. No filesystem snapshot isolation or hostile same-UID protection
is claimed; concurrent writers must be stopped/coordinated by the existing ownership policy.

Changes are the exact sorted difference from baseline:
`[{path, operation: create|modify|delete, before: sha256|null, after: sha256|null}]`.
Out-of-write-scope changes, disallowed operations, missing rows or externally owned dirty
overwrites are rejected. Excluded-path/Git metadata changes require separate external audit.

## Source and evidence

Source exact fields:

```text
schema_version: 1, adapter, task_id, runtime, run_id, generation,
contract_sha256, observed_at,
requirements, paths, barriers, decision, next_action,
snapshot, changes, actions: [ref], validations: [ref], reviews: [ref],
audit: ref|null, pending_operations: [string]
```

`contract_sha256` is the raw task pin; Run/generation/runtime match startup. The five
generic fields use `coordinator_loop.checkpoint_route/transition` unchanged. Requirements
cannot disappear or change specs. Before any requirement is met, evidence lists can be
empty and audit is null. Missing evidence cannot be made up to enable first prepare.

All action/validation/review records have these common fields:
`{id, task_id, run: {id, generation}, runtime, requirements: [requirement ID],
snapshot_sha256, actor: native worker handle, source_records: [ref]}`.
IDs are unique across all three lists. Exact additional fields:

| Kind | Additional fields |
| --- | --- |
| actions | `action_id, native_task, dispatch, inputs: [ref], outputs: [ref], materials: [ref], read_evidence: ref` |
| validations | `action: evidence ID, method: test|manual, command, cwd, started_at, ended_at, exit_code: int, passed: bool, reports: [ref], tool` |
| reviews | `action: evidence ID, decision: approved|changes_requested, findings: [string], resolves: [review ID], reviewed_at` |

Inputs, outputs, reports and source_records are nonempty. Action materials are the shared
skill plus implementation/review reference. Worker read_evidence has the same read schema,
with actor equal to the native handle. Validation/review actor, snapshot and requirement
coverage must match its action. Review actions must carry the review reference.

The first action source record is a normalized native export with matching `runtime, run,
action_id, task: {id, run_id}, dispatch: {id, task_id, worker_handle}`. The first validation
or review source record is `{kind: validations|reviews, record: <that record without source_records>}`.
Keep raw native/tool records as additional refs. These are normalized evidence records,
**not new Orca RPC responses**; no native object is created or authenticated by this helper.

A met requirement's evidence is a nonempty list of `{kind: software-development-v1,
ref: evidence ID}`. Each selected record covers that requirement and current snapshot.
At least one validation must pass with exit code zero and the original verification method.
At least one no-findings approved review must be from an actor distinct from all implementing
actors and passing validators for that requirement. Every `resolves` entry must name an
existing review record ID. Every recorded rejection needs a later approved review listing its ID
in resolves. Do not discard old rejected reviews on resubmission;
history retention and native provenance remain part of the outer audit.

For any met requirements, audit is exactly `{actor, snapshot_sha256, evidence, verified,
source_records}` with the original Operator, matching snapshot, exact ordered concatenation
of all three evidence-ref lists, verified true and readable source records. It is an audit
declaration whose authenticity requires independent execution; the checker cannot certify itself.

Barrier `evidence_refs` must be a list of IDs of these readable evidence records; malformed
barrier rows are rejected with a fixed domain error. A blocked requirement with no remaining
path needs path_review_ref naming a review. Native waiting uses existing
`prerequisites: ["orca-dispatch:<id>"]`; the dispatch must exist in the linked action exports.
Job-only software waiting is not supported in v1. Live dependency status remains checked
by the existing scheduler, not inferred from the software record.

## Receipt and CLI

The thin CLI accepts pinned startup/source paths and hashes and a new output path. It
performs current validation and immutable `publish_new`; overwrite, failure recovery/retry,
command execution, dispatch and lifecycle completion are not offered. JSON errors have
fixed public codes, not raw private contents. Exact success receipt fields:

```text
schema_version: 1, adapter, ok: true, consistent: true, grants_authority: false,
coverage, source: ref, binding_sha256, checker: ref, runtime, run,
task_id, snapshot_sha256, decision, next_gate
```

Consumers reconstruct the result and compare it exactly with the pinned receipt, then
check the common projection. There are no RSI authority/context hashes. `next_gate` for
complete is `acceptance_review`, never resource retirement. Coverage explicitly states
file/record consistency only; real execution/identity still require external audit.

## Verification scope

`test_software_development.py` covers file/scope/provenance and completion checks;
it also pins the optional sparse binding: legal record, absent field, and rejection of extra
keys, bad SHA, empty or duplicated lists.
`test_coordinator_domain.py` reuses startup, prepare, scheduler and workflow fixtures,
including a real local file edit between claim and settlement and subsequent scheduling.
These are deterministic offline tests with mocked native receipts, not native integration
or a live three-turn Agent loop. Independent implementation review and M4 live acceptance
remain separate, explicitly authorized work. No service deployment is part of this change.
