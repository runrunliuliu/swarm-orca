"""runit finish helper: durable, bounded restart admission; never launches an Agent."""

import argparse
import os
import time

from .config import load
from .store import LockBusy, Store, lock


def restart_after_exit(store, config, exit_code, signal_number):
    """Return an absolute retry deadline, or None to request runit down."""
    if signal_number == 0 and exit_code in (0, 3, 78):
        return None
    store.failure(config["limits"], "supervisor_process_exited")
    if store.get("service:pause") or store.get(config["goal_id"] + ":pause"):
        return None
    return store.get("service:retry_after")


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--exit-code", type=int, required=True)
    parser.add_argument("--signal", type=int, required=True)
    args = parser.parse_args()
    config = load(args.config, live=True)
    store = Store(config["state_dir"])
    try:
        # A Coordinator can legitimately own the state lock across native calls.
        deadline = time.monotonic() + 300
        while True:
            try:
                with lock(store.root, "state.lock"):
                    store.enroll(config)
                    retry_at = restart_after_exit(store, config, args.exit_code, args.signal)
                break
            except LockBusy:
                if time.monotonic() >= deadline:
                    return 78  # Fail closed; do not interfere with the Coordinator.
                time.sleep(1)
        if retry_at is None:
            return 78
        while time.time() < retry_at:
            time.sleep(max(0, min(1, retry_at - time.time())))
        return 0
    finally:
        store.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        print("Swarm restart admission failed; inspect private state.", flush=True)
        raise SystemExit(78)
