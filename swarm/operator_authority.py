"""Check independently pinned RSI inputs; never infer authority or issue live gates.

File refs use raw bytes. Canonical pins are derived from those verified bytes and
passed to the existing RSI CLI. Legacy checks commit receipt.json; generated
authority and schema2 progress commit completed.json. Attempts are never reused.
"""

import argparse
import errno
import json
import os
import re
import subprocess
import sys
import time

from coordinator_checker import LOADER, checker_sources
from coordinator_authority_bundle import (GENERATE, PROGRESS, PROTOCOL, argv_for,
    handoff_value, source_refs, success, verify_bundle)
from coordinator_io import (canonical, digest, file_ref, now, parse, path, pinned,
                            publish_new, require, scoped_refs)
import coordinator_snapshots as snapshots_io


CHECKER_CLI = LOADER + '''from rsi.__main__ import main
sys.exit(main(request["argv"]))
'''
MODES = {
    GENERATE: {"authority"},
    "check-authority-handoff": {"authority", "handoff"},
    "check-authorized-progress": {"authority", "handoff", "contract", "context", "checkpoint", "gates"},
}


def reviewed(ref):
    spec = parse(pinned(ref))
    require(isinstance(spec, dict) and set(spec) == {
        "schema_version", "mode", "directory", "read_roots", "write_roots", "checker",
        "source_root", "run_id", "scope_id", "inputs"}
        | ({"generation"} if spec.get("schema_version") == 2 else set())
        and type(spec["schema_version"]) is int and spec["schema_version"] in (1, 2),
        "invalid_operator_authority_input")
    require(spec["schema_version"] == 1 or spec["mode"] == PROGRESS,
            "invalid_operator_authority_version")
    require(isinstance(spec["mode"], str) and spec["mode"] in MODES
            and isinstance(spec["inputs"], dict) and set(spec["inputs"]) == MODES[spec["mode"]],
            "invalid_operator_authority_mode_or_inputs")
    from operator_prepare import directories
    read_roots, write_roots = directories(spec["read_roots"]), directories(spec["write_roots"])
    directory = path(spec["directory"], directory=True)
    require(any(directory.is_relative_to(root) for root in write_roots), "authority_output_outside_scope")
    info = directory.stat()
    require(info.st_uid == os.getuid() and info.st_mode & 0o777 == 0o700,
            "private_authority_directory_required")
    require(not any(directory.iterdir()), "authority_attempt_not_empty")
    source_root = path(spec["source_root"], directory=True)
    checker_root = path(spec["checker"]["root"], directory=True)
    for root in (source_root, checker_root):
        require(any(root.is_relative_to(r) for r in read_roots)
                and not root.is_relative_to(directory), "authority_root_outside_scope")
    refs = [ref, *spec["inputs"].values()]
    scoped_refs(refs, read_roots, [directory])
    snapshots = snapshots_io.collect(refs)
    values = {name: parse(snapshots[(item["path"], item["sha256"])][1])
              for name, item in spec["inputs"].items()}
    # Freeze exactly the ledger's source bytes too. Do not scan source_root or
    # reinterpret source excerpts/patches; RSI still validates the full ledger.
    authority_sources = source_refs(spec, values["authority"])
    scoped_refs(authority_sources, read_roots, [directory])
    sources = checker_sources(spec["checker"])
    require("rsi/__main__.py" in sources and "rsi/authority.py" in sources, "authority_cli_required")
    code_refs = [{"path": str(checker_root / name), "sha256": sha}
                 for name, sha in spec["checker"]["files"].items()]
    scoped_refs(code_refs, read_roots, [directory])
    snapshots.update(snapshots_io.collect([*authority_sources, *code_refs]))
    hashes = {name: {"path": item["path"], "file_sha256": item["sha256"],
                     "canonical_sha256": digest(canonical(values[name]))}
              for name, item in spec["inputs"].items()}
    if spec["schema_version"] == 2:
        verify_generation(spec, read_roots)
    return spec, directory, snapshots, sources, hashes


def verify_generation(spec, roots):
    bundle, generated, _ = verify_bundle(spec["generation"], roots, expected_mode=GENERATE)
    require(all(spec[name] == generated[name] for name in ("run_id", "scope_id", "checker", "source_root"))
            and spec["inputs"]["authority"] == generated["inputs"]["authority"]
            and spec["inputs"]["handoff"] == bundle["handoff"], "authority_progress_generation_mismatch")


def checker_argv(spec, frozen, hashes):
    def filename(name):
        ref = spec["inputs"][name]
        return frozen[(ref["path"], ref["sha256"])]["path"]

    argv = [spec["mode"], "--authority", filename("authority"), "--authority-sha256",
            hashes["authority"]["canonical_sha256"], "--handoff", filename("handoff"),
            "--source-root", spec["source_root"], "--run-id", spec["run_id"], "--scope-id", spec["scope_id"]]
    if spec["mode"] == "check-authorized-progress":
        argv += [filename("checkpoint"), "--contract", filename("contract"), "--contract-sha256",
                 hashes["contract"]["canonical_sha256"], "--context", filename("context"),
                 "--context-sha256", hashes["context"]["canonical_sha256"], "--gates", filename("gates")]
    return argv


def check(ref):
    started_at, started = now(), time.monotonic()
    spec, directory, snapshots, sources, hashes = reviewed(ref)
    if spec["mode"] == GENERATE or spec["schema_version"] == 2:
        return publish_bundle(ref, spec, directory, snapshots, sources, hashes, started_at)
    # Claim outside the failure handler: a competing caller must not write into
    # the winning attempt. No retries, even if only this intent survives a crash.
    publish_new(directory / "check-intent.json", {
        "schema_version": 1, "input": ref, "started_at": started_at, "execution_authorized": False})
    diagnostics = {}
    try:
        mappings, frozen = snapshots_io.publish(directory, snapshots, prefix="source", publisher=publish_new)
        argv = checker_argv(spec, frozen, hashes)
        publish_new(directory / "invocation.json", {
            "schema_version": 1, "mode": spec["mode"], "argv": argv, "input": ref,
            "digests": hashes, "snapshots": mappings, "execution_authorized": False})
        snapshots_io.recheck(snapshots)
        before = time.monotonic()
        proc = subprocess.run([sys.executable, "-I", "-B", "-S", "-c", CHECKER_CLI],
            input=canonical({"sources": sources, "argv": argv}), cwd=directory,
            capture_output=True, timeout=30)
        diagnostics.update(returncode=proc.returncode, checker_seconds=time.monotonic() - before)
        for name, raw in (("stdout", proc.stdout), ("stderr", proc.stderr)):
            target = directory / ("checker-" + name + ".txt")
            publish_new(target, raw)
            diagnostics[name] = file_ref(target)
        require(proc.returncode == 0, "authority_checker_rejected")
        result = parse(proc.stdout)
        require(isinstance(result, dict) and result.get("ok") is True
                and isinstance(result.get("result"), dict)
                and result["result"].get("consistent") is True, "invalid_authority_checker_success")
        if spec["mode"] == "check-authorized-progress":
            diagnostic = result.get("authority_check", {})
            require(diagnostic.get("status") == "consistent" and diagnostic.get("grants_authority") is False
                    and diagnostic.get("run_id") == spec["run_id"] and diagnostic.get("scope_id") == spec["scope_id"]
                    and all(diagnostic.get(name + "_sha256") == hashes[name]["canonical_sha256"]
                            for name in ("authority", "context", "checkpoint")), "authority_receipt_binding_mismatch")
        snapshots_io.recheck(snapshots)
        checker_sources(spec["checker"])  # Includes additions/removals, not just changed bytes.
        for item in mappings:
            pinned(item["snapshot"])
        publish_new(directory / "check-completed.json", {
            "schema_version": 1, "input": ref, "digests": hashes, **diagnostics,
            "completed_at": now(), "wall_seconds": time.monotonic() - started,
            "execution_authorized": False})
        # Preserve the existing RSI envelope exactly; this sole final publication
        # is consumable by the existing TUI checkpoint adapter without migration.
        target = directory / "receipt.json"
        publish_new(target, proc.stdout)
        return {"ok": True, "receipt": file_ref(target), "execution_authorized": False,
                "digests": hashes, "metadata": file_ref(directory / "check-completed.json")}
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as exc:
        failure = {"ok": False, "decision": "stop", "input": ref, **diagnostics,
                   "error_type": type(exc).__name__, "failed_at": now(),
                   "wall_seconds": time.monotonic() - started, "execution_authorized": False}
        if isinstance(exc, OSError):
            failure["os_error"] = errno.errorcode.get(exc.errno, "UNKNOWN")
        target = directory / "failure.json"
        publish_new(target, failure)
        return {"ok": False, "decision": "stop", "failure": file_ref(target), "execution_authorized": False}


def reconcile(ref):
    """Read this exact attempt after interruption; never execute, repin or repair."""
    spec = parse(pinned(ref))
    directory = path(spec["directory"], directory=True)
    target = directory / "completed.json"
    if not target.exists():
        return {"ok": False, "state": "incomplete", "decision": "preserve_attempt",
                "execution_authorized": False}
    completed = file_ref(target)
    roots = [str(directory)] if spec["mode"] == GENERATE else [*spec["read_roots"], str(directory)]
    bundle, _, _ = verify_bundle(completed, roots, expected_input=ref)
    return {"ok": True, "state": "committed", "completion": completed, "handoff": bundle["handoff"],
            "receipt": bundle["receipt"], "digests": bundle["digests"], "execution_authorized": False}


def publish_bundle(ref, spec, directory, snapshots, sources, hashes, started_at):
    # Outside the handler: a loser must never write failure.json into a winner.
    publish_new(directory / "resolve-intent.json", {
        "schema_version": 1, "input": ref, "started_at": started_at, "execution_authorized": False})
    calls = []
    commit_attempted = False
    try:
        mappings, frozen = snapshots_io.publish(directory, snapshots, prefix="source", publisher=publish_new)

        def invoke(label, mode, handoff=None):
            argv = argv_for(spec, frozen, hashes, mode, handoff)
            invocation = directory / (label + "-invocation.json")
            publish_new(invocation, {"schema_version": 1, "input": ref, "checker": spec["checker"], "argv": argv})
            snapshots_io.recheck(snapshots)
            began = now()
            proc = subprocess.run([sys.executable, "-I", "-B", "-S", "-c", CHECKER_CLI],
                input=canonical({"sources": sources, "argv": argv}), cwd=directory, capture_output=True, timeout=30)
            call = {"invocation": file_ref(invocation), "returncode": proc.returncode,
                    "started_at": began, "completed_at": now()}
            calls.append(call)
            for name, raw in (("stdout", proc.stdout), ("stderr", proc.stderr)):
                target = directory / (label + "-" + name + ".txt")
                publish_new(target, raw)
                call[name] = file_ref(target)
            require(proc.returncode == 0, "authority_checker_rejected")
            return proc.stdout

        if spec["mode"] == GENERATE:
            raw = invoke("resolver", "resolve-authority")
            handoff = handoff_value(parse(raw), spec, hashes["authority"]["canonical_sha256"])
            candidate = directory / "handoff-candidate.json"
            publish_new(candidate, canonical(handoff))
            candidate_ref = file_ref(candidate)
            receipt = invoke("checker", "check-authority-handoff", candidate_ref)
            require(success(receipt)["result"].get("grants_authority") is False,
                    "invalid_authority_checker_success")
            pinned(candidate_ref)
            require(pinned(candidate_ref) == canonical(handoff), "authority_candidate_changed")
            target = directory / "handoff-authority.json"
            publish_new(target, canonical(handoff))
            handoff_ref = file_ref(target)
        else:
            verify_generation(spec, spec["read_roots"])
            receipt = invoke("checker", PROGRESS)
            success(receipt)
            handoff_ref = spec["inputs"]["handoff"]
        snapshots_io.recheck(snapshots)
        checker_sources(spec["checker"])
        for item in mappings:
            pinned(item["snapshot"])
        receipt_path = directory / "receipt.json"
        publish_new(receipt_path, receipt)
        bundle = dict(schema_version=1, protocol=PROTOCOL, mode=spec["mode"], input=ref,
            snapshots=mappings, digests=hashes, calls=calls, handoff=handoff_ref,
            receipt=file_ref(receipt_path), generation=spec.get("generation"), started_at=started_at,
            completed_at=now(), execution_authorized=False)
        # Validate the exact eventual manifest before committing it. Runtime
        # consumers always require the actual pinned completed.json file.
        verify_candidate(bundle, directory, spec)
        snapshots_io.recheck(snapshots)
        checker_sources(spec["checker"])
        commit_attempted = True
        publish_new(directory / "completed.json", bundle)
        return reconcile(ref)
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as exc:
        # link() may have committed before directory fsync/return failed. Do not
        # label that definitely unpublished or automatically retry it.
        if commit_attempted:
            return {"ok": False, "state": "publication_unknown", "decision": "reconcile_exact_attempt",
                    "input": ref, "execution_authorized": False}
        result = {"ok": False, "state": "incomplete", "decision": "preserve_attempt", "input": ref,
                  "error_type": type(exc).__name__, "calls": calls, "failed_at": now(),
                  "execution_authorized": False}
        if isinstance(exc, ValueError) and re.fullmatch(r"[a-z][a-z0-9_]+", str(exc)):
            result["error"] = str(exc)  # Fixed validator code only, never source text.
        if isinstance(exc, OSError):
            result["os_error"] = errno.errorcode.get(exc.errno, "UNKNOWN")
        try:
            publish_new(directory / "failure.json", result)
            result["failure"] = file_ref(directory / "failure.json")
        except OSError:
            pass  # Diagnostics are best effort, not a second success condition.
        return result


def verify_candidate(bundle, directory, spec):
    from coordinator_authority_bundle import verify_document
    verify_document(bundle, directory / "completed.json", [*spec["read_roots"], str(directory)])


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--input-sha256", required=True, help="independently reviewed RAW file digest")
    parser.add_argument("--execute", action="store_true", help="publish this local check attempt only")
    parser.add_argument("--reconcile", action="store_true", help="read exact completed bundle; no writes or reexecution")
    args = parser.parse_args(argv)
    try:
        require(args.execute != args.reconcile, "authority_check_explicit_execute_required")
        result = (reconcile if args.reconcile else check)({"path": args.input, "sha256": args.input_sha256})
    except (OSError, ValueError, KeyError, TypeError, AttributeError, subprocess.SubprocessError) as exc:
        result = {"ok": False, "decision": "stop", "execution_authorized": False,
                  "error": "operator_authority_failed_preserve_attempt_and_check_pins",
                  "error_type": type(exc).__name__}
        if isinstance(exc, OSError):
            result["os_error"] = errno.errorcode.get(exc.errno, "UNKNOWN")
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
