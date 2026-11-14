"""Pinned local evidence shared by the continuation driver and its adapters."""

from collections import OrderedDict
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
import threading
import time

from trae_exec_capture import exclusive
import blocking_io


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


# Reuse of an already verified file identity, never of a path or of a pin verdict.
#
# The expensive step on a network workspace mount is the open() itself (measured
# ~1.0 ms per cold file on the NAS mount against ~40 us for the strict path check),
# so a second read of the same inode repeats one lstat instead of open+read+sha256.
# The key is the path together with the kernel identity
# (st_dev, st_ino, st_size, st_mtime_ns, st_ctime_ns):
# an in-place rewrite of the same size still moves st_ctime_ns. os.utime restores
# st_mtime_ns but not st_ctime_ns (measured). Timestamps are quantized, though: this
# host's ext4 mount reports a 1 ms quantum, so two writes inside one tick carry an
# identical mtime *and* ctime. An entry is therefore retained only when its
# timestamps are already a full second older than the read that produced it
# (coarsest quantum we accept, covering 1 s NFS/FAT style timestamps): a freshly
# written file is simply read again until it settles, and any later write is then
# guaranteed to move a stamp. Cached entries are per process, in memory only,
# bounded, and never a substitute for the caller's own comparison: pinned() still
# compares the digest and still raises FilePinChanged.
_PIN_CACHE_DEFAULT = 32 * 1024 * 1024
_PIN_CACHE_SETTLE_NS = 1_000_000_000
_pin_cache = OrderedDict()  # (path, identity) -> (bytes, sha256 hex)
_pin_cache_bytes = 0
_pin_cache_lock = threading.Lock()
_pin_cache_state = None  # resolved budget, sticky for the life of the process


def pin_cache_budget():
    """Content bytes this process may retain; 0 disables reuse for its whole life.

    Resolution is sticky on purpose: a caller that scrubs os.environ (a fixture, a
    subprocess-like test scope) would otherwise silently re-enable reuse in a
    process that was started with ``SWARM_PIN_CACHE=0``. Only tests reset
    ``_pin_cache_state``.
    """
    global _pin_cache_state
    if _pin_cache_state is None:
        _pin_cache_state = _resolved_budget()
    return _pin_cache_state


def _resolved_budget():
    if str(os.environ.get("SWARM_PIN_CACHE", "1")).strip().lower() in ("0", "off", "false", "no"):
        return 0
    raw = os.environ.get("SWARM_PIN_CACHE_BYTES")
    if raw:
        try:
            return max(0, int(raw))
        except ValueError:
            return _PIN_CACHE_DEFAULT
    return _PIN_CACHE_DEFAULT


def clear_pin_cache():
    """Drop all retained content; tests and long-lived owners may call this."""
    global _pin_cache_bytes
    with _pin_cache_lock:
        _pin_cache.clear()
        _pin_cache_bytes = 0


def _identity(target, info):
    # The path is part of the key on purpose. Timestamps are quantized, so (dev, ino,
    # size, mtime, ctime) alone can repeat: this filesystem recycles a deleted
    # file's inode number, and two files then share the whole identity tuple. The
    # tuple answers "did *this* path change", never "is this some other file".
    return (str(target), info.st_dev, info.st_ino, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns)


def _retained(key):
    with _pin_cache_lock:
        entry = _pin_cache.get(key)
        if entry is not None:
            _pin_cache.move_to_end(key)
        return entry


def _retain(key, entry, opened_at):
    """Retain only a settled identity: stamps already older than the settle window."""
    global _pin_cache_bytes
    budget = pin_cache_budget()
    if not budget or max(key[4], key[5]) > opened_at - _PIN_CACHE_SETTLE_NS:
        return
    if len(entry[0]) > budget:
        return
    with _pin_cache_lock:
        if key in _pin_cache:
            return
        _pin_cache[key] = entry
        _pin_cache_bytes += len(entry[0])
        while _pin_cache and _pin_cache_bytes > budget:
            _, (evicted, _) = _pin_cache.popitem(last=False)
            _pin_cache_bytes -= len(evicted)


def _reusable(target):
    """Cached (bytes, sha256) only while the named inode is unchanged.

    Anything unexpected - a vanished entry, a symlink swap, a non-regular file,
    an unwritten identity - returns None so the strict open/read path below runs
    unchanged and raises its original code. Neither half of the key decides alone:
    the path only ever answers for the inode it resolved to, the inode only for
    the path it is named by.
    """
    try:
        info = os.lstat(target)
    except OSError:
        return None
    if not stat.S_ISREG(info.st_mode):
        return None
    return _retained(_identity(target, info))


@blocking_io.observed("read_bytes", lambda value: str(value))
def _verified(value):
    """The one read seam: verified (bytes, sha256) of a canonical regular file."""
    from observation_budget import check
    check()
    with blocking_io.stage("resolve", str(value)):
        target = path(str(value))
    entry, fd = None, None
    with blocking_io.stage("open", str(value), check_after=False):
        # The stage now names the identity acquisition, not the syscall: a reuse
        # repeats the identity check where a first read performs the open.
        entry = _reusable(target)
        if entry is None:
            fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    if entry is not None:
        blocking_io.check()
    else:
        with os.fdopen(fd, "rb") as stream:
            blocking_io.check()
            opened_at = time.time_ns()
            info = os.fstat(stream.fileno())
            require(stat.S_ISREG(info.st_mode), "not_regular")
            raw = stream.read(info.st_size)
            require(len(raw) == info.st_size, "file_truncated")
        entry = (raw, digest(raw))
        _retain(_identity(target, info), entry, opened_at)
    check()
    return entry


def read_bytes(value):
    """Contents only; the digest is retained so file_ref/pinned need not rehash."""
    return _verified(value)[0]


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
    raw, sha256 = _verified(ref["path"])
    if (digest(canonical(parse(raw))) if json_pin else sha256) != ref["sha256"]:
        raise FilePinChanged()
    return raw


def file_ref(target):
    return {"path": str(target), "sha256": _verified(target)[1]}


def timestamp(value):
    value = datetime.fromisoformat(value)
    require(value.utcoffset() is not None, "timestamp_without_timezone")
    return value


def now():
    return datetime.now(timezone.utc).isoformat()


@blocking_io.observed("fsync_dir", lambda directory: str(directory))
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


@blocking_io.observed("publish_new", lambda target, value: str(target))
def publish_new(target, value):
    """Atomically expose one immutable receipt; never replace another claimant's file."""
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
    with blocking_io.stage("lock_directory", str(root)):
        root = path(str(root), directory=True)
    with blocking_io.stage("lock_directory_stat", str(root)):
        info = root.stat()
    require(info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700,
            "private_state_directory_required")
    target = root / (name + ".lock")
    root_identity = (info.st_dev, info.st_ino)
    # Resource cleanup encloses the post-open deadline check as well.
    fd = None
    try:
        with blocking_io.stage("lock_open", str(target)):
            fd = os.open(target, (os.O_CREAT if create else 0) | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        with blocking_io.stage("lock_fstat", str(target)):
            info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
                and stat.S_IMODE(info.st_mode) == 0o600, "invalid_lock_file")
        try:
            with blocking_io.stage("flock", str(target)):
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            if exc.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                raise LockBusy(exc.errno, "bound_lock_busy") from exc
            raise
        def unchanged():
            if create:
                return
            with blocking_io.stage("lock_recheck_fstat", str(target)):
                current = os.fstat(fd)
            with blocking_io.stage("lock_recheck_lstat", str(target)):
                named = target.lstat()
            with blocking_io.stage("lock_recheck_directory_stat", str(root)):
                parent = root.stat()
            with blocking_io.stage("lock_recheck_resolve", str(root)):
                resolved = root.resolve(strict=True)
            require(current.st_nlink == named.st_nlink == 1
                    and (current.st_dev, current.st_ino) == (named.st_dev, named.st_ino)
                    == (info.st_dev, info.st_ino)
                    and current.st_uid == named.st_uid == os.getuid()
                    and stat.S_ISREG(named.st_mode)
                    and stat.S_IMODE(current.st_mode) == stat.S_IMODE(named.st_mode) == 0o600
                    and (parent.st_dev, parent.st_ino) == root_identity
                    and parent.st_uid == os.getuid() and stat.S_IMODE(parent.st_mode) == 0o700
                    and resolved == root, "existing_lock_changed")
        unchanged()
        # Long-lived cooperative owners may also recheck before each admission.
        # This detects inode/path drift; it is not authentication or protection
        # against a malicious same-UID process replacing the lock concurrently.
        yield unchanged
        unchanged()
    finally:
        if fd is not None:
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
