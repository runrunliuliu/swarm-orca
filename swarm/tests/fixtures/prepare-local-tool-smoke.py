"""Emit an OFFLINE native fixture for testing the actual file-tool executor.

Only use a fresh empty test directory; this is not real Orca session evidence.
Leaves fixtures and tool evidence in that exact directory for inspection.
"""

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
from unittest import mock

BASE = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(BASE), str(BASE / "tests")]
import test_coordinator_prepare as prepare_tests

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--output-root", type=Path, required=True)
args = parser.parse_args()
root = args.output_root.resolve(strict=True)
if not root.is_dir() or list(root.iterdir()):
    parser.error("output-root must be a fresh empty test directory")
temp = mock.Mock(name=str(root))
temp.name = str(root)
now = datetime.now(timezone.utc)
with mock.patch.object(prepare_tests.native_tests.tempfile, "TemporaryDirectory", return_value=temp), \
        mock.patch.object(prepare_tests.native_tests, "NOW", now):
    fixture = prepare_tests.CoordinatorPrepareTests()
    fixture.setUp()
    bundle = fixture.prepare()
    bundle["plan"]["session"]["validation_kind"] = "offline-native-fixture-real-file-tools"
    print(json.dumps(bundle))
