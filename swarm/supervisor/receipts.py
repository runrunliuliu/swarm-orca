"""Preview-only redaction of derived JSON receipts; never rewrite a sealed run.

This is NOT a credential scanner or permission to publish the remaining data.
The final inventory check detects later additions as well as changed bytes.
"""

import hashlib
import json
import os
from pathlib import Path
import stat

from .config import require

MARKER = "[omitted: terminal preview]"
MANIFEST = "receipt-preview-manifest.json"


def is_preview(key):
    return key.lower().replace("_", "").replace("-", "") in ("preview", "previewtext", "terminalpreview")


def scrub(value):
    if isinstance(value, dict):
        return {k: MARKER if is_preview(k) else scrub(v) for k, v in value.items()}
    if isinstance(value, list):
        return [scrub(v) for v in value]
    if isinstance(value, str) and value.lstrip().startswith(("{", "[")):
        try:
            nested = json.loads(value)
        except ValueError:
            return value  # Arbitrary prose is not a structured preview field.
        if isinstance(nested, (dict, list)):
            clean = scrub(nested)
            return json.dumps(clean, ensure_ascii=False, sort_keys=True) if clean != nested else value
    return value


def sha(content):
    return hashlib.sha256(content).hexdigest()


def read(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as handle:
        before = os.fstat(handle.fileno())
        require(stat.S_ISREG(before.st_mode), "receipt_not_regular")
        content = handle.read(before.st_size)
        after = os.fstat(handle.fileno())
    require(len(content) == before.st_size == after.st_size and before.st_mtime_ns == after.st_mtime_ns
            and before.st_ctime_ns == after.st_ctime_ns, "receipt_changed_during_read")
    return content


def inventory(directory):
    root = Path(directory)
    require(root.is_absolute() and root == root.resolve() and root.is_dir(), "receipt_directory_must_be_resolved")
    paths = []
    for parent, dirs, files in os.walk(root, followlinks=False):
        for name in dirs + files:
            path = Path(parent) / name
            require(not path.is_symlink(), "receipt_symlink_refused")
            if name in files:
                require(path.is_file(), "receipt_inventory_requires_regular_files")
                if path != root / MANIFEST:
                    paths.append(path.relative_to(root).as_posix())
    return root, sorted(paths)


def check(directory, *, sealed=False):
    root, paths = inventory(directory)
    hashes, unsafe = {}, []
    for relative in paths:
        require(Path(relative).suffix == ".json", "derived_receipt_inventory_requires_json_only")
        content = read(root / relative)
        value = json.loads(content)
        hashes[relative] = sha(content)
        if scrub(value) != value:
            unsafe.append(relative)  # paths only, never preview content
    require(not unsafe, "unsanitized_preview_files:" + ",".join(unsafe))
    if sealed:
        manifest = json.loads(read(root / MANIFEST))
        require(manifest.get("schema_version") == 1 and manifest.get("scope") == "terminal_preview_only",
                "invalid_receipt_manifest")
        rows = manifest.get("files")
        require(isinstance(rows, list) and all(isinstance(row, dict) for row in rows), "invalid_receipt_manifest")
        expected = {row["path"]: row["sanitized_sha256"] for row in rows}
        require(len(expected) == len(rows) and expected == hashes, "receipt_final_inventory_or_hash_changed")
    return {"preview_check_passed": True, "file_count": len(paths), "sealed": sealed,
            "scope": "terminal_preview_only", "public_release_approved": False}


def derive(source, destination):
    root, paths = inventory(source)
    dest = Path(destination)
    require(dest.is_absolute() and dest == dest.resolve() and root != dest
            and root not in dest.parents and dest not in root.parents, "receipt_destination_must_be_separate")
    require(not dest.exists() and not dest.is_symlink(), "receipt_destination_exists")
    require(not (root / MANIFEST).exists(), "derive_from_original_receipts_not_a_prior_derivative")
    dest.mkdir(mode=0o700)  # exclusive: existing output is never overwritten
    rows, excluded = [], []
    for relative in paths:
        content = read(root / relative)
        if Path(relative).suffix != ".json":
            excluded.append({"path": relative, "original_sha256": sha(content), "reason": "not_json_not_copied"})
            continue
        value = json.loads(content)
        clean = (json.dumps(scrub(value), ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode()
        target = dest / relative
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with target.open("xb") as output:
            os.chmod(target, 0o600)
            output.write(clean)
        rows.append({"path": relative, "original_sha256": sha(content), "sanitized_sha256": sha(clean),
                     "preview_redacted": scrub(value) != value})
    # Late operator/accounting receipts invalidate this snapshot; never seal stale inventory.
    require(inventory(root)[1] == paths and all(sha(read(root / r["path"])) == r["original_sha256"] for r in rows + excluded),
            "receipt_source_changed_before_seal")
    check(dest)
    manifest = {"schema_version": 1, "scope": "terminal_preview_only", "source_directory": str(root),
                "files": rows, "excluded": excluded}
    with (dest / MANIFEST).open("x", encoding="utf-8") as output:
        os.chmod(dest / MANIFEST, 0o600)
        json.dump(manifest, output, ensure_ascii=False, sort_keys=True, indent=2)
        output.write("\n")
    return check(dest, sealed=True)
