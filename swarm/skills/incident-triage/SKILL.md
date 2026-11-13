---
name: incident-triage
description: >-
  Read a host's incident facts, pane event clocks and raw failed-tool-call rows, cluster them as an
  independent triage context, and produce a reviewable report with proposed decisions. Use when asked
  to triage incidents, decide whether a quiet pane is stuck, or turn a failed-tool cluster into a
  repair candidate. Never write code, never apply decisions, never mark an incident confirmed.
---

# Incident triage

Read this skill in full. Paths are relative to this file. Orca stores **facts**; this skill is where
the judgement lives (M8 removed clustering, thresholds, candidate rules and error normalisation from
the main process). You are the analysis layer, and your output is a report — not a database change.

## 0. Contract and permissions

- **R1 only.** You may propose a status; only a human or an explicitly separate R1 context records it
  with `orca incident decide`. If the caller has not said you are acting as R1, do not run `decide`.
- **Never `confirmed`.** That status needs an explicit actor and a reason a human owns. A report can
  recommend it; it cannot set it.
- **No auto-apply.** The old `mine --apply` is deleted; there is no replacement flag. Proposals are
  commands for R1 to run, listed in the report.
- **Read-only input.** `orca incident export` opens the store read-only. Do not edit incident rows,
  decisions, dispatch/task state, or any repository file. The only file you write is the report.
- **Unknowns stay unknown.** A missing fact, a truncated window or an uncovered provider is stated as
  unavailable/partial — never converted into "no problem" or "failed".

## 1. Capture the input

```bash
# One line per record; keep the raw bytes as immutable input.
orca incident export --since 7d --json > incident-export.ndjson
sha256sum incident-export.ndjson
```

Records are NDJSON with `kind`:

| `kind` | Meaning |
| --- | --- |
| `meta` | view name, `exportVersion`, window, generatedAt, **coverage**, tool providers, mirror state |
| `incident` | one immutable incident row plus its projected `effectiveStatus` and archive summary |
| `pane_clock` | one pane's last semantic event and age (a fact, not a verdict) |
| `tool_failure` | one failed tool call with the provider's own `errorKind`/`exitCode` |
| `end` | counts, window totals, `truncated` flags, dropped tool failures |

If `orca incident export` is unknown, the installed CLI predates M8: stop and report the version
instead of substituting `list --json` (it omits run/task/dispatch ids, evidence pointers and decisions).

## 2. Completeness gate (before any conclusion)

Read the `meta` and `end` records first. Any of these makes the window **partial**:

| Check | What a bad value means |
| --- | --- |
| `meta.view == incident_triage_rows` and `exportVersion == 1` | Unknown shape: stop, do not guess field meanings |
| `end.truncated.incident` / `.tool_failure` | The numbers are a floor over the window; never call them totals |
| `coverage.shadowReplay.incomplete` or `dropped > 0` | Facts recorded before a crash may be missing |
| `coverage.capacityLatchSet` / `currentlyLimited` | The store refused writes at some point / now; counts are a lower bound |
| `coverage.paneClock.errors` / `skipped` | The sampler failed or skipped observations |
| `meta.toolProviders.uncovered` non-empty | Silence from those agents is not health; name them in the report |
| `meta.mirror.capture` is `unsupported`/`not_probed`, or `unsynced` is `null` | Remote facts are not covered / never read / count unstated — not zero |
| `meta.coverage.remoteIncidentCapture` is `unsupported` | This host records only its own facts |

Write one of three verdicts into the report: **complete** (no gap fired), **partial** (list every gap),
**unavailable** (no store/meta). An empty `incident`/`tool_failure` section with any gap is
"no concluded pattern", never "no incidents".

## 3. Read the facts correctly

- `status` is the immutable entry status; `effectiveStatus` is the decision projection. Triage the
  effective status.
- `evidence.pointers` is a pointer list (`path`, `sha256`, offsets, bytes) — never a body. `archive`
  says what happened to the excerpt: `pointers` on the row, and `staged/pending/archived/incomplete`.
  **`archive.durable` is true only when every pointer is archived**; do not call evidence durable
  otherwise, and say so when `archive.pointers == 0` (nothing was offered).
- `pane_clock.ageMs` is computed at read time from `lastSemanticEventAt`, falling back to
  `stateStartedAt` when the host never reported a semantic clock. `ageBasis: state_fallback` is a
  weaker signal and must be labelled as such. There is **no threshold in Orca**: the threshold is
  your judgement, and choosing one is not a fact.
- `declaredWait` is an operator's "expected quiet" note for the same pane epoch. It is context, not a
  suppression rule; an expired declaration is simply absent.
- `tool_failure.errorKind` / `exitCode` are provider-supplied and unmodified. There is no normalised
  code, no window and no severity. Do not invent `permission_denied` from text.

## 4. Cluster

Cluster by a **stable entity**, not by the epoch inside `sourceId`:

| Source | Stable key (strip the epoch) |
| --- | --- |
| `status_stall` | `paneKey` |
| `tool_error` | `sessionId` + `toolName` + (`errorKind`/`exitCode`) |
| `acceptance` | `dispatchId` + `facet`/rule id |
| `pty_exit` | agent session, else worktree, else run |
| `self_report` | request id — participates only by `class` + `code`, never as a reproducible source |

Suggested rules (advice, not code — state the rule you used and its numbers):

- repeat pattern: at least 3 rows from at least 2 distinct stable entities in the window;
- a signalled crash or the same `acceptance_failed` invariant may qualify on 2 rows, still from 2
  distinct entities;
- one entity repeating is `single_entity_recurrence`: report it, do not escalate it;
- rows already `duplicate`/`invalid`/`closed` are triaged; exclude them and say how many;
- low information (`unknown` exit cause, null `errorKind` with no exit code, self-report without a
  reproducible code) is marked and sorted last; it may justify `watch`/`invalid`, never a confident
  `needs_archive`;
- a cluster is a *reading*, not an identity: `fingerprint` groups rows but does not prove one bug.

Every cluster must cite the `id`s it used and the distinct entities counted.

## 5. Propose decisions

Allowed proposals from `untriaged`: `watch`, `duplicate`, `invalid`, `needs_archive`. `confirmed` is
R1-only and requires an explicit `--actor`; terminal states (`duplicate`/`invalid`/`closed`) are final.
Never propose `needs_archive` for a single-entity recurrence; never propose `duplicate` without naming
the row it duplicates.

For each proposal emit the exact command for R1, for example:

```bash
orca incident decide inc_example_1 --to watch \
  --actor '<r1-name>' --reason 'repeat_fingerprint: rows=4 entities=3 window=7d'
```

If the caller explicitly authorises you to act as R1 and supplies the actor name, you may run those
commands after the report is written and archived; otherwise list them and stop.

## 6. Write the report

Use `report-template.md`. Both Markdown and JSON must carry:

- `exportVersion`, `view`, `since`, `generatedAt`, `inputSha256` (of the captured NDJSON);
- `completeness` (`complete|partial|unavailable`) and the exact gap list;
- `rowsUsed` (incident ids, tool-failure keys, pane keys actually read) and `sourceKeys`;
- `clusters` with the rule, counts, entities and row ids;
- `proposed` (`{id, to, why}`) and the commands for R1;
- `unknowns`, `coverage` (local + tool providers + mirror) and per-incident `archive.durable`.

The report is the reproducibility record: a reader must be able to re-run the same export and see why
each row was used. If a section was truncated, say so next to the number, not in a footnote.

## 7. Archive the report

Default location (deployment may override): `<ORCA_INCIDENT_ARCHIVE_ROOT>/triage/<host>/<UTC stamp>/`
with `report.md` and `report.json`. Do not put the report inside an incident's evidence directory.

```bash
sha256sum report.md report.json      # after writing
# read the copies back and compare the digests before citing the path
```

Cite durability precisely: the report is archived when its own read-back matched; incidents are
durable only when `archive.durable` is true. If `ORCA_INCIDENT_ARCHIVE_ROOT` is unset, keep the report
local, mark it `durable=false`, and say where it is.

## 8. Stop

Do not change code, dispatches, tasks, incident rows or decisions beyond the explicitly authorised R1
commands. Do not merge, deploy, restart a service or prune. End with: report path, completeness
verdict, proposals and who must execute them, plus what remained unknown.
