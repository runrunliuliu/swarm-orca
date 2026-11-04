"""Conservative time bounds for the native Run timestamp's reported precision."""

from datetime import timedelta
import re

from coordinator_io import require, timestamp


def next_creation_second(completed_at):
    completed = timestamp(completed_at)
    return completed.replace(microsecond=0) + timedelta(seconds=bool(completed.microsecond))


def creation_bounds(created_at):
    # A truncated native timestamp names a bucket, not an exact commit instant.
    match = re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.(\d{1,6}))?(?:Z|[+-]\d{2}:\d{2})",
        created_at)
    require(match is not None, "unsupported_run_timestamp_precision")
    digits = len(match[1] or "")
    start = timestamp(created_at)
    return start, start + timedelta(microseconds=10 ** (6 - digits))
