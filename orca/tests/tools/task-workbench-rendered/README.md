# Task workbench rendered proof

```sh
cd orca
ORCA_BACKGROUND_LAUNCH=1 node tests/tools/task-workbench-rendered/run.mjs --fixture f1_baseline --width 1440 --height 900
ORCA_BACKGROUND_LAUNCH=1 node tests/tools/task-workbench-rendered/run.mjs --fixture d1_dock_collapsed --width 1440 --height 900
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
- F8's failed row has exactly one overlay dot with `data-dot-state="failed"`, its outcome badge says
  `Failed`, and the view does not claim `Delivered`.
- The rendered `data-wb-layout-json` equals that derivation, and `window.innerWidth/innerHeight`
  equals the requested size, so a screenshot of the wrong size cannot pass as evidence.
- Degradation copy: an unavailable figure is `—` (never `0`/`$0`), Spend prints its reason token
  verbatim, no view prints `Delivered`, an archived-only task shows its card under the archived
  toggle, and a remote workspace shows the remote hint.
- No `pageerror`, and every `BrowserWindow` is `!visible && !focused`.
- A per-run `task-workbench-<fixture>-<w>x<h>.report.json` and a PNG of the same name under
  `.bench-fixtures/` (git-ignored). `--all` also writes `task-workbench-summary.json`.
- **The dock (`d1_dock_collapsed`, `d2_dock_expanded`).** The production `TaskDock` is rendered
  inside the padded column whose class is imported from `Frame.tsx`
  (`TASK_PAGE_COLUMN_CLASS`) around a scrollable card holding a real `PaginationBar`; the fixture
  drives the dock from local state and records what it asked for in `data-dock-submits`,
  `data-dock-last-instruction` and `data-dock-expanded` on the fixture root.
- Per dock run, by name: every `data-testid` in the state it should be in (collapsed has
  `task-dock`, `task-dock-input`, `task-dock-submit`, `task-dock-expand` and no chip/cancel/error;
  expanded adds `task-dock-chip` with text `github · acme/widgets` and `task-dock-cancel`), no
  unexpected id; `task-dock` is **not** a descendant of the card and both are children of the same
  column; `dock-fixture-card-footer` is inside the card and the pagination `<nav aria-label="Pagination">`
  is inside that footer.
- Acceptance point 1, the card gives up height instead of the page scrolling: with the list scrolled
  to 160, expanding/collapsing keeps `scrollTop` at 160, `window.scrollY` stays 0 and
  `document.scrollHeight` equals `window.innerHeight`; the card's client height shrinks by the dock's
  growth and grows back when the dock collapses (78 px at 1440×900: 745 → 667, dock 38 → 116). The
  three numbers are in the run report under `dock.geometry`.
- Acceptance point 1, the keyboard path: typing reaches the dock's controlled input, `⌘+Enter`
  (`Control+Enter` off darwin) submits exactly once with that instruction, `Esc` collapses and keeps
  the text, and the expand button restores the expanded state.

## What it does not prove

- Screenshots prove layout; the named DOM assertions are the pass/fail verdict. For the workbench
  fixtures there is no click, keyboard, resize or interaction path; the collapsible and archived
  toggles are only asserted in their initial state. The only interaction exercised anywhere is the
  dock's keyboard path.
- The dock fixtures mirror `Frame.tsx`'s column through the imported `TASK_PAGE_COLUMN_CLASS` instead
  of mounting `TaskPageFrame`, which needs the 39-stage task-page model and a live store the harness
  deliberately does not have. `TaskPageListChrome` and `TaskPageContent` are therefore absent, and the
  list rows are synthetic.
- No store, selector, RPC, persistence or locale switching is exercised. `i18n.ts` serves the
  English defaults; no locale file is fetched. The dock's `onSubmit` only increments a counter in
  fixture state, so nothing proves the `taskDraft` workspace, the scratch directory or the agent
  launch behind it.
- The sidebar draft row, the preview card and the tracker write are out of scope for P2a and
  unproven here.
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
| S11 (mandatory) | `d1_dock_collapsed` | 1440×900 |
| S12 (mandatory) | `d2_dock_expanded` | 1440×900 |
| S13 | `d2_dock_expanded` | 1100×800 |
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

`fixture.css` names `components/task-page` as a Tailwind `@source`: the Vite root is this
directory, so automatic content detection cannot see the classes of the dock and the pagination
bar, and without it those fixtures render unstyled (no flex, no height cap, no overflow), which
would make the card geometry assertion meaningless.
