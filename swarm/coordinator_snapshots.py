"""Shared byte-exact, deduplicated evidence snapshots; no policy or authorization."""

from coordinator_io import file_ref, pinned, publish_new, require, validate_ref


def collect(refs):
    """Read all reviewed pins before a caller claims its output attempt."""
    snapshots = {}
    for ref in refs:
        validate_ref(ref)
        key = (ref["path"], ref["sha256"])
        if key not in snapshots:
            snapshots[key] = (ref, pinned(ref))
    return snapshots


def publish(directory, snapshots, *, prefix, publisher=publish_new):
    # Prefix is chosen by the adapter, never a source filename or relative path.
    require(prefix in ("readiness", "source"), "invalid_snapshot_prefix")
    mappings, frozen = [], {}
    for index, (key, (ref, raw)) in enumerate(snapshots.items()):
        target = directory / f"{prefix}-{index:03d}.snapshot"
        publisher(target, raw)
        snapshot = file_ref(target)
        require(snapshot["sha256"] == ref["sha256"], "snapshot_hash_mismatch")
        frozen[key] = snapshot
        mappings.append({"source": ref, "snapshot": snapshot})
    return mappings, frozen


def recheck(snapshots):
    """Do not refresh pins when a producer changes a previously reviewed input."""
    for ref, _ in snapshots.values():
        pinned(ref)
