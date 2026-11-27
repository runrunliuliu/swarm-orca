"""One-shot authenticated Orca Unix-socket RPC; no CLI, discovery or retries.

Wire source: orca/src/cli/runtime/transport.ts and shared/runtime-bootstrap.ts.
This is not a remote pairing client or an authorization service.
"""
import json
import os
import socket
import time
import uuid
from pathlib import Path

MAX_FRAME = 16 * 1024 * 1024


class RpcError(ValueError):
    pass


def read_metadata(path, runtime_id):
    metadata = json.loads(Path(path).read_text())
    if metadata.get('runtimeId') != runtime_id:
        raise RpcError('runtime_identity_mismatch: rediscover; do not switch runtime')
    token = metadata.get('authToken')
    transports = metadata.get('transports', [metadata.get('transport')])
    unix = [t for t in transports if isinstance(t, dict) and t.get('kind') == 'unix']
    if not isinstance(token, str) or not token or not unix:
        raise RpcError('runtime_metadata_incomplete: requires authenticated Unix transport')
    endpoint = unix[0].get('endpoint')
    if not isinstance(endpoint, str) or not os.path.isabs(endpoint):
        raise RpcError('invalid_unix_endpoint')
    return endpoint, token


def call(metadata_path, runtime_id, method, params, timeout=60):
    """Return the native envelope, including failures. Never retry even a read.

    Total deadline (not refreshed by keepalives) bounds the operator's wait.
    A timeout/EOF after sending is UNKNOWN, not proof the mutation failed.
    """
    if not 0 < timeout <= 600:
        raise RpcError('timeout must be in (0, 600] seconds')
    endpoint, token = read_metadata(metadata_path, runtime_id)
    request_id = str(uuid.uuid4())
    request = {'id': request_id, 'authToken': token, 'method': method, 'params': params}
    wire = (json.dumps(request, ensure_ascii=False) + '\n').encode()
    deadline = time.monotonic() + timeout
    buffer = bytearray()
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(timeout)
        connection.connect(endpoint)
        connection.sendall(wire)
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RpcError('runtime_timeout: reconcile; do not resubmit')
            connection.settimeout(remaining)
            chunk = connection.recv(65536)
            if not chunk:
                raise RpcError('runtime_eof: outcome unknown; reconcile; do not resubmit')
            buffer.extend(chunk)
            while b'\n' in buffer:
                line, _, rest = buffer.partition(b'\n')
                buffer = bytearray(rest)
                if len(line) > MAX_FRAME:
                    raise RpcError('runtime_frame_too_large')
                if not line.strip():
                    continue
                frame = json.loads(line)
                if frame == {'_keepalive': True}:
                    continue
                if not isinstance(frame, dict) or frame.get('id') != request_id:
                    raise RpcError('invalid_response_id')
                if type(frame.get('ok')) is not bool:
                    raise RpcError('invalid_response_envelope')
                if ('result' if frame['ok'] else 'error') not in frame:
                    raise RpcError('invalid_response_envelope')
                meta = frame.get('_meta')
                if not isinstance(meta, dict) or meta.get('runtimeId') != runtime_id:
                    raise RpcError('response_runtime_mismatch: outcome unknown; reconcile')
                return frame
            if len(buffer) > MAX_FRAME:
                raise RpcError('runtime_frame_too_large')
