# Task workbench rendered proof

```sh
cd orca
ORCA_BACKGROUND_LAUNCH=1 node tests/tools/task-workbench-rendered/run.mjs --fixture f1_baseline --width 1440 --height 900
ORCA_BACKGROUND_LAUNCH=1 node tests/tools/task-workbench-rendered/run.mjs --fixture d5_sidebar_draft_row --width 1440 --height 900
ORCA_BACKGROUND_LAUNCH=1 node tests/tools/task-workbench-rendered/run.mjs --all
ORCA_BACKGROUND_LAUNCH=1 node tests/tools/task-workbench-rendered/run.mjs --all --calibrate
```

Electron needs a display. On a headless Linux host, point `DISPLAY` at the existing virtual display
(for example `DISPLAY=:99`). The window stays hidden and unfocused; every screenshot is a CDP
`Page.captureScreenshot` of that hidden renderer.

## What it proves

- The production `TaskWorkbenchPanel` and its seven sections render the committed P1a and delivery
  fixtures unchanged, one fixture and one window size per run.
- Every `data-testid` in contract §4.3 is present exactly when its condition holds, with the expected
  count, asserted by name. The expectation is derived from the fixture data plus
  `computeTaskWorkbenchLayout` and `countRowBuckets`, not copied from a testid list.
- F8's failed row has exactly one overlay dot with `data-dot-state="failed"`, its outcome badge says
  `Failed`, and the view does not claim `Delivered`.
- The rendered `data-wb-layout-json` equals that derivation, and `window.innerWidth/innerHeight`
  equals the requested size, so a screenshot of the wrong size cannot pass as evidence.
- Degradation copy: an unavailable figure is `—` (never `0`/`$0`), Spend prints its reason token
  verbatim, no view prints `Delivered`, an archived-only task shows its card under the archived
  toggle, and a remote workspace shows the remote hint.
- **The run-history strip (issue #31, record rows from issue #53).** F2c renders the archived form:
  the strip exists, its facts line contains `agents` / `wall` / `tokens`, the archived note and the
  two trace placeholders are present, and the two archived agent rows sit in the History fold with
  the same count. Its record list holds two `fromRecord` rows — the only kind the archived form may
  list, because its live rows already are the Agents section — each with a `locate trace` action and
  a per-row `resume`, which is why the strip has no strip-level resume left to assert. F2d renders
  the deleted form: no `task-workbench-empty-state`, no Agents / Workspaces section, exactly two run
  rows, the trace-lost sentence, and neither `0 tokens` nor `$0` anywhere. F2c at 900×700 asserts
  `data-compact="true"` plus the Details control, and no note/action is mounted until it is used.
- No `pageerror`, and every `BrowserWindow` is `!visible && !focused`.
- **`f15_delivered` / `f16_delivered_archived` / `deliver_confirm` at the widths in the matrix**
  (`1440×900`, `900×700`, `720×660`); PNGs and `*.report.json` land under `.bench-fixtures/`.
- **The delivered row (§7.12).** `f15_delivered` renders the production Delivery row in its
  delivered state: one `task-workbench-delivery-state` reading `Delivered`, one facts line reading
  `Issue #412 closed` (the PR fact is already printed by the evidence strip, so it is not repeated),
  and one enabled `Open session` entry; the workspace row carries the store's own `Done` status.
  `f16_delivered_archived` renders the archived workspace: the state signature reads `Archived`,
  the facts survive, and there is no entry action at all. Both are checked against the projection
  the components read (`state`, `data-state`, state word, facts text), not against a copied string.
- **The delivery confirmation's deliver scope (§7.12 D1).** `deliver_confirm` renders the production
  `TaskWorkbenchDeliverConfirm` directly (the static pass never clicks the entry that opens it):
  the panel is not a dialog and has no `aria-modal`, the submit keeps `outline`, and the scope
  defaults are checked per control — create-PR checked and disabled, merge and close-issue checked,
  archive-after unchecked, with the close label naming `#412` from the prop.
- **The delivery entry (§7.11.3).** Six production projections are rendered: no workspace and an
  archived workspace have no entry; one writer has one disabled `Deliver…` entry with `title`,
  `aria-disabled` and an `sr-only` described reason; an existing `DELIVER` session has one enabled
  `Open terminal` entry; evidence-not-read and read-with-zero-evidence each have one enabled
  `Deliver…` entry. The zero-evidence row has no commit, PR, checks or review claim, and every
  rendered state asserts that the shared confirmation is still closed.
- A per-run `task-workbench-<fixture>-<w>x<h>.report.json` and a PNG of the same name under
  `.bench-fixtures/` (git-ignored). `--all` also writes `task-workbench-summary.json`.
- **The sidebar draft row (`d5_sidebar_draft_row`).** The production
  `renderFolderWorkspaceVirtualRow` (the narrowest component that renders `folder-row.tsx`'s
  marker) in a real virtual-list container, driven by the real store (`taskDraftLinkMissing: {}`).
  Three rows: a draft linked to GitHub `#412`, an unlinked draft, and a normal folder workspace.
  Per row by `data-worktree-row-key`: the linked row has one `folder-draft-badge` reading `draft`
  and one `folder-draft-link` reading `linked to #412`; the unlinked row has the badge and no link;
  the normal row has neither and no `folder-draft-task-removed`. The document-level expected counts
  are badge 2 / link 1.
- **The GitHub task rows (`d6_github_task_rows`).** The production `TaskPageGitHubRows` with five
  rows — working, delivered, workspace-without-agent, needs-you, and one with no bound workspace —
  driven by a hand-built page-model stub and a committed `rowActivityByKey` map. Per row, located by
  title: the `data-row-activity` kind, the badge's visible label, the tracker pill still reading
  `Open`, and the badge rectangle inside the viewport, so a mark squeezed out at the narrow width
  fails. The fifth row must have no badge at all.

## What it does not prove

- Screenshots prove layout; the named DOM assertions are the pass/fail verdict. For the workbench
  fixtures there is no click, keyboard, resize or interaction path; the collapsible and archived
  toggles are only asserted in their initial state. The delivery popover is likewise never opened
  here; its open state and controls are covered by `TaskWorkbenchDelivery.deliver.test.tsx` and
  `task-workbench-deliver-confirm.test.tsx`, not by a faked harness interaction.
- No store, selector, RPC, persistence or locale switching is exercised. `i18n.ts` serves the
  English defaults; no locale file is fetched. F2d's `trace: 'deleted'` is fixture data: no
  persisted probe can produce it yet (issue #31 S2), so this run proves the rendering, not the
  live deletion path.
- The sidebar row is rendered with a no-op row context and no project-group header, so selection,
  drag, path status, PR decoration and grouping are not exercised. `folder-draft-task-removed` and
  the archived row state are not rendered here; they are covered by `folder-draft-marker`'s unit
  tests.
- The GitHub task rows are rendered with a hand-built model and a committed activity map, so the
  selector rules behind those claims are covered by `lib/task-workbench/task-workbench-row-activity`
  unit tests and the store wiring by `use-task-page-github-row-activity.test.tsx`, not here. No row
  is clicked; the tracker pill's popover is never opened.
- The 1100/480 thresholds are design assumptions. S2 (1100×800) and S3 (1280×480) sit exactly on the
  inclusive boundaries (`>= 1100` is double, `< 480` is short), so they prove the boundary still
  fits, not the degraded layout. `--calibrate` adds 900×700 (single column) and 1280×479 (short)
  to exercise those branches.
- Compact Workspaces with more than two workspaces is not run; the compact branch renders `+N more`
  rather than the secondary toggle.

## Screenshot matrix

| id | fixture | size |
| --- | --- | --- |
| S1 (mandatory) | `f1_baseline` | 1440×900 |
| S2 (mandatory) | `f1_baseline` | 1100×800 |
| S4 (mandatory) | `f2a_zero_workspace_open` | 1440×900 |
| S3 | `f1_baseline` | 1280×480 |
| S5 | `f2b_zero_workspace_closed` | 1440×900 |
| S6 | `f3_many_workspaces_agents` | 1440×900 |
| S7 | `f4_usage_disabled` | 1440×900 |
| S8 | `f7_remote_workspace` | 1440×900 |
| S9 | `f10_ambiguous_session`, `f11_no_matching_session` | 1440×900 |
| S10 | `f5_archived_only`, `f6_no_tracker`, `f8_failure_outcome`, `f12_new_workspace_no_agents` | 1440×900 |
| F2c | `f2c_archived_only_closed` | 1440×900 |
| F2c-narrow | `f2c_archived_only_closed` | 900×700 |
| F2d | `f2d_deleted_with_history` | 1440×900 |
| extra | `f9_long_labels` | 1440×900 |
| P2b sidebar row | `d5_sidebar_draft_row` | 1440×900 |
| G1 (mandatory) | `d6_github_task_rows` | 1440×900 |
| G2 | `d6_github_task_rows` | 900×700 |
| calibration | `f1_baseline` | 900×700, 1280×479 |

The P2b sidebar row is a single-fixture run, not part of `--all`: it is listed here as the evidence
name, and the driver still writes the same per-run report JSON and PNG.

## Delivery fixture renders

These six images match §7.4.5's evidence tier: they are **fixture renders, not live-machine
screenshots** — fixture → production `TaskWorkbenchPanel` → CDP screenshot. Every image uses the
standard wide viewport 1440×900 with `devicePixelRatio = 1`; the harness asserts both values before
the run can pass. Reused states come from the existing matrix run rather than a duplicate fixture.

| state | fixture · per-run report | design evidence image |
| --- | --- | --- |
| no workspace | `f2a_zero_workspace_open` · `task-workbench-f2a_zero_workspace_open-1440x900.report.json` | `ui/impl-20261119-deliver-no-workspace.png` |
| archived | `f5_archived_only` · `task-workbench-f5_archived_only-1440x900.report.json` | `ui/impl-20261119-deliver-archived.png` |
| one writer | `f1_baseline` · `task-workbench-f1_baseline-1440x900.report.json` | `ui/impl-20261119-deliver-one-writer.png` |
| existing session | `f13_existing_deliver_session` · `task-workbench-f13_existing_deliver_session-1440x900.report.json` | `ui/impl-20261119-deliver-existing-session.png` |
| evidence not read | `f12_new_workspace_no_agents` · `task-workbench-f12_new_workspace_no_agents-1440x900.report.json` | `ui/impl-20261119-deliver-evidence-not-read.png` |
| zero evidence | `f14_zero_delivery_evidence` · `task-workbench-f14_zero_delivery_evidence-1440x900.report.json` | `ui/impl-20261119-deliver-zero-evidence.png` |

## Known contract edge

Radix `CollapsibleContent` keeps a hidden, empty wrapper in the DOM when closed. With
`layout.delivery === 'collapsed'` the `task-workbench-delivery-body` element still exists with
`data-state="closed" hidden="" style="display:none"`, and the same holds for
`task-workbench-agents-history-records`. Contract §4.3 says those ids must not exist when the
condition does not hold, so the two `--calibrate` runs fail on exactly those ids; the S1–S10 matrix
never collapses either group, so it passes. Moving the `data-testid` to the element inside
`CollapsibleContent` would satisfy the contract and keep the animation.

## Environment note

This sparse task checkout omits `orca/resources`, and `agent-catalog.tsx` imports the OpenClaude
logo from it. No fixture renders that icon, so the harness Vite build resolves `resources/*` asset
imports to a transparent pixel. The sidebar row imports the card graph, which reaches the same
module, so it relies on that same resolution; no component or source file is modified.

`fixture.css` names `components/task-page`, `components/sidebar` and
`components/task-page-source-context.tsx` as Tailwind `@source`s: the Vite root is this directory, so
automatic content detection cannot see the classes of the sidebar row or of the GitHub task row (its
`grid-cols` template lives in `task-page-source-context.tsx`), and without them those fixtures render
unstyled — no flex, no height cap, no overflow, or one column where the row should have six — which
would make the screenshots meaningless.
