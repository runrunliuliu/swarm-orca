"""Offline Swarm guard utilities. No Orca calls, model launches or remote writes."""

import argparse
import json
import sys

from .config import SafetyError
from .launch_guard import preflight, startup_diagnosis
from .receipts import check, derive, read


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    commands = p.add_subparsers(dest="command", required=True)
    commands.add_parser("preflight").add_argument("--config", required=True)
    d = commands.add_parser("diagnose")
    d.add_argument("--receipt", required=True)
    d.add_argument("--evidence")
    d = commands.add_parser("derive-receipts")
    d.add_argument("--source", required=True)
    d.add_argument("--destination", required=True)
    d = commands.add_parser("check-receipts")
    d.add_argument("--directory", required=True)
    d.add_argument("--sealed", action="store_true")
    args = p.parse_args(argv)
    try:
        if args.command == "preflight":
            result = preflight(json.loads(read(args.config)))
        elif args.command == "diagnose":
            result = startup_diagnosis(json.loads(read(args.receipt)),
                                       json.loads(read(args.evidence)) if args.evidence else None)
        elif args.command == "derive-receipts":
            result = derive(args.source, args.destination)
        else:
            result = check(args.directory, sealed=args.sealed)
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 0
    except SafetyError as error:
        print(json.dumps({"ok": False, "error": str(error)}), file=sys.stderr)
    except (OSError, ValueError, KeyError, TypeError, RecursionError):
        print(json.dumps({"ok": False, "error": "invalid_or_unreadable_evidence"}), file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
