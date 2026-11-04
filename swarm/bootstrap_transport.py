"""Sandbox-safe owner authentication; caller authentication stays on the host.

An ephemeral Ed25519 key belongs to ONE owner lifetime. Only its public key is
published in the independently pinned owner registration. Private bytes travel
to OpenSSL on stdin, never through argv, files, receipts or error messages.
This retains bootstrap's cooperative same-UID threat model, not isolation from
a malicious peer capable of inspecting the owner's memory. No /proc on client.
"""

from pathlib import Path
import re
import subprocess
import tempfile

from coordinator_io import canonical, digest, require


def safe_reason(error):
    value = str(error)
    # Runtime admission is served by this same owner. Keep the typed pending
    # code and bounded protocol diagnostics; never expose arbitrary exceptions.
    if isinstance(error, ValueError) and value in {
            "startup_operator_input_review_required", "startup_runtime_deadline_expired",
            "startup_run_binding_changed", "startup_runtime_binding_changed",
            "startup_runtime_not_established_in_time", "startup_original_owner_required", "startup_persistent_stop",
            "startup_operator_input_binding_changed", "startup_operator_input_source_unverified",
            "startup_operator_input_unsupported", "startup_operator_input_request_changed",
            "startup_operator_input_handling_required", "tui_continuation_deadline"}:
        return value
    if isinstance(error, ValueError) and re.fullmatch(
            r"(?:bootstrap_rpc_rejected:)?bootstrap_[a-z0-9_]{1,100}", value):
        return value
    if isinstance(error, PermissionError):
        return "bootstrap_permission_denied"
    if isinstance(error, TimeoutError):
        return "bootstrap_transport_timeout_requires_reconciliation"
    return "bootstrap_operation_unverifiable"


def openssl(args, data=None):
    try:
        result = subprocess.run(["/usr/bin/openssl", *args], input=data,
                                capture_output=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        raise ValueError("bootstrap_crypto_unavailable") from None
    require(result.returncode == 0, "bootstrap_signature_invalid")
    return result.stdout


class Signer:
    def __init__(self):
        self.private = openssl(["genpkey", "-algorithm", "ED25519"])
        self.public = openssl(["pkey", "-pubout"], self.private).decode("ascii")

    def sign(self, payload):
        # Sign the canonical payload digest, domain-separated from other uses.
        with tempfile.TemporaryDirectory(prefix="bootstrap-sign-") as directory:
            message = Path(directory) / "message"
            message.write_bytes(signed_bytes(payload))
            signature = openssl(["pkeyutl", "-sign", "-rawin", "-inkey", "/dev/stdin",
                                 "-in", str(message)], self.private)
        require(len(signature) == 64, "bootstrap_signature_invalid")
        return dict(payload=payload, signature=signature.hex())


def signed_bytes(payload):
    return b"orca-bootstrap-owner-v2\0" + digest(canonical(payload)).encode("ascii")


def verify(envelope, public, request, owner):
    require(isinstance(envelope, dict) and set(envelope) == {"payload", "signature"},
            "bootstrap_signed_reply_required")
    signature, payload = envelope["signature"], envelope["payload"]
    require(isinstance(signature, str) and re.fullmatch(r"[a-f0-9]{128}", signature),
            "bootstrap_signature_invalid")
    require(isinstance(public, str) and len(public) <= 256
            and public.startswith("-----BEGIN PUBLIC KEY-----\n"), "bootstrap_public_key_invalid")
    with tempfile.TemporaryDirectory(prefix="bootstrap-verify-") as directory:
        root = Path(directory)
        (root / "public").write_text(public)
        (root / "message").write_bytes(signed_bytes(payload))
        (root / "signature").write_bytes(bytes.fromhex(signature))
        openssl(["pkeyutl", "-verify", "-rawin", "-pubin", "-inkey", str(root / "public"),
                 "-in", str(root / "message"), "-sigfile", str(root / "signature")])
    require(isinstance(payload, dict) and set(payload) == {"request_sha256", "owner", "reply"}
            and payload["request_sha256"] == digest(canonical(request)) and payload["owner"] == owner,
            "bootstrap_reply_binding_mismatch")
    require(isinstance(payload["reply"], dict), "bootstrap_message_invalid")
    return payload["reply"]
