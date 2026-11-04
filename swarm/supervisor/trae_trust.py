"""Opt-in, exact-project trust. No hook approvals or global/parent trust."""

import copy
import fcntl
import json
import os
from pathlib import Path
import pwd
import socket
import stat
import sys
import tempfile

from .config import SafetyError, require

try:
    import tomllib
except ImportError:  # Other agents continue to support Python 3.10.
    tomllib = None


def canonical_directory(value):
    require(isinstance(value, str) and not any(ord(c) < 32 or c in "*?" for c in value),
            "trust directory must be an explicit path")
    path = Path(value)
    require(path.is_absolute() and str(path) == value and path.is_dir()
            and path.resolve() == path, "trust directory must exist and be canonical, without symlinks")
    info = path.stat()
    require(info.st_uid == os.geteuid() and not info.st_mode & 0o022,
            "trust directory must be owned by the worker account and not writable by others")
    return path


def context(policy, env):
    require(policy.get("enabled") is True and policy.get("launch_context_confirmed") is True,
            "Trae launch account, config location and exclusive config writer must be confirmed")
    require(tomllib is not None, "Trae automatic trust requires Python 3.11+")
    require(sys.platform == "linux" and socket.gethostname() == policy["hostname"],
            "Trae trust must run on the approved Linux host")
    user = pwd.getpwuid(os.geteuid())
    require(os.getuid() == os.geteuid() and user.pw_name == policy["username"],
            "Trae trust must run as the approved worker account")
    home = Path(user.pw_dir).resolve()
    require(env.get("HOME") == str(home), "Trae HOME differs from the worker account home")
    directory = canonical_directory(policy["trae_home"])
    effective = env.get("TRAE_HOME") or str(home / ".trae")
    require(effective == str(directory), "TRAE_HOME differs from the approved launcher configuration")
    require(directory != home and directory not in home.parents and len(directory.parts) >= 3,
            "Trae configuration needs a dedicated directory")
    return directory, home


def snapshot(path):
    """Read owner-private regular files, without following links."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return b"", None
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1
                and info.st_uid == os.geteuid() and not info.st_mode & 0o077,
                "Trae config must be an owner-private regular file (0600), not linked")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            data = stream.read(info.st_size)
        require(len(data) == info.st_size, "Trae config truncated during read")
        return data, (info.st_dev, info.st_ino, info.st_mtime_ns, info.st_ctime_ns, info.st_size)
    finally:
        os.close(fd)


def parse(data):
    try:
        return tomllib.loads(data.decode("utf-8"))
    except (ValueError, UnicodeError) as error:
        raise SafetyError("Trae config is not valid TOML; no trust written") from error


def check_context(policy, env):
    directory, _ = context(policy, env)
    parse(snapshot(directory / "traecli.toml")[0])


def register(policy, workspace, env):
    """Caller must verify native identity and clean Git root immediately beforehand.

    Serializes Swarm writers across goals. Trae/editors do not take our lock: the
    operator must confirm no other config writer during preparation. Snapshot
    comparison additionally rejects observed external edits before atomic replace.
    """
    directory, home = context(policy, env)
    path = canonical_directory(str(workspace))
    require(len(path.parts) >= 4 and path != home and path not in home.parents
            and path != directory and path not in directory.parents,
            "refusing broad home, ancestor or configuration-directory trust")
    target = directory / "traecli.toml"
    fd = os.open(directory / ".swarm-trust.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1
                and info.st_uid == os.geteuid() and not info.st_mode & 0o077,
                "unsafe Trae trust lock")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise SafetyError("another Swarm owns Trae trust lock; no launch") from error
        original, stamp = snapshot(target)
        before = parse(original)
        projects = before.get("projects", {})
        require(isinstance(projects, dict), "Trae projects is not a table")
        existing = projects.get(str(path))
        if existing is not None:
            require(isinstance(existing, dict) and existing.get("trust_level") == "trusted",
                    "existing project trust is not trusted; operator review required")
            return {"workspace": str(path), "changed": False}
        addition = ('\n[projects.' + json.dumps(str(path), ensure_ascii=False)
                    + ']\ntrust_level = "trusted"\n').encode("utf-8")
        updated = original + addition
        # Parsing the candidate also rejects inline-table extension and duplicate
        # keys; exact semantic comparison prevents accidental changes to hooks.
        expected = copy.deepcopy(before)
        expected.setdefault("projects", {})[str(path)] = {"trust_level": "trusted"}
        require(parse(updated) == expected, "Trae config cannot be safely extended")
        temp_fd, temporary = tempfile.mkstemp(prefix=".swarm-trust-", dir=directory)
        try:
            with os.fdopen(temp_fd, "wb") as stream:
                stream.write(updated)
                stream.flush()
                os.fsync(stream.fileno())
            require(snapshot(target) == (original, stamp), "Trae config changed concurrently; no trust written")
            os.replace(temporary, target)
            dir_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
            require(snapshot(target)[0] == updated, "Trae trust readback mismatch; no launch")
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        return {"workspace": str(path), "changed": True}
    finally:
        os.close(fd)
