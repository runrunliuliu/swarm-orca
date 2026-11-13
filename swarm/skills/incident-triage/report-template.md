# Incident triage report — `<window>`

- generatedAt: `<UTC timestamp>`
- view / exportVersion: `incident_triage_rows` / `1`
- since / window: `<epoch ms>` / `<duration>`
- inputSha256: `<sha256 of the captured NDJSON>`
- completeness: `<complete|partial|unavailable>`
- coverage: shadowReplay=`<incomplete? dropped?>` capacity=`<latch? limited?>` paneClock=`<errors/skipped>`
- tool providers: covered=`<list>` uncovered=`<list>`
- mirror: capture=`<unsupported|not_probed|mirrored>` unsynced=`<n|null>`
- rowsUsed: `<incident ids, tool-failure keys, pane keys actually read>`
- sourceKeys: `<stable entities after removing the epoch>`

## Verdict

`<complete|partial|unavailable>` — `<one sentence naming every gap that fired, or "no gap">`.

> A partial window means the numbers below are a floor, not a total. An empty section plus a gap is
> "no concluded pattern", never "no incidents".

## Clusters

### `<rule-name>` — `<class>` / `<fingerprint>`

- rows: `<count>` epoch rows, `<count>` distinct stable entities (`<dimension>`)
- rule used: `<e.g. 3 rows from 2 entities in 7d>`
- first / last seen: `<timestamps>`
- row ids: `<inc_…, inc_…>`
- stable keys: `<paneKey|session+tool+errorKind/exit|dispatch+rule|…>`
- low information / single entity: `<yes/no + why>`
- reading: `<what the rows support; explicitly what they do not prove>`

## Evidence durability

| incident | pointers | staged | pending | archived | incomplete | durable |
| --- | --- | --- | --- | --- | --- | --- |
| `<inc_…>` | `<n>` | `<n>` | `<n>` | `<n>` | `<n>` | `<true/false>` |

`durable=false` means do not cite the evidence as archived. `pointers=0` means no evidence was offered
(the crash path has no transcript pointer by design), not that staging failed.

## Proposed decisions

| incident | to | why | command for R1 |
| --- | --- | --- | --- |
| `<inc_…>` | `<watch\|duplicate\|invalid\|needs_archive>` | `<rule + counts + entities>` | `orca incident decide <id> --to <status> --actor '<r1>' --reason '<why>'` |

`confirmed` is not proposed here: it requires an explicit R1 actor. Terminal states are final.

## Unknowns

- `<missing fact / truncated section / uncovered provider / unprobed mirror → what it prevents concluding>`

## Archive

- report: `<path>` sha256 `<digest>` (read back: `<match|mismatch>`)
- incident evidence: `<per-incident archive state; durable only when every pointer is archived>`
