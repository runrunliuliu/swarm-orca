"""Sandbox-side binding client. No process discovery, transcripts or private keys.

The public key and endpoint are operator-pinned configuration, not receipt fields.
Ed25519 uses OpenSSL 3; Python dependencies remain standard-library only.
"""

import base64
import hashlib
import json
from pathlib import Path
import re
import secrets
import socket
import subprocess
import tempfile
import time

from supervisor.config import SafetyError, require
from .ledger import timestamp

LIMIT = 65536
SCOPE_FIELDS = {"runtime_id", "run_id", "agent_id", "terminal_handle", "worktree_id", "host", "provider"}


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def validate_request(request):
    require(isinstance(request, dict) and set(request) == {"scope", "nonce", "since", "until"},
            "binding_invalid_request")
    scope = request["scope"]
    require(isinstance(scope, dict) and set(scope) == SCOPE_FIELDS, "binding_invalid_scope")
    for key in SCOPE_FIELDS - {"run_id"}:
        require(isinstance(scope[key], str) and 0 < len(scope[key]) <= 1024 and
                not any(ord(c) < 32 for c in scope[key]), "binding_invalid_scope")
    require(scope["provider"] == "codex", "binding_unsupported_provider")
    require(isinstance(request["nonce"], str) and re.fullmatch(r"[0-9a-f]{64}", request["nonce"]),
            "binding_invalid_nonce")
    if scope["run_id"] is None:
        require(scope["agent_id"] == "coordinator" and request["since"] is None and request["until"] is None,
                "binding_invalid_preflight")
    else:
        require(isinstance(scope["run_id"], str) and 0 < len(scope["run_id"]) <= 1024,
                "binding_invalid_run")
        require(request["since"] == timestamp(request["since"]) and request["since"] is not None and
                request["until"] == timestamp(request["until"]) and request["until"] is not None,
                "binding_invalid_window")
    return scope


def crypto(payload, key, signature=None, *, openssl="/usr/bin/openssl"):
    """No shell, no stderr/key material in errors; bounded subprocess lifetime."""
    with tempfile.TemporaryDirectory(prefix="orca-binding-crypto-") as directory:
        root = Path(directory)
        (root / "message").write_bytes(encoded(payload))
        args = [openssl, "pkeyutl", "-rawin", "-inkey", str(key), "-in", str(root / "message")]
        if signature is None:
            args += ["-sign"]
        else:
            require(isinstance(signature, str) and len(signature) <= 128, "binding_invalid_signature")
            raw = base64.b64decode(signature, validate=True)
            require(len(raw) == 64, "binding_invalid_signature")
            (root / "signature").write_bytes(raw)
            args += ["-verify", "-pubin", "-sigfile", str(root / "signature")]
        try:
            result = subprocess.run(args, capture_output=True, timeout=10)
        except (OSError, subprocess.TimeoutExpired) as error:
            raise SafetyError("binding_crypto_unavailable") from error
        require(result.returncode == 0, "binding_signature_failed")
        if signature is None:
            require(len(result.stdout) == 64, "binding_not_ed25519")
            return base64.b64encode(result.stdout).decode()


def receive(connection):
    data = bytearray()
    while len(data) <= LIMIT:
        chunk = connection.recv(min(4096, LIMIT + 1 - len(data)))
        if not chunk:
            break
        data.extend(chunk)
        if b"\n" in chunk:
            break
    require(len(data) <= LIMIT and data.endswith(b"\n") and data.count(b"\n") == 1,
            "binding_invalid_frame")
    return json.loads(data)


def verify(receipt, request, public_key, *, now=None, openssl="/usr/bin/openssl"):
    validate_request(request)
    require(isinstance(receipt, dict) and set(receipt) == {"payload", "signature"}, "binding_invalid_receipt")
    payload = receipt["payload"]
    crypto(payload, public_key, receipt["signature"], openssl=openssl)
    require(payload.get("schema") == "orca-host-binding-v1" and payload.get("request") == request,
            "binding_scope_or_nonce_mismatch")
    observed, expires = payload.get("observed_at"), payload.get("expires_at")
    now = time.time() if now is None else now
    require(type(observed) in (int, float) and type(expires) in (int, float) and
            0 < expires - observed <= 60 and observed <= now + 5 and now < expires and
            now - observed <= 60, "binding_expired_or_future")
    require(isinstance(payload.get("identity"), dict) and payload["identity"].get("session_id"),
            "binding_identity_missing")
    sample = payload.get("sample")
    if request["scope"]["run_id"] is None:
        require(sample is None, "binding_preflight_has_usage")
    else:
        require(isinstance(sample, dict) and sample.get("provider") == "codex" and
                sample.get("session_id") == payload["identity"]["session_id"] and
                sample.get("since") == request["since"] and sample.get("until") == request["until"],
                "binding_sample_scope_mismatch")
    return payload


class Client:
    def __init__(self, endpoint, public_key, *, openssl="/usr/bin/openssl"):
        self.endpoint, self.public_key, self.openssl = endpoint, public_key, openssl

    def capture(self, scope, since=None, until=None):
        request = {"scope": scope, "nonce": secrets.token_hex(32),
                   "since": timestamp(since), "until": timestamp(until)}
        validate_request(request)
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(60)
            connection.connect(self.endpoint)
            connection.sendall(encoded(request) + b"\n")
            receipt = receive(connection)
        # Unsigned service errors are diagnostics, never identity or lifecycle evidence.
        if isinstance(receipt, dict) and "error" in receipt:
            reason = receipt["error"]
            code = reason if isinstance(reason, str) and re.fullmatch(r"binding_[a-z_]{1,80}", reason) else "unknown"
            raise SafetyError("binding_collector_unverifiable:" + code)
        verify(receipt, request, self.public_key, openssl=self.openssl)
        return receipt


def ledger_sample(ledger, runtime, run, options):
    """Consume fresh authenticated evidence, then pin identity in the ledger transaction."""
    data = ledger.get(runtime, run)
    actor = data["agents"][options["agent_id"]]
    terminal = data["coordinator_handle"] if options["agent_id"] == "coordinator" else actor["terminal_handle"]
    require(terminal and actor.get("provider") in (None, "codex"), "binding_native_actor_mismatch")
    if options["agent_id"] != "coordinator":
        require(actor.get("host") == "local", "binding_remote_worker_unsupported")
    scope = {"runtime_id": runtime, "run_id": run, "agent_id": options["agent_id"],
             "terminal_handle": terminal, "worktree_id": options["worktree_id"],
             "host": options["host"], "provider": "codex"}
    require(not options.get("final"), "binding_live_capture_cannot_finalize")
    receipt = Client(options["socket"], options["public_key"]).capture(
        scope, options["since"], options.get("until") or ledger.now())
    payload = receipt["payload"]
    pin_key = "host-binding:" + hashlib.sha256(encoded(scope)).hexdigest()
    previous = ledger.store.get(pin_key)
    require(previous is None or previous == payload["identity"], "binding_identity_changed")
    ledger.store.put(pin_key, payload["identity"])
    receipt_id = hashlib.sha256(encoded(receipt)).hexdigest()
    ledger.store.put("host-receipt:" + receipt_id, receipt)
    sample = dict(payload["sample"])
    sample["source"] = "host-binding:sha256:" + receipt_id
    return sample
