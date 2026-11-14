"""Read-only native Trae planning and live consumption of an Operator session gate.

No token creation/copying, Run creation, terminal launch or automatic recovery.
Legacy capture plans and v1 receipts are never silently upgraded.
"""

import argparse
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys

from coordinator_input import bind_prompt, input_bytes
from coordinator_io import canonical, digest, now, parse, pinned, timestamp
from coordinator_loop import phase_contract
from trae_coordinator import build_trae_plan, native, verify_trae_executable
import pi_coordinator
import tui_adapter

CAPABILITY = "orchestration.strict-caller-check.v1"
# terminal.create uses AgentArgs from rpc-contract/agent-session-params.ts.
MAX_AGENT_ARGS_BYTES = 16 * 1024
# The reviewed phase contract and business handoff are pinned in files/hashes.
# They can be materially larger than Orca's native AgentArgs field, but they
# must still be bounded and validated before a native launch plan is accepted.
MAX_PINNED_INPUT_BYTES = 256 * 1024


class StrictCheckError(ValueError):
    """Fixed local diagnostics only; native/provider messages remain private."""


def require(condition, code):
    if not condition:
        raise StrictCheckError(code)


def provider_of(plan):
    """Which provider this recipe launches, from the plan's adapter (absent = historical Trae)."""
    adapter = plan.get("adapter")
    if adapter == tui_adapter.PI_ADAPTER:
        return "pi"
    # Historical recipes carry the Trae TUI adapter or the Trae exec adapter; an absent
    # adapter is the oldest Trae shape. Anything else is refused, never guessed.
    require(adapter in (None, tui_adapter.TRAE_ADAPTER, tui_adapter.EXEC_ADAPTER),
            "strict_plan_adapter_unsupported")
    return "trae"


def provider_verification_text(agent):
    """The settings the live Coordinator must actually verify, per provider.

    Trae attests model/effort/Max/sandbox/approvals; Pi attests only provider, model
    selector and thinking level, so telling a Pi pane to verify sandbox or Max would ask
    for evidence that provider cannot produce. The Trae string stays byte-identical.
    """
    if agent == "pi":
        return (" Verify actual Pi model provider, model selector and thinking level against "
                "the pinned policy ")
    return " Verify actual Trae model, effort, Max, sandbox and approvals against "


def caller_result(value, runtime):
    """Accept real CLI receipts and historical result-only pins, without rewriting either."""
    require(isinstance(value, dict), "strict_initial_caller_receipt_required")
    if any(key in value for key in ("ok", "result", "_meta", "error")):
        require(value.get("ok") is True and "error" not in value
                and isinstance(value.get("_meta"), dict)
                and value["_meta"].get("runtimeId") == runtime
                and isinstance(value.get("result"), dict), "strict_caller_envelope_invalid")
        value = value["result"]
    caller = value.get("caller")
    require(value.get("coordinatorPolicy") == "strict-v1"
            and value.get("effectsApplied") is False
            and isinstance(value.get("checkedAt"), str)
            and isinstance(caller, dict)
            and all(isinstance(caller.get(k), str) and caller[k]
                    for k in ("terminalHandle", "authorityFingerprint", "paneKey", "processIncarnation"))
            and isinstance(caller.get("hostScope"), dict), "strict_initial_caller_receipt_required")
    timestamp(value["checkedAt"])
    return value


HELPER_FILES = ("coordinator_launch.py",
                "coordinator-worker-plan.md", "coordinator_tui_continue.py")


def helper_root_root(helper_root):
    """Resolve the helper tree an attempt is pinned to; never guess across trees.

    The default keeps historical behaviour (the tree that assembled the plan), but a
    materials input may pin another reviewed tree, and then it must really carry the
    helper files: a prompt pointing at a half-populated tree is worse than none.
    """
    if helper_root is None:
        return Path(__file__).resolve().parent
    require(isinstance(helper_root, str) and helper_root, "strict_helper_root_invalid")
    root = Path(helper_root)
    require(root.is_absolute() and root.resolve() == root and root.is_dir(),
            "strict_helper_root_invalid")
    require(all((root / name).is_file() for name in HELPER_FILES),
            "strict_helper_root_incomplete")
    return root


def strict_bootstrap_prompt(plan, root=None):
    """Small native prompt for terminal.create; the full contract stays pinned.

    Orca's native Trae TUI launch is constrained by AgentArgs. The business
    contract remains the rendered stdin validated by input_contract; this prompt
    only tells the live Coordinator how to find and verify the pinned material.

    `root` pins the helper tree. Without it the prompt names whichever tree
    assembled the plan, which is not necessarily the attempt's reviewed baseline.
    """
    root = Path(root) if root is not None else Path(__file__).resolve().parent
    helper = str(root / "coordinator_launch.py")
    worker_protocol = str(root / "coordinator-worker-plan.md")
    continuation = str(root / "coordinator_tui_continue.py")
    contract = plan["input_contract"]
    directory = Path(plan["startup_delivery"]["directory"])
    caller_receipt = directory.parent / "initial-caller.json"
    # The S0-S5 attempt chain and its owner/commit actions are retired, so there is no
    # registered variant left to describe: one caller receipt per live Coordinator.
    caller_line = (
        "Run orchestration strict-caller-check in this live Coordinator context and preserve the "
        "raw receipt at: " + str(caller_receipt) + ". Do not write or replace an existing receipt "
        "there; a self-written slot stays unconfirmed forever.")
    lines = [
        "Strict Coordinator bootstrap: this is a short native prompt; use pinned files, not inline stdin.",
        "Do not treat this short prompt as the full task or authority.",
        "Prompt file: " + plan["prompt_file"],
        "Full pinned stdin sha256: " + contract["stdin_sha256"],
        "Brief sha256: " + contract["brief_sha256"],
        "Phase fragment sha256: " + contract["fragment_sha256"],
        "Helper: " + helper,
        # Generated from the action table, so a stage cannot be missing from the page an Operator
        # reads while the code still expects it (see swarm/generate_runbook.py --check).
        # The generated runbook went with the handshake; the start grant's own document is the
        # operator-facing reference now.
        "Operator reference: docs/design/start-grant.md",
        # Surfaced, and pointed at one action: a pane told only "read on demand" kept searching
        # anyway (52-70% of its tool calls), while telling it to look the name up here first cut
        # searches by a third. Still not required reading: it is an index of line ranges, and
        # adding it to the required reading would grow the reading this change exists to shrink.
        "Symbol orientation (generated; look a name up here before searching): "
        + str(root / "ORIENTATION.md"),
        "First, read the prompt file in full and verify the supplied pins before caller-check or "
        "any filesystem writes.",
        "Protocol-owned directory (not an evidence directory): " + str(directory) +
        ". Leave it absent: its config/ready/transfer slots belonged to the retired chain, so "
        "do not create it and do not write caller/status/raw evidence there.",
        caller_line,
        "Startup authorisation is ONE start grant minted by the Operator (orca orchestration "
        "start-grant-mint) and handed down once by the helper (coordinator_launch.py start-grant-hand "
        "--record <record> --to <handle>) with the objective, max_workers, repository scope and "
        "deadline. "
        "The config-delivery and lifecycle chain (strict-config-*, strict-start-prepare/-plan/-wait/"
        "-publish, the S0-S5 handshake and startup_handoff) is retired and its tools are deleted: do "
        "not publish readiness_evidence, read a gate file or reconstruct that sequence, and do not "
        "follow the lifecycle/registration steps this plan's legacy fields imply. Create the Run "
        "under the grant with run-create --grant <grant_id> --strict-coordinator: the objective must "
        "equal the approved one, one grant covers one Run, and a repeat from this same live "
        "Coordinator returns the existing Run instead of a second one. Keep the grant Ref and the "
        "original caller receipt with the Run evidence. The grant is recorded, not yet enforced "
        "(START_GRANT_REQUIRED is false), so it authorises the Run without proving anything it does "
        "not approve.",
        "Do not create a Run before the Operator hands down the grant, and do not dispatch Workers "
        "before the Run exists. An uncertain create result is reconciled against the grant and the "
        "Run list, never replayed.",
        "Worker planning must use coordinator_launch.py worker-plan --request <absolute JSON> --request-sha256 <sha256>; protocol: " + worker_protocol + ".",
        "Keep objective/authority/max_workers/deadline/writable roots from the reviewed task_source and gates; do not reinterpret recovery notes.",
    ]
    if plan["execution"]["launch_mode"] == "tui":
        lines.append("TUI continuation helper: " + continuation + "; publish validated checkpoints and run turn-end before ending turns.")
    else:
        lines.append("Do not end the exec turn for terminal follow-up; if required, stop and report the incompatible launch contract.")
    reviewed = plan.get("reviewed_inputs")
    if reviewed:
        lines.append(
            "Operator static preparation already froze the reviewed inputs (" +
            str(plan.get("reviewed_input_snapshot_count")) + " snapshots, " +
            str(plan.get("reviewed_input_baseline_count")) + " baselines): " +
            reviewed["path"] + " sha256 " + reviewed["sha256"] +
            ". Read pins from that manifest instead of re-deriving them from the repository. Planning "
            "re-checked every frozen ref and each baseline's head/cleanliness: a snapshot mismatch or a "
            "baseline drift is a stop, and it is not re-pinned by a later layer. It is pinned input, not "
            "authorization: the Operator still verifies every pin itself and still owns binding, "
            "registration and owner publication.")
    return "\n".join(lines) + "\n"


def strict_plan(plan, *, registered_bootstrap=False, reviewed_inputs=None, helper_root=None):
    root = helper_root_root(helper_root)
    require(plan["phase"] == "bootstrap" and plan["resume_session"] is None
            and plan.get("replacement_run") is None, "strict_requires_fresh_native_bootstrap")
    archive = Path(plan["artifact_dirs"]["archive"])
    # A registered attempt's caller slot belongs to commit_owner. Producing the
    # historical direct-write prompt for such an attempt is unrecoverable (the
    # slot stays unconfirmed forever), so absence of the flag cannot be treated
    # as "not registered" once registration evidence exists.
    registered_evidence = (archive / "attempt-binding.json", archive / "control" / "owner.json")
    require(registered_bootstrap or not any(os.path.lexists(p) for p in registered_evidence),
            "strict_registered_bootstrap_required")
    # A registered attempt starts from frozen, independently audited static inputs
    # (Operator `prepare`). Without the pin every role re-derives them live, which
    # is both slow and the class of error that wastes an attempt (stale task path).
    require(not registered_bootstrap or reviewed_inputs is not None,
            "strict_reviewed_inputs_required")
    prepared = None
    if reviewed_inputs is not None:
        require(isinstance(reviewed_inputs, dict) and set(reviewed_inputs) == {"path", "sha256"},
                "strict_reviewed_inputs_invalid")
        from operator_prepare import verify_prepared
        prepared = verify_prepared(reviewed_inputs)
    executable = plan["argv"][0]
    tui = plan["execution"]["launch_mode"] == "tui"
    # The recipe, not the caller, decides which provider this plan launches: a Trae adapter
    # pins sandbox/approval/Max, a Pi adapter pins the reviewed policy. Mixing them (a Pi
    # pane told to verify Trae settings) is the defect this keeps out of the prompt.
    agent = provider_of(plan)
    # Inlined: this module outlives the strict delivery module, and the plan text needs the same
    # fixed slots it published.
    archive = Path(plan["artifact_dirs"]["archive"])
    delivery = {"mode": "continuous-native-file-v1",
                "request_path": str(archive / "strict-config-request.json"),
                "publication_path": str(archive / "strict-config-ready.json"),
                "directory": str(archive / "strict-start")}
    phase = "strict-tui-bootstrap" if tui else "strict-bootstrap"
    if helper_root is not None:
        # Only a pinned root enters the plan; the default shape stays untouched.
        plan = dict(plan, helper_root=str(root))
    plan = dict(plan, phase=phase, strict_coordinator=True,
                registered_bootstrap=bool(registered_bootstrap),
                reviewed_inputs=reviewed_inputs,
                reviewed_input_snapshot_count=None if prepared is None else prepared["snapshot_count"],
                reviewed_input_baseline_count=None if prepared is None else prepared["baseline_count"],
                startup_delivery=delivery,
                prompt_fragment=phase_contract(phase, root) + provider_verification_text(agent) +
                plan["runtime_config"] + ". Canonical cwd/write roots: " +
                json.dumps([plan["cwd"], *plan["task_write_roots"]]) + ".")
    plan["prompt_fragment"] += (
        " Verified helper entry (use this absolute path, not the target repository's cwd): "
        + shlex.join([sys.executable, "-B", str(root / "coordinator_launch.py")])
        + ". Startup authorisation is one start grant minted by the Operator and handed down once; "
        "create the Run with run-create --grant <grant_id> --strict-coordinator from this live "
        "Coordinator. The request/publication/transfer slots this plan still names are legacy "
        "artefacts of the retired chain: leave them absent, do not publish a request for them and "
        "do not wait on a gate file. "
        "Run objective comes verbatim from the business task_source, never a recovery substep. "
        "Do not infer authorization from that task file. Never handwrite coordinator identity: provider session "
        "is not caller.paneKey, and terminal incarnation is not the full processIncarnation. "
        "Use task_deadline=null when no whole-task deadline was authorized. "
        "Worker timeout_ms=90000 means 90 seconds for Worker startup only, not a startup deadline. "
        " " + (
        "After startup, end model turns only with the TUI still alive and the continuation or "
        "dependency wakeup durably recorded. Continuation helper: " +
        str(root / "coordinator_tui_continue.py") + "."
        if tui else "Do not end the exec turn for terminal follow-up; "
        "if the task brief requires that, stop and report the incompatible launch contract."))
    plan = bind_prompt(plan, plan["prompt_file"])
    stdin = input_bytes(plan)
    require(b"\0" not in stdin and len(stdin) <= MAX_PINNED_INPUT_BYTES,
            "strict_native_prompt_too_large_or_invalid")
    # Why: parts of the contract are shared text that embeds this module's own tree.
    # Rewriting that prefix once is what keeps every helper path in the prompt on the
    # tree the attempt is pinned to, not the tree that happened to assemble it.
    own_root = str(Path(__file__).resolve().parent)
    if str(root) != own_root:
        plan["prompt_fragment"] = plan["prompt_fragment"].replace(own_root, str(root))
    prompt = strict_bootstrap_prompt(plan, root)
    require("\0" not in prompt, "strict_native_prompt_too_large_or_invalid")
    # Check the final quoted UTF-8 payload against the native RPC contract.
    # Trae's argv ends with its "-" stdin sentinel; a Pi argv has no sentinel, so its
    # provider/model/thinking flags are all real and must survive the slice.
    tail = plan["argv"][1:-1] if agent == "trae" else plan["argv"][1:]
    args = [*tail, prompt]
    agent_args = shlex.join(args)
    require("\0" not in agent_args and len(agent_args.encode()) <= MAX_AGENT_ARGS_BYTES,
            "strict_native_prompt_too_large_or_invalid")
    plan["argv"] = None  # Never executable through the raw capture adapter.
    plan["native_launch"] = {
        "schema_version": 1, "method": "terminal.create", "agent": agent,
        "agent_args": agent_args, "stdin_required": False,
        "prompt_sha256": plan["input_contract"]["stdin_sha256"],
        "prompt_delivery": "pinned-files-short-prompt-v1",
        "short_prompt_sha256": digest(prompt.encode("utf-8")),
        "required_capability": CAPABILITY,
        "strict_eligible": True,
        "requires_live_caller_check": True,
        "verified_executable": executable,
    }
    return plan


def verify_native_inputs(ref, plan, *, cli, runtime, workspace, materials_ref, operator_input_ref):
    from operator_materials import verify_materials
    from operator_session import verify_operator_identity

    checklist = verify_materials(materials_ref)
    artifacts = checklist.get("artifacts")
    require(isinstance(artifacts, dict) and artifacts.get("bound_launch_plan") == ref,
            "strict_native_materials_plan_mismatch")
    business = checklist.get("business_task")
    expected_workspace = business.get("workspace") if isinstance(business, dict) else None
    require(isinstance(expected_workspace, dict)
            and expected_workspace.get("id") == workspace
            and expected_workspace.get("path") == plan["cwd"],
            "strict_native_materials_workspace_mismatch")

    operator = verify_operator_identity(operator_input_ref)
    source = operator["source"]
    session = operator["session"]
    require(source["cli"] == cli and source["runtime"] == runtime and source["workspace"] == workspace
            and session["runtime"] == runtime and session["workspace"] == workspace,
            "strict_native_operator_scope_mismatch")
    return {"materials": checklist, "operator": operator}


def native_plan(ref, *, cli, runtime, workspace, materials=None, operator_input=None):
    """Check selected host capability and exact workspace before returning launch argv."""
    require(os.name == "posix", "strict_native_requires_posix_operator")
    require(materials is not None and operator_input is not None,
            "strict_native_prelaunch_materials_required")
    plan = parse(pinned(ref))
    require(plan.get("strict_coordinator") is True, "strict_native_plan_required")
    input_bytes(plan)
    # Validate the whole launch recipe, not only its prompt pin.
    executable = plan["native_launch"]["verified_executable"]
    agent = provider_of(plan)
    if agent == "pi":
        rebuilt = pi_coordinator.build_pi_plan(
            pi=executable, cwd=plan["cwd"], bootstrap_dir=plan["artifact_dirs"]["archive"],
            write_dirs=plan["task_write_roots"], selection=plan["selection"],
            runtime_config=plan["runtime_config"], prompt_file=plan["prompt_file"],
            cli_version=plan["cli_version"])
    else:
        rebuilt = build_trae_plan(
            trae=executable, cwd=plan["cwd"], archive_dir=None,
            bootstrap_dir=plan["artifact_dirs"]["archive"], write_dirs=plan["task_write_roots"],
            selection=plan["selection"], runtime_config=plan["runtime_config"],
            prompt_file=plan["prompt_file"], resume_session=None)
    # Why: a plan built with a pinned helper tree records `helper_root`, and
    # `strict_plan` only writes that key when it receives the root. Rebuilding
    # without it therefore always differs from the reviewed plan and would refuse
    # every pinned-helper plan as `strict_native_plan_changed`.
    rebuilt = strict_plan(rebuilt,
                          registered_bootstrap=plan.get("registered_bootstrap") is True,
                          reviewed_inputs=plan.get("reviewed_inputs"),
                          helper_root=plan.get("helper_root"))
    require(plan == rebuilt, "strict_native_plan_changed")
    verified = verify_native_inputs(ref, plan, cli=cli, runtime=runtime, workspace=workspace,
                                    materials_ref=materials, operator_input_ref=operator_input)
    status = native(cli, runtime, ["status"])["runtime"]
    require(status.get("state") == "ready" and CAPABILITY in status.get("capabilities", []),
            "strict_native_runtime_unsupported")
    require(isinstance(workspace, str) and workspace.strip(), "explicit_workspace_required")
    target = native(cli, runtime, ["worktree", "show", "--worktree", "id:" + workspace])["worktree"]
    require(target.get("id") == workspace and target.get("path") == plan["cwd"],
            "strict_native_workspace_mismatch")
    executable_observation = (pi_coordinator.verify_pi_executable(executable, plan["cli_version"])
                              if agent == "pi" else
                              verify_trae_executable(executable, plan["cli_version"]))
    pinned(ref)
    # Orca treats a separate --leading value as another CLI flag. Preserve the
    # historical exec argv, but pass TUI options as one unambiguous assignment.
    agent_args = plan["native_launch"]["agent_args"]
    agent_args_flags = (["--agent-args=" + agent_args] if agent_args.startswith("--")
                        else ["--agent-args", agent_args])
    return {"schema_version": 1, "mode": "strict_native_launch_plan", "runtime": runtime,
            "workspace": workspace, "plan_sha256": ref["sha256"],
            "materials_sha256": materials["sha256"],
            "operator_input_sha256": operator_input["sha256"],
            "operator_session": verified["operator"]["session"],
            "executable_observation": executable_observation,
            "argv": [cli, "terminal", "create", "--worktree", "id:" + workspace,
                     "--agent", agent, *agent_args_flags, "--json"],
            "execution_authorized": False,
            "requirements": [("Verify the execution host's configured Pi executable matches " if agent == "pi"
                              else "Verify the execution host's configured Trae executable matches ") + executable,
                             "Recheck executable immediately before launch; this local observation cannot fence native binary selection or auto-update",
                             ("Observe explicit TUI hook/session mapping, pinned strict caller and actual settings"
                              if plan["execution"]["launch_mode"] == "tui" else
                              "Observe fresh native thread.started and actual settings"),
                             "Run strict-caller-check inside the live Coordinator before bootstrap",
                             "Do not retry an unknown terminal.create outcome"]}


def check_session(contract_ref, receipt_ref, caller_ref):
    from coordinator_startup import KIND, identity, validate
    contract = parse(pinned(contract_ref))
    validate(contract)
    receipt = parse(pinned(receipt_ref))
    initial = caller_result(parse(pinned(caller_ref)), contract["runtime"])
    require(contract["schema_version"] == 2 and contract["run"] is None,
            "strict_session_requires_v2_session_contract")
    require(receipt.get("schema_version") == 2 and receipt.get("kind") == KIND
            and receipt.get("ok") is True and receipt.get("actor") == "operator"
            and receipt.get("phase") == "session"
            and receipt.get("contract_sha256") == contract_ref["sha256"]
            and receipt.get("identity_sha256") == digest(canonical(identity(contract))),
            "strict_operator_session_receipt_mismatch")
    require(initial.get("coordinatorPolicy") == "strict-v1"
            and initial.get("effectsApplied") is False
            and timestamp(initial["checkedAt"]) <= timestamp(receipt["started_at"])
            and initial.get("caller", {}).get("authorityFingerprint"),
            "strict_initial_caller_receipt_required")
    coordinator = contract["coordinator"]
    if tui_adapter.is_tui(contract["adapter"]):
        require(caller_ref == contract["observation"]["caller_receipt"], "tui_caller_pin_changed")
    require(os.environ.get("ORCA_TERMINAL_HANDLE") == coordinator["terminal"],
            "strict_coordinator_native_context_required")
    def fresh():
        require(timestamp(receipt["started_at"]) <= timestamp(receipt["completed_at"])
                <= timestamp(now()) <= timestamp(receipt["valid_until"]),
                "strict_operator_session_receipt_stale")
    fresh()
    cli, runtime = contract["cli"]["path"], contract["runtime"]
    proof = native(cli, runtime, ["orchestration", "strict-caller-check"])
    require(proof.get("caller") == initial["caller"], "strict_launch_authority_changed")
    terminal = native(cli, runtime, ["terminal", "show", "--terminal", coordinator["terminal"]])["terminal"]
    require(proof.get("coordinatorPolicy") == "strict-v1"
            and proof["caller"]["terminalHandle"] == coordinator["terminal"]
            and terminal.get("incarnationId") == coordinator["incarnation"]
            and terminal.get("worktreeId") == contract["workspace"]["id"]
            and terminal.get("connected") is True and terminal.get("orphaned") is False,
            "strict_live_identity_changed")
    after = native(cli, runtime, ["orchestration", "strict-caller-check"])
    require(after.get("caller") == proof["caller"], "strict_live_identity_changed")
    fresh()
    pinned(contract_ref)
    pinned(receipt_ref)
    pinned(caller_ref)
    return {"ok": True, "effectsApplied": False, "caller": proof["caller"],
            "contract_sha256": contract_ref["sha256"], "receipt_sha256": receipt_ref["sha256"],
            "caller_sha256": caller_ref["sha256"],
            "valid_until": receipt["valid_until"], "execution_authorized": False}


def cli_main(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="mode", required=True)
    launch = commands.add_parser("strict-native-plan")
    for name in ("plan", "plan-sha256", "cli", "runtime", "workspace",
                 "materials", "materials-sha256", "operator-input", "operator-input-sha256"):
        launch.add_argument("--" + name, required=True)
    check = commands.add_parser("strict-session-check")
    for name in ("contract", "contract-sha256", "receipt", "receipt-sha256",
                 "caller-receipt", "caller-sha256"):
        check.add_argument("--" + name, required=True)
    args = parser.parse_args(argv)
    try:
        if args.mode == "strict-native-plan":
            result = native_plan({"path": args.plan, "sha256": args.plan_sha256},
                                 cli=args.cli, runtime=args.runtime, workspace=args.workspace,
                                 materials={"path": args.materials, "sha256": args.materials_sha256},
                                 operator_input={"path": args.operator_input,
                                                 "sha256": args.operator_input_sha256})
        else:
            result = check_session({"path": args.contract, "sha256": args.contract_sha256},
                                   {"path": args.receipt, "sha256": args.receipt_sha256},
                                   {"path": args.caller_receipt, "sha256": args.caller_sha256})
    except (OSError, ValueError, KeyError, TypeError, AttributeError, subprocess.SubprocessError) as exc:
        # Never expose native output or a credential in error text.
        print(json.dumps({"ok": False, "decision": "stop",
                          "error": str(exc) if isinstance(exc, StrictCheckError)
                          else "strict_native_check_failed"}))
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0
