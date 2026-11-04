"""Pinned local evidence shared by the continuation driver and its adapters."""

from datetime import datetime, timezone
from contextlib import contextmanager, ExitStack
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import sys

from trae_exec_capture import exclusive


def require(value, code):
    if not value:
        raise ValueError(code)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False).encode()


def digest(value):
    return hashlib.sha256(value).hexdigest()


def parse(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "duplicate_json_key")
            result[key] = value
        return result
    def reject(_):
        raise ValueError("nonfinite_json")
    result = json.loads(raw, object_pairs_hook=pairs, parse_constant=reject)
    canonical(result)
    return result


def path(value, *, directory=False):
    require(isinstance(value, str) and Path(value).is_absolute(), "absolute_path_required")
    target = Path(value)
    require(target.resolve(strict=True) == target, "canonical_nonsymlink_path_required")
    require(target.is_dir() if directory else target.is_file(), "wrong_path_type")
    return target


def read_bytes(value):
    from observation_budget import check
    check()
    target = path(str(value))
    fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        require(stat.S_ISREG(os.fstat(stream.fileno()).st_mode), "not_regular")
        size = os.fstat(stream.fileno()).st_size
        raw = stream.read(size)
        require(len(raw) == size, "file_truncated")
    check()
    return raw


def read_json(value):
    result = parse(read_bytes(value))
    require(isinstance(result, dict), "json_object_required")
    return result


def validate_ref(ref):
    require(isinstance(ref, dict) and set(ref) == {"path", "sha256"}
            and isinstance(ref["path"], str) and isinstance(ref["sha256"], str)
            and re.fullmatch(r"[a-f0-9]{64}", ref["sha256"]), "invalid_file_pin")


class FilePinChanged(ValueError):
    """Local hash mismatch, safe to classify without exposing file contents."""

    def __init__(self):
        super().__init__("file_pin_changed")


def pinned(ref, *, json_pin=False):
    validate_ref(ref)
    raw = read_bytes(ref["path"])
    if digest(canonical(parse(raw)) if json_pin else raw) != ref["sha256"]:
        raise FilePinChanged()
    from bootstrap_s5 import current
    guard = current.get()
    if guard is not None:
        guard.verify_read(ref)
    return raw


def file_ref(target):
    return {"path": str(target), "sha256": digest(read_bytes(target))}


def timestamp(value):
    value = datetime.fromisoformat(value)
    require(value.utcoffset() is not None, "timestamp_without_timezone")
    return value


def now():
    return datetime.now(timezone.utc).isoformat()


def fsync_dir(directory):
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_new(target, value):
    with exclusive(target) as stream:
        stream.write(value if isinstance(value, bytes) else canonical(value) + b"\n")
        stream.flush()
        os.fsync(stream.fileno())
    fsync_dir(target.parent)


def publish_new(target, value):
    """Atomically expose one immutable receipt; never replace another claimant's file."""
    # Scoped to the actual protected strict-start entry, never a global monkey
    # patch; imports of this function retain the same production guard.
    from bootstrap_s5 import current
    guard = current.get()
    if guard is not None and guard.publication(target, value):
        return
    fd, temporary = tempfile.mkstemp(prefix="." + target.name + ".", dir=target.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(value if isinstance(value, bytes) else canonical(value) + b"\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.link(temporary, target)  # Atomic, O_EXCL semantics, complete bytes only.
        fsync_dir(target.parent)
    finally:
        os.unlink(temporary)


def publish_directory_new(staging, target):
    """Same-filesystem atomic directory commit, never replacing even an empty target.

    No rename/replace fallback: unsupported kernels/filesystems fail closed.
    The caller retains staging on failure for diagnosis; no recursive cleanup.
    """
    import ctypes
    staging, target = Path(staging), Path(target)
    require(staging.parent == target.parent, "directory_commit_same_parent_required")
    fsync_dir(staging)
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "linux" and hasattr(libc, "renameat2"):
        rename = libc.renameat2
        rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        rename.restype = ctypes.c_int
        result = rename(-100, os.fsencode(staging), -100, os.fsencode(target), 1)  # RENAME_NOREPLACE
    elif sys.platform == "darwin" and hasattr(libc, "renamex_np"):
        rename = libc.renamex_np
        rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        rename.restype = ctypes.c_int
        result = rename(os.fsencode(staging), os.fsencode(target), 4)  # RENAME_EXCL
    else:
        raise OSError(errno.ENOTSUP, "exclusive_directory_commit_unsupported")
    if result != 0:
        code = ctypes.get_errno()
        raise OSError(code, "exclusive_directory_commit_failed")
    fsync_dir(target.parent)


def replace_json(target, value):
    """Single-writer snapshot; a crash leaves the old or complete new document."""
    fd, temporary = tempfile.mkstemp(prefix="." + target.name + ".", dir=target.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(canonical(value) + b"\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
        fsync_dir(target.parent)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class LockBusy(BlockingIOError):
    """Only a nonblocking flock acquisition found another lock holder."""


@contextmanager
def directory_lock(root, name, *, create=True):
    """The shared nonblocking lock inode, without changing its binding."""
    root = path(str(root), directory=True)
    info = root.stat()
    require(info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700,
            "private_state_directory_required")
    target = root / (name + ".lock")
    root_identity = (info.st_dev, info.st_ino)
    fd = os.open(target, (os.O_CREAT if create else 0) | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
                and stat.S_IMODE(info.st_mode) == 0o600, "invalid_lock_file")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            if exc.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                raise LockBusy(exc.errno, "bound_lock_busy") from exc
            raise
        def unchanged():
            if create:
                return
            current, named, parent = os.fstat(fd), target.lstat(), root.stat()
            require(current.st_nlink == named.st_nlink == 1
                    and (current.st_dev, current.st_ino) == (named.st_dev, named.st_ino)
                    == (info.st_dev, info.st_ino)
                    and current.st_uid == named.st_uid == os.getuid()
                    and stat.S_ISREG(named.st_mode)
                    and stat.S_IMODE(current.st_mode) == stat.S_IMODE(named.st_mode) == 0o600
                    and (parent.st_dev, parent.st_ino) == root_identity
                    and parent.st_uid == os.getuid() and stat.S_IMODE(parent.st_mode) == 0o700
                    and root.resolve(strict=True) == root, "existing_lock_changed")
        unchanged()
        # Long-lived cooperative owners may also recheck before each admission.
        # This detects inode/path drift; it is not authentication or protection
        # against a malicious same-UID process replacing the lock concurrently.
        yield unchanged
        unchanged()
    finally:
        os.close(fd)


def correction_fence(root, ref):
    """A prepared correction is fail-closed until its final commit exists."""
    marker = Path(root) / "binding-correction.json"
    if not os.path.lexists(marker):
        return
    intent = read_json(marker)
    require(set(intent) == {"proposal", "new_binding", "commit_path"}, "invalid_binding_correction")
    validate_ref(intent["new_binding"])
    proposal = parse(pinned(intent["proposal"]))
    require(intent["commit_path"] == str(Path(intent["proposal"]["path"]).parent / "committed.json"),
            "invalid_binding_correction")
    require(intent.get("new_binding") == ref, "binding_correction_obsolete_config")
    commit = read_json(intent["commit_path"])
    require(set(commit) == {"schema_version", "state", "proposal", "review", "old_plan", "new_plan", "committed_at"}
            and commit["schema_version"] == 1 and commit["proposal"] == intent["proposal"]
            and commit["state"] == "committed" and commit["old_plan"] == proposal["old_plan"]
            and commit["new_plan"] == proposal["new_plan"], "binding_correction_not_committed")
    review = parse(pinned(commit["review"]))
    require(review.get("proposal") == intent["proposal"] and review.get("approved") is True,
            "binding_correction_not_committed")
    plan = parse(pinned(commit["new_plan"]))
    config = parse(pinned(plan["config"]))
    continuation = parse(pinned(config["continuation"]))
    allowed = {config["state_root"]: (plan["config"], "monitor-binding.json"),
               continuation["state_root"]: (config["continuation"], "tui-continuation-binding.json")}
    require(str(root) in allowed and allowed[str(root)][0] == ref,
            "binding_correction_wrong_target")
    require(read_json(Path(root) / allowed[str(root)][1]) == ref, "binding_correction_binding_changed")


@contextmanager
def bound_lock(root, ref, name):
    """One private state directory, writer and immutable configuration binding."""
    with directory_lock(root, name):
        correction_fence(root, ref)
        target = root / (name + "-binding.json")
        if not os.path.lexists(target):
            publish_new(target, ref)
        require(read_json(target) == ref, name + "_config_changed")
        yield


@contextmanager
def try_bound_lock(root, ref, name):
    """Yield False on acquisition contention only; body/binding errors propagate.

    The singleton monitor/driver must keep using the exclusive bound_lock.
    Callers must return without mutation when acquisition did not succeed.
    """
    with ExitStack() as stack:
        try:
            stack.enter_context(bound_lock(root, ref, name))
        except LockBusy:
            acquired = False
        else:
            acquired = True
        yield acquired


def scoped_refs(refs, roots, excluded):
    """Validate evidence locations/content, without treating them as execution proof."""
    require(isinstance(refs, list), "invalid_evidence_refs")
    for ref in refs:
        validate_ref(ref)
        target = path(ref["path"])
        require(any(target.is_relative_to(root) for root in roots)
                and not any(target == item or target.is_relative_to(item) for item in excluded),
                "progress_artifact_outside_scope")
        pinned(ref)  # Scope first: never read out-of-scope contents to validate a hash.
    return refs
