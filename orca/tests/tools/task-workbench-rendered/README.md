# Task workbench rendered proof

```sh
cd orca
ORCA_BACKGROUND_LAUNCH=1 node tests/tools/task-workbench-rendered/run.mjs --fixture f1_baseline --width 1440 --height 900
ORCA_BACKGROUND_LAUNCH=1 node tests/tools/task-workbench-rendered/run.mjs --all
ORCA_BACKGROUND_LAUNCH=1 node tests/tools/task-workbench-rendered/run.mjs --all --calibrate
```

Electron needs a display. On a headless Linux host, point `DISPLAY` at the existing virtual display
(for example `DISPLAY=:99`). The window stays hidden and unfocused; every screenshot is a CDP
`Page.captureScreenshot` of that hidden renderer.

## What it proves

- The production `TaskWorkbenchPanel` and its seven sections render the committed P1a fixtures
  unchanged, one fixture and one window size per run.
- Every `data-testid` in contract §4.3 is present exactly when its condition holds, with the expected
  count, asserted by name. The expectation is derived from the fixture data plus
  `computeTaskWorkbenchLayout` and `countRowBuckets`, not copied from a testid list.
- The rendered `data-wb-layout-json` equals that derivation, and `window.innerWidth/innerHeight`
  equals the requested size, so a screenshot of the wrong size cannot pass as evidence.
- Degradation copy: an unavailable figure is `—` (never `0`/`$0`), Spend prints its reason token
  verbatim, no view prints `Delivered`, an archived-only task shows its card under the archived
  toggle, and a remote workspace shows the remote hint.
- No `pageerror`, and every `BrowserWindow` is `!visible && !focused`.
- A per-run `task-workbench-<fixture>-<w>x<h>.report.json` and a PNG of the same name under
  `.bench-fixtures/` (git-ignored). `--all` also writes `task-workbench-summary.json`.

## What it does not prove

- A screenshot proves layout, not behaviour. There is no click, keyboard, resize or interaction
  path; the collapsible and archived toggles are only asserted in their initial state.
- No store, selector, RPC, persistence or locale switching is exercised. `i18n.ts` serves the
  English defaults; no locale file is fetched.
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
| extra | `f9_long_labels` | 1440×900 |
| calibration | `f1_baseline` | 900×700, 1280×479 |

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
imports to a transparent pixel. No component or source file is modified.
