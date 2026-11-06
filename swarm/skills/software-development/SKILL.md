---
name: software-development
description: Prepare and check software-development-v1 task scope, code snapshots, validation and independent review evidence for the strict Swarm control chain.
---

# Software development domain

Use this domain only when the original task explicitly selects `software-development-v1`.
It supports authorized local code, tests and documentation changes. It does not grant
commit, push, merge, deployment, restart, deletion of a worktree or Agent launch authority.
Do not change an existing RSI Run's pins or reinterpret its receipts.

Read this entire entry and the reference for your actual role:

- Operator / Coordinator: [coordinator](references/coordinator.md).
- Implementation Worker: [implementation](references/implementation.md).
- Independent Reviewer: [review](references/review.md).

Use the existing [Swarm orchestration](../swarm-orchestration/SKILL.md) for startup,
identity, concurrency, messaging, continuation and accounting; use
[worktree delivery](../worktree-delivery/SKILL.md) for independently authorized closeout.
Follow the target checkout's AGENTS.md and more specific role skills first. Do not borrow
materials from an adjacent checkout, install global copies, or expand sparse checkout implicitly.

## Fixed evidence contract

Read [the versioned schema](../../docs/design/software-development-schema.md) before producing
inputs. Pin the task, checker and these four role files with canonical absolute paths and raw
SHA256. Preserve tool-read records, not just an “already read” assertion. Coordinator and
Operator each read the entry plus coordinator reference in their own context; Workers read
the entry plus their role reference. No automatic harness discovery is assumed.

Use `software_development.py --startup <path> --startup-sha256 <hash> --source <path>
--source-sha256 <hash> --output <new-absolute-receipt-path>` from the verified checkout.
The checker only reads files and publishes an immutable consistency receipt. It does not
run a test or authenticate a native object. Keep actual command logs, native object exports
and independent outer audit evidence; never invent them to satisfy schema checks.

Unknown policy values remain unknown, not zero or unlimited. Obtain a decision before an
action requiring an unknown budget or retry allowance. `complete` means ready for acceptance
review, not that lifecycle settlement, Worker release or resource retirement has occurred.
