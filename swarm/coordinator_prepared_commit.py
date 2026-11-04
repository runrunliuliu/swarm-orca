"""Explicit marker-commit protocol for new strict-start requests, including NFS.

Directory visibility is NOT readiness. Only the final, exclusive, complete marker
and verified members constitute a committed bundle. No overwrite, retry or cleanup.
"""

from pathlib import Path
import tempfile

from coordinator_io import (file_ref, fsync_dir, parse, path, pinned, publish_new,
                            validate_ref)
from coordinator_strict import require


COMMIT_NAME = "prepared-commit.json"


def commit_value(request_ref, members):
    return dict(schema_version=1, kind="strict_start_prepared_commit",
                request=request_ref, files=members)


def validate_members(directory, members):
    require(isinstance(members, list) and members, "strict_prepare_commit_members_invalid")
    names = []
    for ref in members:
        validate_ref(ref)
        target = Path(ref["path"])
        require(target.parent == directory and str(target) == ref["path"]
                and target.name != COMMIT_NAME, "strict_prepare_commit_member_path_invalid")
        names.append(target.name)
    require(len(names) == len(set(names)), "strict_prepare_commit_duplicate_member")


def verify_commit(directory, request_ref, members):
    validate_members(directory, members)
    ref = file_ref(directory / COMMIT_NAME)
    value = parse(pinned(ref))
    require(isinstance(value, dict) and type(value.get("schema_version")) is int
            and value == commit_value(request_ref, members), "strict_prepare_commit_mismatch")
    for member in members:
        pinned(member)
    pinned(ref)
    return ref


def publish_bundle_new(staging, directory, request_ref, members, *, before_commit, progress):
    """Reuse exclusive file publication; a crash leaves uncommitted evidence.

    before_commit rechecks source pins, identity context and deadline after member
    publication. A post-link fsync failure is an unknown outcome, never a retry.
    """
    staging = path(str(staging), directory=True)
    require(staging.parent == directory.parent, "directory_commit_same_parent_required")
    validate_members(directory, members)
    for member in members:
        pinned(dict(member, path=str(staging / Path(member["path"]).name)))
    progress["stage"] = "claim_directory"
    directory.mkdir(mode=0o700)  # EEXIST includes an empty directory or symlink.
    fsync_dir(directory.parent)
    for member in members:
        progress["stage"] = "publish_member"
        progress["member"] = member["path"]
        publish_new(Path(member["path"]), pinned(dict(
            member, path=str(staging / Path(member["path"]).name))))
    progress.pop("member", None)
    progress["stage"] = "validate_before_commit"
    before_commit()
    for member in members:
        pinned(member)
    fsync_dir(directory)
    progress["stage"] = "publish_commit"
    publish_new(directory / COMMIT_NAME, commit_value(request_ref, members))
    progress["stage"] = "verify_commit"
    return verify_commit(directory, request_ref, members)


def probe_storage(parent, progress):
    """Retained same-parent capability probe, before preparing the real bundle.

    Only tests mkdir + exclusive hardlink file publication + fsync/readback. It is
    not an atomicity proof, authorization, or a guarantee of future storage health.
    """
    progress["stage"] = "storage_probe"
    root = Path(tempfile.mkdtemp(prefix=".strict-start-storage-probe-", dir=parent))
    progress["storage_probe"] = str(root)
    fsync_dir(parent)
    target = root / "exclusive.json"
    publish_new(target, {"schema_version": 1, "kind": "strict_start_storage_probe"})
    original = file_ref(target)
    try:
        publish_new(target, b"must not replace")
    except FileExistsError:
        pass
    else:
        raise ValueError("strict_prepare_storage_probe_not_exclusive")
    pinned(original)
    publish_new(root / "verified.json", {"probe": original, "exclusive": True})
    return file_ref(root / "verified.json")
