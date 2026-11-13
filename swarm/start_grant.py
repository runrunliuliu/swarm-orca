"""Mint, hand over and read the state of a Run start grant (start grant, M4).

The grant itself lives in the runtime's database and is written by `orchestration.startGrantMint`,
because a caller cannot read its own launch token and so cannot assemble the minter identity the
server verifies. What this module owns is the *record the minter submits*: it is built once, written
once, submitted byte-for-byte, and never regenerated — a retry has to resubmit the same bytes or the
mint reports a record conflict instead of a replay.

Three commands, and none of them is a gate:

* `mint`  build the record from reviewed inputs, publish it as one immutable file, submit that file;
* `hand`  deliver the grant id plus the record's `{path, sha256}` to a Coordinator, once;
* `state` read the grant back and compare it with the local record.

What this module cannot do: create a Run (that is `run-create --grant`, and it refuses without a
grant), widen a grant, or make a revocation disappear. A mint is not an approval of the objective's
*content* — the minter is the party that read the approval.

Exit status: 0 success, 2 usage/transport, 4 unverifiable (no answer, or the record on disk is not
the one that was submitted), 5 refused by a typed reason.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import uuid

from coordinator_io import file_ref, now, publish_new, timestamp

MINTED = 0
USAGE_OR_TRANSPORT = 2
UNVERIFIABLE = 4
REFUSED = 5

SCHEMA_VERSION = 1


class Refused(Exception):
    """A typed refusal: the answer is no, and the caller can tell why."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def objective_hash(text):
    """The objective hash the runtime compares against.

    `hashCanonical` is `sha256(JSON.stringify(value))`; for a string that is the quoted text with
    JavaScript's escaping. `ensure_ascii=False` is what keeps non-ASCII identical to JavaScript's —
    the default would spell the same text differently and every mint would then mismatch the Run.
    """
    encoded = json.dumps(text, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def build_record(*, objective, max_workers, deadline, task_source, repos,
                 writable_roots=(), authorization=(), spend="none"):
    """The record as it will be submitted: no `minter`, which the server writes itself."""
    deadline_at = timestamp(deadline)
    minted_at = now()
    if deadline_at <= timestamp(minted_at):
        raise Refused("deadline_not_after_mint_at")
    if not isinstance(max_workers, int) or max_workers < 1:
        raise Refused("max_workers_invalid")
    for label, item in [("task_source", task_source), *[("authorization", a) for a in authorization]]:
        if not Path(item).is_absolute():
            # The ref is evidence: a relative path names whatever the caller's cwd happened to be,
            # and a later re-read from another directory would hash a different file.
            raise Refused(f"{label}_not_absolute")
    source = Path(task_source)
    if not source.is_file():
        raise Refused("task_source_missing")
    if not repos:
        raise Refused("repos_required")
    record = {
        "schemaVersion": SCHEMA_VERSION,
        "kind": "start_grant",
        "grantId": str(uuid.uuid4()),
        "objectiveText": objective,
        "objectiveHash": objective_hash(objective),
        "taskSource": file_ref(source),
        "authorizationRefs": [file_ref(Path(item)) for item in authorization],
        "maxWorkers": max_workers,
        "repos": repos,
        "writableRoots": list(writable_roots),
        "spend": _spend(spend),
        "deadline": deadline_at.isoformat(),
        "mintedAt": minted_at,
        "executionAuthorized": False,
    }
    return record


def _spend(value):
    if value == "none":
        return {"kind": "none"}
    if value.startswith("capped:"):
        amount = value.split(":", 1)[1]
        try:
            limit = float(amount)
        except ValueError:
            raise Refused("spend_invalid") from None
        if limit <= 0:
            raise Refused("spend_invalid")
        return {"kind": "capped", "limitUsd": limit}
    raise Refused("spend_invalid")


def parse_repo(value):
    """`<repo-id>` or `<repo-id>:<worktree-id>[,<worktree-id>]` → the record's repo scope."""
    repo_id, separator, worktrees = value.partition(":")
    if not repo_id:
        raise Refused("repo_id_missing")
    if not separator:
        return {"repoId": repo_id, "worktreeIds": None}
    if not worktrees:
        # A trailing colon says "these worktrees" and then names none: silently widening it to the
        # whole repo would turn a typo into a much broader approval.
        raise Refused("repo_worktree_empty")
    ids = [item for item in worktrees.split(",") if item]
    if not ids:
        raise Refused("repo_worktree_empty")
    return {"repoId": repo_id, "worktreeIds": ids}


def record_path(record, directory):
    return Path(directory) / f"{record['grantId']}.json"


def mint(*, record, directory, from_handle, cli="orca", runner=None):
    """Publish the record, then submit that exact file. Returns the runtime's answer."""
    runner = _invoke if runner is None else runner
    target = record_path(record, directory)
    target.parent.mkdir(parents=True, exist_ok=True)
    payload = (json.dumps(record, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode()
    try:
        publish_new(target, payload)
    except FileExistsError:
        # One grant id names one record. Same bytes is the same attempt, different bytes is two
        # approvals wearing one id, and the file is what the retry has to reproduce.
        if target.read_bytes() != payload:
            raise Refused("record_exists_with_other_contents") from None
    code, stdout = runner([cli, "orchestration", "start-grant-mint",
                           "--record-file", str(target), "--from", from_handle, "--json"])
    answer = _answer(code, stdout)
    return {"record": file_ref(target), "grant_id": record["grantId"], "answer": answer}


def hand(*, grant_id, record_ref, to_handle, cli="orca", runner=None):
    """One plain mailbox delivery. Not the strict handoff envelope, which has its own acceptor."""
    runner = _invoke if runner is None else runner
    payload = {
        "schema_version": SCHEMA_VERSION,
        "kind": "start_grant_handoff",
        "grant_id": grant_id,
        "record": {"path": record_ref["path"], "sha256": record_ref["sha256"]},
    }
    subject = f"start grant {grant_id}"
    code, stdout = runner([cli, "orchestration", "send", "--to", to_handle,
                           "--subject", subject,
                           "--payload", json.dumps(payload, ensure_ascii=False, sort_keys=True),
                           "--json"])
    return {"delivered_to": to_handle, "answer": _answer(code, stdout)}


def state(*, grant_id, record=None, cli="orca", runner=None):
    """The grant as the runtime has it, plus whether the local record still is what was submitted."""
    runner = _invoke if runner is None else runner
    code, stdout = runner([cli, "orchestration", "start-grant-show",
                           "--grant", grant_id, "--json"])
    answer = _answer(code, stdout)
    result = {
        "grant_id": grant_id,
        "grant": answer.get("grant"),
        "state": answer.get("state"),
        "run": answer.get("run"),
        "workers": answer.get("workers"),
    }
    if record is not None:
        path = Path(record)
        try:
            local = file_ref(path)
            authored = json.loads(path.read_text())
        except (OSError, ValueError):
            local, authored = None, None
        result["local_record"] = local
        # The interesting case is "the file I would re-submit is not the record the runtime holds":
        # a retry would then be refused as a conflict instead of replaying, which is why state reports
        # it instead of letting the mint discover it. `minter` is excluded because the server writes
        # it and the client never sees its own launch token.
        result["local_matches_runtime"] = (
            authored is not None
            and _authored(authored) == _authored(answer.get("grant") or {})
        )
    return result


def _authored(record):
    """The part of a record the minter wrote, canonically: everything except the server's `minter`."""
    if not isinstance(record, dict):
        return None
    return json.dumps({k: v for k, v in record.items() if k != "minter"},
                      ensure_ascii=False, sort_keys=True)


def _invoke(argv):
    try:
        completed = subprocess.run(argv, capture_output=True, text=True)
    except OSError:
        return None, ""
    return completed.returncode, completed.stdout


def _answer(code, stdout):
    """The runtime's `result` body, or a refusal carrying the typed code it printed."""
    payload = _parse(stdout)
    if code is None:
        raise Refused("cli_unavailable")
    if not isinstance(payload, dict):
        raise Refused("answer_unreadable")
    if payload.get("ok") is False:
        error = payload.get("error")
        reason = error.get("code") if isinstance(error, dict) else None
        raise Refused(reason if isinstance(reason, str) and reason else "answer_refused")
    body = payload.get("result")
    if not isinstance(body, dict):
        raise Refused("answer_shape")
    return body


def _parse(text):
    text = (text or "").strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except ValueError:
        pass
    payload = None
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("_keepalive"):
            continue
        try:
            payload = json.loads(line)
        except ValueError:
            continue
    return payload


def _payload(**fields):
    return dict(fields)


def emit(value, as_json):
    if as_json:
        print(json.dumps(value, ensure_ascii=False, sort_keys=True))
        return
    if "answer" in value:
        print(value.get("grant_id") or value.get("delivered_to"))
        return
    print(json.dumps(value, ensure_ascii=False, sort_keys=True))


def main(argv=None):
    parser = argparse.ArgumentParser(description="Start grants: mint, hand over, read the state.")
    parser.add_argument("--cli", default="orca", help="executable to call (default: orca)")
    parser.add_argument("--json", action="store_true", help="print one JSON line")
    commands = parser.add_subparsers(dest="command", required=True)

    mint_parser = commands.add_parser("mint", help="build, publish and submit one grant record")
    mint_parser.add_argument("--objective", required=True)
    mint_parser.add_argument("--max-workers", required=True, type=int)
    mint_parser.add_argument("--deadline", required=True)
    mint_parser.add_argument("--task-source", required=True)
    mint_parser.add_argument("--repo", action="append", default=[], required=True)
    mint_parser.add_argument("--writable-root", action="append", default=[])
    mint_parser.add_argument("--authorization", action="append", default=[])
    mint_parser.add_argument("--spend", default="none")
    mint_parser.add_argument("--from", dest="from_handle", required=True)
    mint_parser.add_argument("--record-dir", required=True)

    hand_parser = commands.add_parser("hand", help="deliver one grant to a Coordinator")
    hand_parser.add_argument("--record", required=True)
    hand_parser.add_argument("--to", dest="to_handle", required=True)

    state_parser = commands.add_parser("state", help="read the grant back")
    state_parser.add_argument("--grant", required=True)
    state_parser.add_argument("--record")

    args = parser.parse_args(argv)
    try:
        if args.command == "mint":
            record = build_record(
                objective=args.objective,
                max_workers=args.max_workers,
                deadline=args.deadline,
                task_source=args.task_source,
                repos=[parse_repo(item) for item in args.repo],
                writable_roots=args.writable_root,
                authorization=args.authorization,
                spend=args.spend,
            )
            emit(mint(record=record, directory=args.record_dir, from_handle=args.from_handle,
                      cli=args.cli), args.json)
        elif args.command == "hand":
            reference = file_ref(Path(args.record))
            grant_id = json.loads(Path(args.record).read_text()).get("grantId")
            emit(hand(grant_id=grant_id, record_ref=reference, to_handle=args.to_handle,
                      cli=args.cli), args.json)
        else:
            emit(state(grant_id=args.grant, record=args.record, cli=args.cli), args.json)
    except Refused as refusal:
        print(f"refused: {refusal.reason}", file=sys.stderr)
        return REFUSED
    return MINTED


if __name__ == "__main__":
    sys.exit(main())
