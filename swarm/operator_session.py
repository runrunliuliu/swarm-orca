"""Pinned-input Operator facade for reviewed runtime-state Operator adapters.

No raw hook JSON, credential fields, TUI transcript or live-authority claim is
returned. The immutable full observation remains consumable by existing gates.

The Operator's provider is a declared, independently reviewed property of the
identity input, resolved through `provider_capability` and then verified against
native evidence. Two providers are verifiable here:

- `trae`: hook row plus transcript `session_meta` + per-turn `turn_context`.
- `pi`: Orca's bundled Pi status extension posts `session_id`/`session_file` and
  the pane launch token to `/hook/pi`, and the Pi transcript carries the session
  id, `cwd` and per-turn `model`/`provider`/`thinkingLevel`.

A provider that cannot supply this evidence is refused before any native query
with its typed code and the missing channels. Pi has no approval/sandbox
surface, so a reviewed Operator contract may only require `PI_SETTINGS`; other
keys are refused (`operator_session_expected_effective_provider_unsupported`)
rather than silently ignored. See
[Agent/adapter support](operator-prepare.md#agent--adapter-支持范围).
"""

import argparse
import errno
import json
import os
from pathlib import Path
import subprocess
import socket
import sys
import time

from coordinator_io import file_ref, now, parse, path, pinned, publish_new, timestamp
from coordinator_tui_errors import TuiError, failure, require
from log_io import prefix_lines
import provider_capability
from swarm_ledger import runtime_binding
from supervisor.config import SafetyError
from trae_coordinator import ContextFreshnessError
import trae_tui


def _operator_capability(operator, *, observed=None):
    """Resolve the declared Operator provider through the shared capability table.

    This answers the question before any native query: can this build verify the
    declared provider at all? An unknown name keeps
    `operator_session_provider_unsupported`; a known provider whose evidence
    channel is absent keeps its own code
    (`operator_session_<provider>_operator_unverifiable`) and names the missing
    channels. Nothing guesses another provider, log root or format.
    """
    try:
        return provider_capability.require(
            operator["provider"], provider_capability.OPERATOR_IDENTITY,
            required="operator_session_provider_required",
            unsupported="operator_session_provider_unsupported",
            unavailable="operator_session_{provider}_operator_unverifiable",
            observed=observed)
    except provider_capability.ProviderRefused as exc:
        error = TuiError(exc.code)
        error.missing_evidence = exc.missing_evidence
        raise error from None


def observe_identity(*, cli, runtime, operator, workspace, profile, log_root,
                     max_age_seconds, previous=None):
    """Observe the Operator, without imposing Coordinator settings or borrowing its caller.

    This TUI path shares the explicitly selected provider log root. Providers
    need their own explicit root; never guess one from the local HOME.
    The capture validates the provider's root session record as well as the
    native pane mapping.
    """
    capability = _operator_capability(operator)
    options = dict(provider=capability.provider, format=capability.evidence_format,
                   host=socket.gethostname(), require_launch_commitment=True,
                   terminal_handle=operator["terminal"], worktree_id=workspace,
                   profile=profile, log_root=log_root, max_hook_age_seconds=max_age_seconds)
    try:
        evidence = runtime_binding.capture(trae_tui.Queries(cli, runtime), options,
                                           clock=time.time, previous=previous)
    except SafetyError as exc:
        # Never export a native payload or arbitrary reader exception string.
        code = ("operator_session_hook_stale_or_future"
                if str(exc) == "runtime_state_stale_or_future_hook"
                else "operator_session_runtime_state_unverifiable")
        raise TuiError(code) from exc
    binding = evidence["identity"]
    # The declared capability must also hold for what was actually observed.
    _operator_capability(operator, observed=binding)
    require(binding["terminal"]["incarnationId"] == operator["incarnation"],
            "operator_session_incarnation_changed")
    require(binding["session_id"] == operator["session"], "operator_provider_session_mismatch")
    return evidence


def _latest_turn_context(transcript_path):
    target = path(transcript_path)
    with runtime_binding.ordinary_file(target) as (source, info):
        result = None
        for line in prefix_lines(source, info.st_size):
            if not line.endswith(b"\n"):
                continue
            row = json.loads(line)
            require(isinstance(row, dict), "operator_session_log_record_invalid")
            if row.get("type") == "turn_context":
                result = row
    require(result is not None and isinstance(result.get("payload"), dict),
            "operator_session_effective_settings_unavailable")
    return result


def _trae_effective(evidence, expected):
    """Reviewed Trae semantics: per-turn `turn_context`, incl. the reviewer alias."""
    row = _latest_turn_context(evidence["identity"]["transcript_path"])
    actual = row["payload"]
    observed = {key: actual.get(key) for key in (
        "model", "model_provider", "effort", "model_backend_variant", "approval_policy",
        "approvals_reviewer", "cwd")}
    sandbox = actual.get("sandbox_policy")
    require(isinstance(sandbox, dict), "operator_session_effective_settings_unavailable")
    observed["sandbox_policy"] = sandbox
    observed["writable_roots"] = sandbox.get("writable_roots")
    for key, expected_value in expected.items():
        if key == "approvals_reviewer" and expected_value in ("auto_review", "guardian_subagent"):
            # Trae serializes the reviewed auto-review setting as guardian_subagent in
            # runtime turn_context records. Treat only this documented alias pair as
            # semantically equal; other reviewer values remain exact-match failures.
            require(observed.get(key) in ("auto_review", "guardian_subagent"),
                    "operator_session_effective_settings_mismatch")
        elif key == "sandbox_policy":
            require(isinstance(expected_value, dict), "operator_session_expected_effective_invalid")
            require(all(sandbox.get(subkey) == subvalue for subkey, subvalue in expected_value.items()),
                    "operator_session_effective_settings_mismatch")
        else:
            require(observed.get(key) == expected_value, "operator_session_effective_settings_mismatch")
    return {key: observed.get(key) for key in expected}


def _pi_effective(evidence, expected):
    """Pi semantics: transcript root cwd plus the newest assistant turn's settings.

    Pi has no approval/sandbox surface at all, so its attestable keys come from
    the capability row (`PI_SETTINGS`) and everything else was already refused.
    """
    from pi_transcript import read as read_pi_transcript
    try:
        transcript = read_pi_transcript(evidence["identity"]["transcript_path"])
    except ValueError as exc:
        # The transcript's own typed code is the useful one; keep it exportable
        # instead of collapsing into the generic observation fallback.
        raise TuiError(str(exc)) from None
    require(transcript["session_id"] == evidence["identity"]["session_id"],
            "operator_provider_session_mismatch")
    observed = {**transcript["effective"], "cwd": transcript["cwd"]}
    for key, expected_value in expected.items():
        require(observed.get(key) == expected_value, "operator_session_effective_settings_mismatch")
    return {key: observed.get(key) for key in expected}


def _verify_expected_effective(evidence, expected, capability):
    require(isinstance(expected, dict), "operator_session_expected_effective_required")
    require(expected and set(expected) <= set(provider_capability.KNOWN_SETTINGS),
            "operator_session_expected_effective_invalid")
    # A reviewed contract may only require what this provider can attest; a key
    # that belongs to another provider is refused, never silently ignored.
    require(set(expected) <= set(capability.settings_fields),
            "operator_session_expected_effective_provider_unsupported")
    reader = _trae_effective if capability.provider == "trae" else _pi_effective
    return reader(evidence, expected)


def verify_operator_identity(ref, *, require_output_available=False):
    """Read and validate an Operator identity input without publishing evidence."""
    source = parse(pinned(ref))
    required = {"schema_version", "cli", "runtime", "operator", "workspace", "profile",
                "log_root", "context_max_age_seconds", "expected_effective", "output"}
    require(isinstance(source, dict) and required <= set(source) <= required | {"previous"}
            and type(source["schema_version"]) is int and source["schema_version"] == 1,
            "operator_identity_input_invalid")
    operator = source["operator"]
    require(isinstance(operator, dict) and set(operator) == {
        "provider", "terminal", "incarnation", "session"}
        and all(isinstance(operator[k], str) and operator[k].strip() for k in operator),
        "operator_session_identity_required")
    # Cheapest decisive check: never reach the native CLI for an adapter this
    # build cannot verify, and never let a wrong provider look like stale hooks.
    capability = _operator_capability(operator)
    for key in ("cli", "runtime", "workspace"):
        require(isinstance(source[key], str) and source[key].strip(), "operator_session_identity_required")
    require(Path(source["cli"]).is_absolute() and Path(source["cli"]).is_file(),
            "verified_absolute_cli_required")
    for key in ("profile", "log_root"):
        path(source[key], directory=True)
    max_age = source["context_max_age_seconds"]
    require(type(max_age) is int and 1 <= max_age <= 86400, "invalid_context_max_age_seconds")
    output = Path(source["output"])
    require(output.is_absolute(), "operator_session_output_path_invalid")
    parent = path(str(output.parent), directory=True)
    info = parent.stat()
    require(info.st_uid == os.getuid() and info.st_mode & 0o777 == 0o700,
            "operator_session_private_directory_required")
    if require_output_available:
        require(not os.path.lexists(output), "operator_session_output_exists")
    previous = source.get("previous")
    require(previous is None or isinstance(previous, dict), "operator_session_previous_invalid")
    previous_evidence = parse(pinned(previous)) if previous is not None else None
    evidence = observe_identity(cli=source["cli"], runtime=source["runtime"], operator=operator,
        workspace=source["workspace"], profile=source["profile"], log_root=source["log_root"],
        max_age_seconds=max_age, previous=previous_evidence)
    effective = _verify_expected_effective(evidence, source["expected_effective"], capability)
    pinned(ref)
    if previous is not None:
        pinned(previous)
    binding = evidence["identity"]
    terminal = binding["terminal"]
    return {"source": source, "output": output, "evidence": evidence,
            "session": {"runtime": binding["runtime"]["runtimeId"],
                        "provider": operator["provider"],
                        "terminal": terminal["handle"], "incarnation": terminal["incarnationId"],
                        "workspace": terminal["worktreeId"], "session": binding["session_id"],
                        "observed_at": evidence["observed_at"]},
            "effective": effective, "trust": evidence["trust"]}


def observe_operator(ref):
    verified = verify_operator_identity(ref, require_output_available=True)
    publish_new(verified["output"], verified["evidence"])
    return {"ok": True, "kind": "operator_identity_observed", "input": ref,
            "observation": file_ref(verified["output"]),
            "session": verified["session"],
            "effective": verified["effective"], "trust": verified["trust"],
            "execution_authorized": False}


def observe(ref):
    """Legacy Trae-TUI Coordinator observation; NOT provider-dispatched.

    This entry (reached as `operator_prepare observe-coordinator|observe-session`)
    always runs the Trae reader and publishes `provider: "trae"`. Its input schema
    carries no provider field, and a provider-specific `runtime_config` Ref looks
    identical for both providers, so there is nothing here to refuse *on*: guessing
    from a path shape would be the same defect in a new place. It is therefore an
    explicitly Trae-only legacy surface (protocol §5.1 "still not supported"); the
    Pi path is `bootstrap_identity` / `observe_identity`, which resolve the declared
    provider through `provider_capability` before any native query.
    """
    source = parse(pinned(ref))
    require(isinstance(source, dict) and set(source) == {
        "schema_version", "cli", "runtime", "terminal", "incarnation", "workspace",
        "cwd", "profile", "caller_receipt", "log_root", "roots", "runtime_config",
        "context_max_age_seconds", "expected_thread", "startup_anchor", "output"}
        and type(source["schema_version"]) is int and source["schema_version"] == 1,
        "operator_session_input_invalid")
    for key in ("cli", "runtime", "terminal", "incarnation", "workspace"):
        require(isinstance(source[key], str) and source[key].strip(), "operator_session_identity_required")
    for key in ("cwd", "profile", "log_root"):
        path(source[key], directory=True)
    require(isinstance(source["roots"], list), "operator_session_roots_required")
    for root in source["roots"]:
        path(root, directory=True)
    max_age = source["context_max_age_seconds"]
    # Same accepted range as schema-v2 startup contracts; caller pins the choice.
    require(type(max_age) is int and 1 <= max_age <= 3600, "invalid_context_max_age_seconds")
    require(source["expected_thread"] is None or isinstance(source["expected_thread"], str),
            "operator_session_expected_thread_invalid")
    output = Path(source["output"])
    require(output.is_absolute(), "operator_session_output_path_invalid")
    parent = path(str(output.parent), directory=True)
    info = parent.stat()
    require(info.st_uid == os.getuid() and info.st_mode & 0o777 == 0o700,
            "operator_session_private_directory_required")
    require(not os.path.lexists(output), "operator_session_output_exists")
    refs = [ref, source["runtime_config"], source["caller_receipt"]]
    if source["startup_anchor"] is not None:
        refs.append(source["startup_anchor"])
    for item in refs:
        pinned(item)
    kwargs = {key: source[key] for key in (
        "cli", "runtime", "terminal", "incarnation", "workspace", "cwd", "profile",
        "caller_receipt", "log_root", "roots", "context_max_age_seconds",
        "expected_thread", "startup_anchor")}
    result = trae_tui.observe(**kwargs, trae_runtime_config=source["runtime_config"]["path"])
    for item in refs:
        pinned(item)
    age = (timestamp(now()) - timestamp(result["observed_at"])).total_seconds()
    if not 0 <= age <= max_age:
        raise ContextFreshnessError(age, max_age)
    publish_new(output, result)
    return {"ok": True, "kind": "operator_session_observed", "input": ref,
            "observation": file_ref(output),
            "session": {"runtime": result["runtime_id"], "provider": "trae",
                        "terminal": source["terminal"], "incarnation": source["incarnation"],
                        "workspace": source["workspace"], "thread_id": result["thread_id"],
                        "observed_at": result["observed_at"]},
            "effective": {key: result["effective"].get(key) for key in (
                "model", "effort", "model_backend_variant", "approval_policy", "approvals_reviewer")},
            "trust": result["trust"], "requires_live_caller_check": True,
            "execution_authorized": False}


def _run(builder, ref, fallback):
    try:
        result = builder(ref)
    except (OSError, ValueError, KeyError, TypeError, AttributeError, subprocess.SubprocessError) as exc:
        result = failure(exc, fallback)
        result["execution_authorized"] = False
        if isinstance(exc, OSError) and exc.errno is not None:
            result["os_error"] = errno.errorcode.get(exc.errno, "UNKNOWN")
        print(json.dumps(result))
        return 2
    print(json.dumps(result, ensure_ascii=False))
    return 0


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    mode = "observe-coordinator"
    if argv and argv[0] in ("observe-coordinator", "observe-operator"):
        mode = argv.pop(0)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--input-sha256", required=True)
    parser.add_argument("--execute", action="store_true", help="save local observation only")
    args = parser.parse_args(argv)
    try:
        require(args.execute, "operator_session_explicit_execute_required")
    except ValueError as exc:
        return _run(lambda _ref: (_ for _ in ()).throw(exc),
                    {"path": args.input, "sha256": args.input_sha256},
                    "operator_session_observation_failed")
    ref = {"path": args.input, "sha256": args.input_sha256}
    return _run(observe_operator if mode == "observe-operator" else observe, ref,
                "operator_session_observation_failed")


if __name__ == "__main__":
    raise SystemExit(main())
