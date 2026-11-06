"""Run from swarm/: python3 -B -m release_radar --config /private/config.json …"""

import argparse
import json
import subprocess
import sys

from .core import Radar, load_config
from .storage import read_json


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    sub = parser.add_subparsers(dest="stage", required=True)
    sub.add_parser("status", help="Inspect durable batch/queue state (no network)")
    sub.add_parser("collect", help="Fetch Runner; baseline older releases and queue changes")
    analyze = sub.add_parser("analyze", help="Prepare/resume a bundle, or accept an Agent result")
    choice = analyze.add_mutually_exclusive_group()
    choice.add_argument("--result", help="Private JSON result file; does not invoke a model")
    choice.add_argument("--cancel", metavar="BATCH_ID", help="Cancel stale analysis; keep releases queued")
    choice.add_argument("--refresh", metavar="BATCH_ID", help="Withdraw unpublished drafts and requeue an accepted batch")
    publish = sub.add_parser("publish", help="Preview by default; --execute requires config opt-in")
    publish.add_argument("--batch", required=True)
    publish.add_argument("--execute", action="store_true")
    args = parser.parse_args(argv)
    try:
        radar = Radar(load_config(args.config))
        if args.stage == "status":
            result = radar.status()
        elif args.stage == "collect":
            result = radar.collect()
        elif args.stage == "analyze":
            result = radar.analyze(read_json(args.result) if args.result else None, args.cancel, args.refresh)
        else:
            result = radar.publish(args.batch, execute=args.execute)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (ValueError, OSError, subprocess.SubprocessError, KeyError, TypeError) as exc:
        # Avoid echoing gh argv/input or untrusted page contents (possibly sensitive).
        print(json.dumps({"error": type(exc).__name__, "detail": str(exc) if isinstance(exc, ValueError)
                          else "operation_failed_state_retained; inspect local environment"}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
