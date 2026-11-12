"""Collect a bootstrap registration from the places the identity gate actually reads.

Why this exists: `bootstrap_identity` verifies two gate roles against the runtime's own evidence
— `agent-hooks/last-status.json` (session id, launch-token hash) plus `/proc` (pid, start, boot,
uid) — but nothing produced the `registration.json` those checks compare against. A hand-written
registration therefore had to guess the session id (a transcript filename, which the reader
explicitly refuses as evidence) and the pane's process anchor; the gate then answered one bare
`bootstrap_native_identity_changed` for any of the four mismatches. This module removes the
guess: it reads exactly the sources the gate reads, and it crosses the launch token from the
process environment against the hook row so "some other pane with the same session" cannot pass.

What it does not do: it does not decide the provider (the caller declares it, and the hook row
must agree), it does not write any owner slot, and it is not a gate. It prepares one file; the
`serve` call still runs the full identity verification.

One shared-profile caveat that the gate cannot express: `agent-hooks/last-status.json` is a
bounded map shared by every pane on this profile. An entry can be evicted by unrelated agents
between collection and `serve`, so the collection is only as good as its freshness. The receipt
says when each row was observed so the caller can tell how much window it still has.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
from typing import Callable, Iterable

from bootstrap_identity import process as proc_entry
from coordinator_io import canonical, digest, fsync_dir, publish_new, require, now, timestamp

SCHEMA_VERSION = 2
ROLES = ("coordinator", "operator")
HOOKS_RELATIVE = Path("agent-hooks") / "last-status.json"
MAX_HOOK_AGE_SECONDS = 1800


class CollectionRefused(ValueError):
    """A typed refusal carrying the fields that did not line up."""

    def __init__(self, code, **diagnostics):
        super().__init__(code)
        self.diagnostics = diagnostics


def _prefix(value):
    """Enough of an id to recognise it, not enough to be a transcript."""
    text = "" if value is None else str(value)
    return text[:8] + "…" if len(text) > 8 else text


def _environ(pid):
    path = Path("/proc") / str(pid) / "environ"
    raw = path.read_bytes()
    return dict(item.split(b"=", 1) for item in raw.split(b"\0") if b"=" in item)


def _pids_for_handle(handle, root="/proc"):
    """Every live process that claims this terminal handle. Exactly one is expected."""
    found = []
    for entry in sorted(Path(root).iterdir()):
        if not entry.name.isdigit():
            continue
        try:
            env = _environ(int(entry.name))
        except (PermissionError, FileNotFoundError, ProcessLookupError, OSError):
            continue
        if env.get(b"ORCA_TERMINAL_HANDLE") == handle.encode():
            found.append(int(entry.name))
    return found


def _parent_of(pid):
    fields = (Path("/proc") / str(pid) / "stat").read_text().rsplit(")", 1)[1].split()
    return int(fields[1])


def agent_processes(pids, parent_of=None):
    """The agent process among the candidates: the one no other candidate is parent of.

    A pane's handle is inherited by its shell, so "exactly one process claims this handle" is
    wrong in practice (measured: a zsh and its pi child both carry it). The agent is the leaf;
    anything else - two leaves, or none - is refused rather than picked.
    """
    parent_of = _parent_of if parent_of is None else parent_of
    known = set(pids)
    parents = {parent_of(pid) for pid in pids} & known
    return [pid for pid in pids if pid not in parents]


def _hook_entry(hooks, pane):
    entries = hooks.get("entries")
    require(hooks.get("version") == 2 and isinstance(entries, dict),
            "bootstrap_registration_hook_schema")
    entry = entries.get(pane)
    if not isinstance(entry, dict):
        raise CollectionRefused("bootstrap_registration_hook_entry_absent", pane=pane)
    return entry


def _transcript_session(path, log_root):
    """The first line of a pi transcript pins the session it belongs to."""
    target = Path(path)
    require(target.is_relative_to(log_root), "bootstrap_registration_log_outside_root")
    with target.open("rb") as source:
        first = source.readline()
    require(first.endswith(b"\n"), "bootstrap_registration_incomplete_session_meta")
    meta = json.loads(first)
    require(isinstance(meta, dict) and meta.get("type") == "session"
            and isinstance(meta.get("id"), str), "bootstrap_registration_root_session_mismatch")
    return meta["id"]


def refused(role, action, **context):
    """Run one collection step, turning a bare `require` code into a typed refusal.

    `coordinator_io.require` raises `ValueError(code)` without context; a caller that wants
    "which role, which field" needs the code preserved *and* the context attached.
    """
    try:
        return action()
    except CollectionRefused:
        raise
    except ValueError as exc:
        raise CollectionRefused(str(exc), role=role, **context) from None


def collect_role(*, role, terminal, provider, hooks, profile, log_root, clock=None,
                 proc=None, pids_for_handle=None, environ=None, parent_of=None,
                 max_age=MAX_HOOK_AGE_SECONDS):
    """One role's pinned identity, from the same rows the gate reads."""
    proc = proc_entry if proc is None else proc
    pids_for_handle = _pids_for_handle if pids_for_handle is None else pids_for_handle
    environ = _environ if environ is None else environ
    clock = timestamp(now()) if clock is None else clock

    candidates = refused(role, lambda: pids_for_handle(terminal))
    pids = refused(role, lambda: agent_processes(list(candidates), parent_of))
    if len(pids) != 1:
        # Zero means the pane is gone (or this is a resumed/remote pane); more than one leaf means
        # the handle is shared by two agents. Neither is something to guess around.
        raise CollectionRefused("bootstrap_registration_pane_not_unique", role=role,
                                terminal=_prefix(terminal), pids=len(pids),
                                processes=len(candidates))
    pid = pids[0]
    env = environ(pid)
    token = env.get(b"ORCA_AGENT_LAUNCH_TOKEN")
    pane = env.get(b"ORCA_PANE_KEY")
    if not token or not pane:
        raise CollectionRefused("bootstrap_registration_process_unbound", role=role,
                                terminal=_prefix(terminal),
                                launch_token=bool(token), pane_key=bool(pane))
    pane = pane.decode()
    entry = _hook_entry(hooks, pane)
    age = clock.timestamp() - float(entry.get("evidenceObservedAt", 0)) / 1000.0
    if age > max_age or age < -5:
        raise CollectionRefused("bootstrap_registration_hook_stale", role=role, pane=_prefix(pane),
                                age_seconds=round(age, 1))
    for field, expected, observed in (
            ("source", provider, entry.get("source")),
            ("agentType", provider, (entry.get("payload") or {}).get("agentType"))):
        if observed != expected:
            raise CollectionRefused("bootstrap_registration_hook_identity_mismatch", role=role,
                                    field=field, expected=expected, observed=observed)
    for flag in ("structuredHost", "restoredUnconfirmed", "isReplay", "providerSessionOnly",
                 "toolAgentId"):
        if entry.get(flag):
            raise CollectionRefused("bootstrap_registration_hook_unverifiable", role=role,
                                    flag=flag)
    if entry.get("launchTokenHash") != digest(token):
        raise CollectionRefused("bootstrap_registration_launch_token_mismatch", role=role,
                                pane=_prefix(pane))
    session = entry.get("providerSession") or {}
    if session.get("key") != "session_id" or not isinstance(session.get("id"), str) \
            or not session.get("id"):
        raise CollectionRefused("bootstrap_registration_session_absent", role=role,
                                pane=_prefix(pane))
    transcript = session.get("transcriptPath")
    pinned_session = refused(role, lambda: _transcript_session(transcript, Path(log_root)))
    if pinned_session != session["id"]:
        # The hook row names one session, the transcript root another: never pick one.
        raise CollectionRefused("bootstrap_registration_root_session_mismatch", role=role,
                                hook=_prefix(session["id"]), root=_prefix(pinned_session))
    return {
        "process": proc(int(pid)),
        "provider": provider,
        "session": session["id"],
    }, {"pane": pane, "observed_at_ms": entry.get("evidenceObservedAt"),
        "transcript": str(transcript)}


def build(*, bootstrap, expect_attempt, binding_sha256, roles, profile, log_root,
          clock=None, proc=None, pids_for_handle=None, environ=None, parent_of=None):
    """Collect both roles and return (registration, receipt). Refuses on any single mismatch."""
    from bootstrap_events import binding as read_binding, EvidenceReader

    require(set(roles) == set(ROLES), "bootstrap_registration_roles_required")
    hooks_path = Path(profile) / HOOKS_RELATIVE
    try:
        hooks = json.loads(hooks_path.read_text())
    except (OSError, ValueError):
        raise CollectionRefused("bootstrap_registration_hooks_unreadable",
                                profile=str(profile)) from None
    root = Path(bootstrap)
    _, value = refused("attempt", lambda: read_binding(EvidenceReader(), root, binding_sha256,
                                                       expect_attempt))
    collected, receipt = {}, {"roles": {}, "hook_file": str(hooks_path)}
    for role in ROLES:
        declared = roles[role]
        collected[role], observed = collect_role(
            role=role, terminal=declared["terminal"], provider=declared["provider"],
            hooks=hooks, profile=profile, log_root=log_root, clock=clock, proc=proc,
            pids_for_handle=pids_for_handle, environ=environ, parent_of=parent_of)
        receipt["roles"][role] = dict(observed, provider=declared["provider"],
                                      terminal=_prefix(declared["terminal"]))
    registration = {
        "schema_version": SCHEMA_VERSION,
        "attempt_binding": {"path": str(root / "attempt-binding.json"), "sha256": binding_sha256},
        "log_root": str(log_root),
        "profile": str(profile),
        "roles": collected,
    }
    receipt["attempt_id"] = value["attempt_id"]
    receipt["execution_authorized"] = False
    return registration, receipt


def write(output, registration, *, read_back=True, env_lookup=None):
    """Publish once (never overwrite), then read the bytes back and compare."""
    target = Path(output)
    # `publish_new` writes `canonical(value) + newline`; the read-back must compare that form.
    raw = canonical(registration) + b"\n"
    if target.parent and not target.parent.exists():
        target.parent.mkdir(parents=True, mode=0o700)
        fsync_dir(target.parent)
    if target.exists():
        if target.read_bytes() == raw:
            return {"path": str(target), "sha256": digest(raw), "created": False}
        raise CollectionRefused("bootstrap_registration_output_conflict", path=str(target))
    publish_new(target, registration)
    if read_back:
        actual = target.read_bytes()
        if actual != raw:
            raise CollectionRefused("bootstrap_registration_output_unreadable", path=str(target))
    return {"path": str(target), "sha256": digest(target.read_bytes()), "created": True}


def cli_main(argv=None):
    parser = argparse.ArgumentParser(
        description="Pin a bootstrap registration from the runtime rows the identity gate reads.",
        epilog="Exit: 0 written, 2 refused (usage, hook/token/session mismatch), "
               "3 nothing to do (identical file already present). Not a gate; serve still verifies.")
    parser.add_argument("--bootstrap", required=True)
    parser.add_argument("--expect-attempt", required=True)
    parser.add_argument("--attempt-binding-sha256", required=True)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--log-root", required=True)
    parser.add_argument("--coordinator", required=True, help="coordinator terminal handle")
    parser.add_argument("--coordinator-provider", required=True)
    parser.add_argument("--operator", required=True, help="operator terminal handle")
    parser.add_argument("--operator-provider", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    try:
        registration, receipt = build(
            bootstrap=args.bootstrap, expect_attempt=args.expect_attempt,
            binding_sha256=args.attempt_binding_sha256,
            roles={"coordinator": {"terminal": args.coordinator,
                                   "provider": args.coordinator_provider},
                   "operator": {"terminal": args.operator, "provider": args.operator_provider}},
            profile=args.profile, log_root=args.log_root)
        ref = write(args.output, registration)
        payload = dict(ok=True, event="bootstrap_registration", exit=0, execution_authorized=False,
                       registration=ref, receipt=receipt)
        print(json.dumps(payload, ensure_ascii=False) if args.json else ref["path"])
        return 0
    except CollectionRefused as exc:
        payload = dict(ok=False, event="bootstrap_registration", exit=2, reason=str(exc),
                       diagnostics=exc.diagnostics, execution_authorized=False)
        print(json.dumps(payload, ensure_ascii=False))
        return 2


if __name__ == "__main__":
    raise SystemExit(cli_main())
