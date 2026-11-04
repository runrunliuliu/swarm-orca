"""Selective, private historical evidence snapshots; never lifecycle settlement.

Callers must review an explicit file list and non-preview sensitive content.
No recursive source copy, reference following, credential-scanner claim, or
permission to publish. A mismatched historical pin is a gap, not a new pin.
"""

from pathlib import Path
import re

from coordinator_io import canonical, digest, now, parse, path, publish_new, require
from supervisor.receipts import inventory, read, scrub


def relative(value):
    require(isinstance(value, str) and value and not Path(value).is_absolute()
            and all(part not in (".", "..", "") for part in value.split("/")),
            "archive_relative_path_required")
    return value


def verify(directory):
    root, names = inventory(directory)
    # receipts.inventory reserves this name for its own format, not ours.
    require(not (root / "receipt-preview-manifest.json").exists(), "archive_inventory_changed")
    manifest = parse(read(root / "manifest.json"))
    require(manifest.get("kind") == "selective_historical_evidence_archive"
            and manifest.get("schema_version") == 1, "archive_manifest_invalid")
    rows = manifest["files"]
    expected = {relative(row["path"]): row["sha256"] for row in rows}
    require(len(expected) == len(rows) and "manifest.json" not in expected
            and sorted(names) == sorted([*expected, "manifest.json"]), "archive_inventory_changed")
    for name, sha256 in expected.items():
        require(digest(read(root / name)) == sha256, "archive_readback_changed")
    return dict(ok=True, file_count=len(rows), manifest_sha256=digest(read(root / "manifest.json")),
                gap_count=len(manifest["gaps"]), scope="mounted_filesystem_readback_only",
                lifecycle_settled=False, public_release_approved=False)


def archive(source, destination, selections, summary):
    """Selections: {path, target, format: json|text, sha256: historical pin|null}.

    Optional omit_json_paths lists reviewed dictionary field paths to omit from
    JSON derivatives (e.g. runtime startOptions); recorded alongside both hashes.
    Null pins explicitly mean current file observations, not historical proof.
    Missing/mismatched files are recorded but not copied. All readable sources
    are rechecked before sealing; on failure retain an unsealed private directory.
    """
    root = path(str(source), directory=True)
    dest = Path(destination)
    require(dest.is_absolute() and dest == dest.resolve() and dest != root
            and dest not in root.parents, "archive_destination_invalid")
    path(str(dest.parent), directory=True)
    require(not dest.exists() and not dest.is_symlink(), "archive_destination_exists")
    require(isinstance(selections, list) and selections, "archive_selection_required")
    targets, sources, payloads, rows, gaps, observations = set(), set(), [], [], [], []
    for item in selections:
        name, target = relative(item["path"]), relative(item["target"])
        require(target not in targets and name not in sources and target not in
                ("manifest.json", "report.json", "report.md", "receipt-preview-manifest.json"), "archive_duplicate_or_reserved_path")
        require(item["format"] in ("json", "text"), "archive_format_invalid")
        omissions = item.get("omit_json_paths", [])
        require(isinstance(omissions, list) and (not omissions or item["format"] == "json"),
                "archive_omissions_invalid")
        pin = item["sha256"]
        require(pin is None or isinstance(pin, str) and re.fullmatch(r"[a-f0-9]{64}", pin), "archive_pin_invalid")
        targets.add(target)
        sources.add(name)
        origin = root / name
        require(origin.resolve() == origin and dest != origin and dest not in origin.parents,
                "archive_source_symlink_or_destination")
        try:
            content = read(origin)
        except FileNotFoundError:
            observations.append((origin, None))
            gaps.append(dict(source=name, expected_sha256=pin, reason="source_missing"))
            continue
        actual = digest(content)
        observations.append((origin, actual))
        if pin is not None and pin != actual:
            gaps.append(dict(source=name, expected_sha256=pin, observed_sha256=actual,
                             reason="historical_pin_mismatch_not_copied"))
            continue
        value = parse(content) if item["format"] == "json" else None
        clean = scrub(value) if item["format"] == "json" else None
        preview_redacted = clean != value
        for keys in omissions:
            require(isinstance(keys, list) and keys and all(isinstance(key, str) for key in keys),
                    "archive_omissions_invalid")
            parent = clean
            for key in keys[:-1]:
                require(isinstance(parent, dict) and key in parent, "archive_omission_path_missing")
                parent = parent[key]
            require(isinstance(parent, dict) and keys[-1] in parent, "archive_omission_path_missing")
            del parent[keys[-1]]
        output = canonical(clean) + b"\n" if clean != value else content
        payloads.append((target, output))
        rows.append(dict(path=target, sha256=digest(output), source=name, source_sha256=actual,
                         historical_pin_verified=pin is not None, preview_redacted=preview_redacted,
                         omitted_json_paths=omissions))
    report = canonical(scrub(summary)) + b"\n"
    payloads.append(("report.json", report))
    rows.append(dict(path="report.json", sha256=digest(report), generated=True))
    report_md = ("# Historical evidence snapshot\n\n"
                 "See [decision, interventions and accounting gaps](report.json) and "
                 "[source mapping, hashes and missing evidence](manifest.json).\n\n"
                 "This selective archive does not settle the live Run, certify idle wakeup, "
                 "or recover unknown usage. Original files are unchanged. Historical pin "
                 "mismatches are gaps, not refreshed evidence. Preview redaction is not "
                 "credential scanning or approval for public release. Verification covers "
                 "mounted-filesystem reread only, not backend ACL or durability.\n").encode()
    payloads.append(("report.md", report_md))
    rows.append(dict(path="report.md", sha256=digest(report_md), generated=True))
    # Validate target file/directory collisions before the first write.
    names = {name for name, _ in payloads} | {"manifest.json", "receipt-preview-manifest.json"}
    require(all(not any(parent.as_posix() in names for parent in Path(name).parents)
                for name in names), "archive_target_collision")
    dest.mkdir(mode=0o700)
    for name, output in payloads:
        target = dest / name
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        publish_new(target, output)
    for origin, expected in observations:
        if expected is None:
            require(not origin.exists() and not origin.is_symlink(), "archive_source_changed_before_seal")
        else:
            require(origin.resolve() == origin and digest(read(origin)) == expected,
                    "archive_source_changed_before_seal")
    manifest = dict(schema_version=1, kind="selective_historical_evidence_archive", created_at=now(),
                    source_root=str(root), files=rows, gaps=gaps,
                    selection_complete=False, public_release_approved=False,
                    exclusions="Unselected files, runtime DB, locks, active logs, model configs and credentials; references are not recursively followed.")
    publish_new(dest / "manifest.json", manifest)
    return verify(dest)
