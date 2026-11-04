"""Swarm ledger CLI. sync reads native state; no command launches/wakes models."""

import argparse
import json
import os
import sqlite3
import sys

from supervisor.config import SafetyError, require
from supervisor.store import lock
from .codex import scan
from .ledger import Ledger, timestamp
from .native import Reader
from .report import export
from . import binding as host_binding, runtime_binding, trae, trae_jsonl


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--state", required=True, help="dedicated owner-private, canonical ledger directory")
    sub = p.add_subparsers(dest="command", required=True)
    commands = {}
    for name in ("sync", "report", "usage-import", "scan-codex", "scan-trae", "scan-trae-jsonl", "capture-trae", "coordinator", "finish"):
        s = commands[name] = sub.add_parser(name)
        s.add_argument("--runtime-id", required=True)
        s.add_argument("--run", required=True)
    s = commands["sync"]
    s.add_argument("--cli", required=True, help="same verified Orca executable used to read the skill")
    s.add_argument("--environment")
    s.add_argument("--bindings", help="private JSON array of explicit Codex / Trae usage bindings")
    s.add_argument("--require-worker-bindings", action="store_true",
                   help="refuse sync if any non-final Worker lacks an explicit usage binding")
    s.add_argument("--output", help="export ledger after successful collection")
    s = commands["usage-import"]
    s.add_argument("--file", required=True)
    s.add_argument("--agent-id", required=True, help="Dispatch ID or coordinator")
    s.add_argument("--final", action="store_true", help="attest ALL this actor's usage is covered")
    s = commands["capture-trae"]
    for flag in ("agent-id", "binding", "cli", "socket", "output"):
        s.add_argument("--" + flag, required=True)
    s = commands["scan-trae"]
    for flag in ("agent-id", "file"):
        s.add_argument("--" + flag, required=True)
    choice = s.add_mutually_exclusive_group(required=True)
    choice.add_argument("--baseline")
    choice.add_argument("--dedicated-session", action="store_true", help="attest this ENTIRE thread belongs to this actor")
    s.add_argument("--semantics", choices=("unverified", "cumulative-inclusive"), default="unverified")
    s.add_argument("--semantics-source", help="evidence for inclusive, cumulative, non-resetting counters")
    s.add_argument("--final", action="store_true", help="attest ALL this actor's threads/turns are covered")
    s = commands["scan-trae-jsonl"]
    for flag in ("agent-id", "file", "binding", "since", "until"):
        s.add_argument("--" + flag, required=True)
    s.add_argument("--final", action="store_true", help="unverified JSONL raw counters cannot be finalized")
    s = commands["scan-codex"]
    for flag in ("file", "agent-id", "session-id", "since", "until"):
        s.add_argument("--" + flag, required=True)
    s.add_argument("--final", action="store_true", help="attest ALL this actor's usage is covered")
    s = commands["coordinator"]
    s.add_argument("--started-at", required=True)
    s.add_argument("--ended-at")
    s.add_argument("--source", required=True)
    s.add_argument("--provider")
    s.add_argument("--model")
    s = commands["finish"]
    s.add_argument("--ended-at", required=True)
    s.add_argument("--outcome", required=True, choices=("succeeded", "failed", "cancelled"))
    s.add_argument("--source", required=True)
    s = sub.add_parser("runtime-preflight", help="check local Codex/Trae runtime-state binding; no Run or usage import")
    for flag in ("runtime-id", "cli", "binding"):
        s.add_argument("--" + flag, required=True)
    sub.add_parser("export").add_argument("--output", required=True)
    return p


def read_json(path):
    with open(path, encoding="utf-8") as source:
        return json.load(source)


def trae_sample(ledger, runtime, run, binding):
    current = trae.load_snapshot(binding["file"])
    trae.check_scope(ledger, runtime, run, binding["agent_id"], current["binding"])
    baseline = trae.load_snapshot(binding["baseline"]) if binding.get("baseline") else None
    return trae.scan(current, baseline, dedicated=binding.get("dedicated_session", False),
                     semantics=binding.get("semantics", "unverified"), semantics_source=binding.get("semantics_source"))


def trae_jsonl_sample(ledger, runtime, run, options):
    bound = trae_jsonl.check_scope(ledger, runtime, run, options["agent_id"], read_json(options["binding"]))
    since = timestamp(options["since"])
    # Check the previous observed prefix as well as the original binding anchor.
    # A later scan may append, but must not rewrite already imported log history.
    samples = ledger.get(runtime, run)["agents"][options["agent_id"]]["samples"].values()
    prior = [s["raw_usage"]["capture"] for s in samples if "raw_usage" in s and
             s["session_id"] == bound["thread_id"] and s["since"] == since]
    return trae_jsonl.scan(options["file"], bound, since, options.get("until") or ledger.now(),
                          previous=prior[0] if prior else None)


def main(argv=None):
    os.umask(0o077)
    args = parser().parse_args(argv)
    ledger = Ledger(args.state)
    try:
        with lock(ledger.store.root, "ledger.lock"):
            if args.command == "export":
                value = export(ledger, args.output)
            elif args.command == "runtime-preflight":
                value = runtime_binding.preflight(ledger, Reader(args.cli, args.runtime_id), read_json(args.binding))
            else:
                runtime, run = args.runtime_id, args.run
                if args.command == "sync":
                    native = Reader(args.cli, runtime, args.environment)
                    run_row, workers = native.collect(run)
                    bindings = read_json(args.bindings) if args.bindings else []
                    require(isinstance(bindings, list), "bindings must be an array")
                    for binding in bindings:
                        require(isinstance(binding, dict), "binding must be an object")
                        require(binding.get("provider") in ("codex", "trae"), "unsupported usage binding provider")
                        require(type(binding.get("final", False)) is bool, "binding.final must be boolean")
                    with ledger.transaction():
                        value = ledger.sync(runtime, run_row, workers,
                                            binding_agent_ids=[b.get("agent_id") for b in bindings])
                        coverage = value["usage_binding_coverage"]
                        require(not args.require_worker_bindings or not coverage["missing_worker_ids"],
                                "worker_usage_bindings_missing: every non-final Worker needs an explicit usage binding")
                        if bindings:
                            for binding in bindings:
                                if binding.get("format") == "runtime-state":
                                    sample = runtime_binding.ledger_sample(ledger, native, runtime, run, binding)
                                elif binding["provider"] == "codex":
                                    if binding.get("format") == "host-receipt":
                                        sample = host_binding.ledger_sample(ledger, runtime, run, binding)
                                    else:
                                        require(binding.get("format") in (None, "jsonl"), "unsupported Codex binding format")
                                        require(not binding.get("final") or binding.get("until"), "final binding needs fixed until")
                                        sample = scan(binding["file"], binding["session_id"], binding["since"],
                                                      binding.get("until") or ledger.now())
                                elif binding.get("format") == "jsonl":
                                    sample = trae_jsonl_sample(ledger, runtime, run, binding)
                                else:
                                    require(binding.get("format") in (None, "snapshot"), "unsupported Trae binding format")
                                    sample = trae_sample(ledger, runtime, run, binding)
                                value = ledger.usage(runtime, run, binding["agent_id"], sample, final=binding.get("final", False))
                    if coverage["missing_worker_ids"]:
                        print("warning: worker_usage_bindings_missing; inspect usage_binding_coverage.missing_worker_ids",
                              file=sys.stderr)
                    if args.output:
                        value = {"run": value, "export": export(ledger, args.output)}
                elif args.command == "capture-trae":
                    binding = trae.check_scope(ledger, runtime, run, args.agent_id, read_json(args.binding))
                    value = trae.ProxyReader(args.cli, args.socket).capture(binding)
                    trae.write_snapshot(args.output, value)
                    value = {"snapshot": args.output, "observed_at": value["observed_at"], "usage_imported": False}
                elif args.command in ("scan-codex", "scan-trae", "scan-trae-jsonl", "usage-import"):
                    sample = (trae_jsonl_sample(ledger, runtime, run, vars(args)) if args.command == "scan-trae-jsonl" else
                              trae_sample(ledger, runtime, run, vars(args)) if args.command == "scan-trae" else
                              scan(args.file, args.session_id, args.since, args.until)
                              if args.command == "scan-codex" else read_json(args.file))
                    value = ledger.usage(runtime, run, args.agent_id, sample, final=args.final)
                elif args.command == "coordinator":
                    ledger.coordinator(runtime, run, started_at=args.started_at, ended_at=args.ended_at,
                                       source=args.source, provider=args.provider, model=args.model)
                    value = ledger.report(runtime, run)
                elif args.command == "finish":
                    ledger.finish(runtime, run, ended_at=args.ended_at, outcome=args.outcome, source=args.source)
                    value = ledger.report(runtime, run)
                else:
                    value = ledger.report(runtime, run)
            print(json.dumps(value, ensure_ascii=False, sort_keys=True))
        return 0
    finally:
        ledger.close()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SafetyError as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        sys.exit(78)
    except (KeyError, TypeError, ValueError, AttributeError, OSError, sqlite3.Error):
        # Do not echo transcript text, input payloads, argv, paths or native stderr.
        print(json.dumps({"ok": False, "error": "invalid ledger input or I/O; inspect ledger before retrying export"}))
        sys.exit(78)
