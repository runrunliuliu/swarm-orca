"""Versioned, pinned authority provenance. Consistency, NOT authentication.

Only completed.json commits a bundle. Downstream reads its archived bytes, not
mutable original inputs, and never executes the archived checker code.
"""

from pathlib import Path, PurePosixPath

from coordinator_io import canonical, digest, parse, path, pinned, require, timestamp, validate_ref


PROTOCOL = "generated-authority-v1"
ADAPTER = "rsi-authorized-progress-v2"
GENERATE = "resolve-authority-handoff"
PROGRESS = "check-authorized-progress"


def handoff_value(reply, spec, authority_sha):
    require(isinstance(reply, dict) and set(reply) == {"ok", "result"} and reply.get("ok") is True
            and isinstance(reply.get("result"), dict)
            and set(reply["result"]) == {"handoff", "grants_authority", "validation_scope"}
            and reply["result"]["grants_authority"] is False
            and reply["result"]["validation_scope"] == "pinned_authority_declarations_and_source_bytes",
            "invalid_authority_resolver_envelope")
    handoff = reply["result"].get("handoff")
    require(isinstance(handoff, dict) and set(handoff) == {
        "schema_version", "run_id", "scope_id", "authority_sha256", "fields", "origins"}
        and type(handoff["schema_version"]) is int and handoff["schema_version"] == 1
        and handoff["run_id"] == spec["run_id"] and handoff["scope_id"] == spec["scope_id"]
        and handoff["authority_sha256"] == authority_sha
        and isinstance(handoff["fields"], dict) and bool(handoff["fields"])
        and isinstance(handoff["origins"], dict)
        and set(handoff["fields"]) == set(handoff["origins"]), "invalid_authority_resolver_handoff")
    # Null origin VALUES are legitimate; field semantics belong to RSI alone.
    return handoff


def success(raw):
    value = parse(raw)
    require(isinstance(value, dict) and value.get("ok") is True
            and isinstance(value.get("result"), dict)
            and value["result"].get("consistent") is True,
            "invalid_authority_checker_success")
    return value


def argv_for(spec, frozen, hashes, mode, handoff=None):
    def filename(name):
        ref = spec["inputs"][name]
        return frozen[(ref["path"], ref["sha256"])]["path"]
    argv = [mode, "--authority", filename("authority"), "--authority-sha256",
            hashes["authority"]["canonical_sha256"], "--source-root", spec["source_root"],
            "--run-id", spec["run_id"], "--scope-id", spec["scope_id"]]
    if mode != "resolve-authority":
        argv += ["--handoff", handoff["path"] if handoff else filename("handoff")]
    if mode == PROGRESS:
        argv += [filename("checkpoint"), "--contract", filename("contract"), "--contract-sha256",
                 hashes["contract"]["canonical_sha256"], "--context", filename("context"),
                 "--context-sha256", hashes["context"]["canonical_sha256"], "--gates", filename("gates")]
    return argv


def source_refs(spec, authority):
    require(isinstance(authority, dict) and isinstance(authority.get("events"), list),
            "invalid_authority_ledger")
    result = []
    for event in authority["events"]:
        item = event["source"]
        relative = PurePosixPath(item["path"])
        require(not relative.is_absolute() and str(relative) == item["path"] and relative.parts
                and all(p not in (".", "..") for p in relative.parts)
                and "\\" not in item["path"] and "\0" not in item["path"], "invalid_authority_source")
        result.append({"path": str(Path(spec["source_root"]) / relative), "sha256": item["sha256"]})
    return result


def scoped_raw(ref, roots):
    validate_ref(ref)
    require(any(path(ref["path"]).is_relative_to(Path(root)) for root in roots),
            "authority_bundle_outside_scope")
    return pinned(ref)


def verify_bundle(ref, roots, *, expected_mode=None, expected_input=None):
    """Verify archived transport, calls and exact checked bytes; no live I/O."""
    bundle = parse(scoped_raw(ref, roots))
    return verify_document(bundle, Path(ref["path"]), roots,
                           expected_mode=expected_mode, expected_input=expected_input)


def verify_document(bundle, target, roots, *, expected_mode=None, expected_input=None):
    """Shared validation before publication and when reading the commit marker."""
    require(isinstance(bundle, dict) and set(bundle) == {
        "schema_version", "protocol", "mode", "input", "snapshots", "digests", "calls",
        "handoff", "receipt", "generation", "started_at", "completed_at", "execution_authorized"}
        and type(bundle["schema_version"]) is int and bundle["schema_version"] == 1
        and bundle["protocol"] == PROTOCOL and bundle["execution_authorized"] is False
        and bundle["mode"] in (GENERATE, PROGRESS), "invalid_authority_bundle")
    require(expected_mode is None or bundle["mode"] == expected_mode, "authority_bundle_mode_mismatch")
    require(expected_input is None or bundle["input"] == expected_input, "authority_bundle_input_mismatch")
    directory = target.parent
    require(target.name == "completed.json", "authority_bundle_commit_required")
    require(timestamp(bundle["started_at"]) <= timestamp(bundle["completed_at"]),
            "authority_bundle_time_invalid")

    def local(item):
        validate_ref(item)
        require(Path(item["path"]).parent == directory, "authority_bundle_artifact_outside_attempt")
        return scoped_raw(item, roots)

    frozen, raws = {}, {}
    require(isinstance(bundle["snapshots"], list), "invalid_authority_bundle_snapshots")
    for item in bundle["snapshots"]:
        require(isinstance(item, dict) and set(item) == {"source", "snapshot"}, "invalid_authority_snapshot")
        validate_ref(item["source"])
        key = (item["source"]["path"], item["source"]["sha256"])
        raw = local(item["snapshot"])
        require(key not in frozen and digest(raw) == item["source"]["sha256"], "authority_snapshot_mismatch")
        frozen[key], raws[key] = item["snapshot"], raw

    def archived(item):
        validate_ref(item)
        key = (item["path"], item["sha256"])
        require(key in raws, "authority_snapshot_missing")
        return parse(raws[key])

    spec = archived(bundle["input"])
    generation = bundle["mode"] == GENERATE
    require(isinstance(spec, dict) and set(spec) == {
        "schema_version", "mode", "directory", "read_roots", "write_roots", "checker",
        "source_root", "run_id", "scope_id", "inputs"} | (set() if generation else {"generation"})
        and type(spec["schema_version"]) is int and spec["schema_version"] == (1 if generation else 2)
        and spec["directory"] == str(directory) and spec["mode"] == bundle["mode"]
        and isinstance(spec["inputs"], dict) and set(spec["inputs"]) ==
        ({"authority"} if generation else {"authority", "handoff", "context", "contract", "checkpoint", "gates"}),
        "authority_bundle_spec_mismatch")
    values = {name: archived(item) for name, item in spec["inputs"].items()}
    hashes = {name: dict(path=item["path"], file_sha256=item["sha256"],
                        canonical_sha256=digest(canonical(values[name])))
              for name, item in spec["inputs"].items()}
    require(bundle["digests"] == hashes, "authority_bundle_digest_mismatch")
    checker = spec["checker"]
    require(isinstance(checker, dict) and set(checker) == {"root", "files"}
            and isinstance(checker["files"], dict) and
            {"rsi/__init__.py", "rsi/progress.py", "rsi/authority.py", "rsi/__main__.py"} <= set(checker["files"]),
            "authority_bundle_checker_invalid")
    refs = [bundle["input"], *spec["inputs"].values(), *source_refs(spec, values["authority"])]
    refs += [{"path": str(Path(checker["root"]) / name), "sha256": sha}
             for name, sha in checker["files"].items()]
    require(set(raws) == {(item["path"], item["sha256"]) for item in refs}, "authority_bundle_snapshot_set_mismatch")
    modes = ["resolve-authority", "check-authority-handoff"] if generation else [PROGRESS]
    require(isinstance(bundle["calls"], list) and len(bundle["calls"]) == len(modes),
            "authority_bundle_calls_missing")
    outputs = []
    for call, mode in zip(bundle["calls"], modes):
        require(isinstance(call, dict) and set(call) == {
            "invocation", "stdout", "stderr", "returncode", "started_at", "completed_at"}
            and type(call["returncode"]) is int and call["returncode"] == 0
            and timestamp(bundle["started_at"]) <= timestamp(call["started_at"])
            <= timestamp(call["completed_at"]) <= timestamp(bundle["completed_at"]), "authority_bundle_call_invalid")
        invocation = parse(local(call["invocation"]))
        candidate = {"path": str(directory / "handoff-candidate.json")} if generation else None
        require(invocation == {"schema_version": 1, "input": bundle["input"], "checker": checker,
                               "argv": argv_for(spec, frozen, hashes, mode, candidate)},
                "authority_bundle_invocation_mismatch")
        outputs.append(local(call["stdout"]))
        local(call["stderr"])
    receipt = success(local(bundle["receipt"]))
    require(local(bundle["receipt"]) == outputs[-1], "authority_bundle_receipt_mismatch")
    if generation:
        require(bundle["generation"] is None, "authority_bundle_generation_mismatch")
        handoff = handoff_value(parse(outputs[0]), spec, hashes["authority"]["canonical_sha256"])
        require(local(bundle["handoff"]) == canonical(handoff)
                and scoped_raw({"path": str(directory / "handoff-candidate.json"),
                                "sha256": bundle["handoff"]["sha256"]}, roots) == canonical(handoff),
                "authority_bundle_handoff_mismatch")
        require(receipt["result"].get("grants_authority") is False, "authority_bundle_grants_authority")
    else:
        require(bundle["generation"] == spec["generation"], "authority_bundle_generation_mismatch")
        gen, gen_spec, _ = verify_bundle(bundle["generation"], roots, expected_mode=GENERATE)
        require(spec["run_id"] == gen_spec["run_id"] and spec["scope_id"] == gen_spec["scope_id"]
                and spec["source_root"] == gen_spec["source_root"] and checker == gen_spec["checker"]
                and spec["inputs"]["authority"] == gen_spec["inputs"]["authority"]
                and spec["inputs"]["handoff"] == gen["handoff"] == bundle["handoff"],
                "authority_progress_generation_mismatch")
        authority = receipt.get("authority_check", {})
        result = receipt["result"]
        require(authority.get("schema_version") == 1 and type(authority.get("schema_version")) is int
                and authority.get("status") == "consistent" and authority.get("error_code") is None
                and authority.get("grants_authority") is False and authority.get("run_id") == spec["run_id"]
                and authority.get("scope_id") == spec["scope_id"]
                and all(authority.get(name + "_sha256") == hashes[name]["canonical_sha256"]
                        for name in ("authority", "context", "checkpoint"))
                and all(result.get(name + "_sha256") == hashes[name]["canonical_sha256"]
                        for name in ("authority", "context", "contract"))
                and result.get("decision") == values["checkpoint"].get("decision"),
                "authority_progress_receipt_mismatch")
        context = values["context"]
        require(context.get("run_id") == spec["run_id"] and context.get("scope_id") == spec["scope_id"]
                and context.get("authority_sha256") == hashes["authority"]["canonical_sha256"]
                and context.get("contract_sha256") == hashes["contract"]["canonical_sha256"]
                and values["checkpoint"].get("contract_sha256") == hashes["contract"]["canonical_sha256"]
                and values["checkpoint"].get("run_id") == spec["run_id"]
                and values["contract"].get("run_id") == spec["run_id"], "authority_progress_context_mismatch")
    return bundle, spec, values


def validate_binding(binding, contract, acceptance):
    require(isinstance(binding, dict) and set(binding) == {"protocol", "generation", "scope_id", "context", "contract"}
            and binding["protocol"] == PROTOCOL, "tui_authority_binding_invalid")
    roots = contract["observation"]["roots"]
    bundle, spec, _ = verify_bundle(binding["generation"], roots, expected_mode=GENERATE)
    context, domain_contract = (parse(scoped_raw(binding[name], roots)) for name in ("context", "contract"))
    require(isinstance(context, dict) and isinstance(domain_contract, dict)
            and spec["run_id"] == contract["run"]["id"] == context.get("run_id") == domain_contract.get("run_id")
            and binding["scope_id"] == spec["scope_id"] == context.get("scope_id")
            and context.get("authority_sha256") == bundle["digests"]["authority"]["canonical_sha256"]
            and context.get("contract_sha256") == digest(canonical(domain_contract))
            and domain_contract.get("requirements") == acceptance["requirements"], "tui_authority_binding_mismatch")


def validate_progress(domain, binding, contract):
    bundle, spec, _ = verify_bundle(domain["completion"], contract["observation"]["roots"], expected_mode=PROGRESS)
    require(bundle["generation"] == binding["generation"] and spec["scope_id"] == binding["scope_id"]
            and spec["run_id"] == contract["run"]["id"]
            and all(spec["inputs"][name] == binding[name] for name in ("context", "contract"))
            and spec["inputs"]["checkpoint"] == domain["source"] and bundle["receipt"] == domain["receipt"],
            "tui_authority_progress_binding_mismatch")
