"""Read-only adapter; explicit runtime/environment, no model or lifecycle calls."""

import json
import os
import subprocess

from supervisor.config import SafetyError, require
from supervisor.orca import Orca, result


class Reader:
    workers = Orca.workers

    def __init__(self, cli, runtime_id, environment=None, *, runner=subprocess.run, env=None):
        self.cli, self.runtime_id, self.environment = cli, runtime_id, environment
        self.runner = runner
        self.env = dict(os.environ if env is None else env)
        require(not any(self.env.get(k) for k in ("ORCA_ENVIRONMENT", "ORCA_PAIRING_CODE", "ORCA_DEV_REPO_ROOT")),
                "routing overrides present; use an explicit verified CLI/environment")

    def read(self, *argv):
        require(argv == ("status",) or argv[:2] in (
            ("orchestration", "run-show"), ("orchestration", "worker-list"),
            ("orchestration", "worker-show"), ("terminal", "show")), "accounting permits read-only commands only")
        command = [self.cli, *argv]
        if self.environment:
            command += ["--environment", self.environment]
        try:
            process = self.runner([*command, "--json"], capture_output=True, text=True, timeout=55, env=self.env)
        except (OSError, subprocess.TimeoutExpired) as error:
            raise SafetyError("accounting_native_transport_unavailable") from error
        require(process.returncode == 0, "accounting_native_read_failed")
        receipt = json.loads(process.stdout)
        data = result(receipt)
        require(receipt.get("_meta", {}).get("runtimeId") == self.runtime_id, "accounting runtime mismatch")
        if argv[:2] == ("orchestration", "worker-list") and data.get("scope") is not None:
            require(isinstance(data["scope"], dict) and data["scope"].get("run") == argv[argv.index("--run") + 1],
                    "accounting fleet scope mismatch")
        return data

    def verify_runtime(self):
        runtime = self.read("status")["runtime"]
        require(runtime.get("state") == "ready" and runtime.get("reachable") is True,
                "accounting runtime not ready")
        require(runtime.get("runtimeId") == self.runtime_id and runtime.get("appVersion") == "1.4.219",
                "accounting runtime/version mismatch")
        return runtime

    def collect(self, run_id):
        self.verify_runtime()
        run = self.read("orchestration", "run-show", "--id", run_id)["run"]
        require(run.get("id") == run_id, "accounting Run mismatch")
        fleet = self.workers(run_id)
        receipts = []
        for row in fleet:
            receipt = self.read("orchestration", "worker-show", "--dispatch", row["dispatchId"])
            require(receipt.get("dispatch", {}).get("id") == row["dispatchId"], "accounting Dispatch mismatch")
            receipts.append(receipt)
        return run, receipts
