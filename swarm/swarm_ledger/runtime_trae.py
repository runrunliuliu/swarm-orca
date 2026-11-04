"""Trae adapter for an exact execution-host runtime binding, never log discovery."""

from supervisor.config import digest, require
from . import raw_usage, trae_jsonl


LOCAL_HOST = {"kind": "local", "hostId": "local"}


def validate_meta(payload):
    raw_usage.trae_jsonl_contract(payload.get("cli_version"))
    require(payload.get("model_provider") == "trae" and
            payload.get("originator") == "traex-tui" and isinstance(payload.get("session_id"), str) and
            bool(payload["session_id"]) and payload.get("source") in (None, "cli") and
            payload.get("agent_id") is None, "runtime_state_unsupported_trae_root_session")


def sample(content, identity, meta, prefix, scope, start, end):
    require(scope is not None and scope.get("run_id") and scope.get("agent_id"),
            "runtime_state_trae_scope_required")
    bound = {**scope, "host": LOCAL_HOST, "thread_id": identity["session_id"],
             "session_id": meta["session_id"], "terminal_handle": identity["terminal"]["handle"],
             "verified_prefix": prefix, "source": "runtime-state-identity:sha256:" + digest(identity)}
    return trae_jsonl.scan(None, bound, start, end, content=content)


def check_exact_session(relation, evidence):
    exact, identity = relation.get("provider_session"), evidence["identity"]
    require(isinstance(exact, dict), "runtime_state_missing_exact_provider_session")
    terminal = identity["terminal"]
    # Orca's native identity includes the entire PTY ID, which may itself contain colons.
    process_incarnation = terminal["ptyId"] + ":" + terminal["incarnationId"]
    require(exact.get("agent") == "trae" and exact.get("connectionId") is None and not exact.get("wslDistro") and
            exact.get("paneKey") == terminal["tabId"] + ":" + terminal["leafId"] and
            exact.get("processIncarnation") == process_incarnation and
            exact.get("launchTokenHash") == identity["launch_token_hash"] and
            exact.get("providerSession") == {"key": "session_id", "id": identity["session_id"],
                                            "transcriptPath": identity["transcript_path"]},
            "runtime_state_exact_provider_session_mismatch")
    require(exact.get("observedAt") == evidence["hook"]["received_at_ms"],
            "runtime_state_exact_provider_observation_mismatch")
