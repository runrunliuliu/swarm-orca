# swarm-orca

Reusable Swarm orchestration and Orca integration tools.

This repository is being initialized from a reviewed snapshot. It does not yet
claim to be a deployable implementation.

## Layout

- `orca/` contains a source snapshot derived from the private integration workspace source tree
  tree. See `orca/UPSTREAM.md` for provenance notes and remaining upstream
  baseline verification.
- `swarm/` contains reusable Swarm orchestration code and public-safe examples.

## Scope

Only reviewed, general-purpose code, documentation, and examples belong here.
Organization-specific integrations, private configuration, credentials, and
runtime data must remain outside this repository.

## Integration

Other repositories may consume this project as a Git submodule pinned to a
specific commit. Deployment instructions will be added with the implementation.

## Agent entry points

Start with [AGENTS.md](AGENTS.md). Its task-to-skill index provides Orca CLI/native orchestration,
Swarm coordination, and worktree delivery workflows without a private parent checkout or global
skill installation. Deployment-specific configuration and domain roles are explicit inputs; see
[configuration](swarm/configuration.md).

## Task-centric development model (design)

The [task workspace design](swarm/docs/design/task-workspaces.md) separates task identity from
Projects and terminals. One task can span multiple repositories, with dedicated worktrees created
before modification, reused across conversation entry points, and delivered per repository with
task-level acceptance. This is a design direction, not a claim that automatic routing or enforced
write isolation is implemented.

## Release status

This tree has been copied for migration work only. Do not publish it until the
remaining privacy, license, upstream-baseline, and build/test checks in
`MIGRATION_STATUS.md` are complete.
