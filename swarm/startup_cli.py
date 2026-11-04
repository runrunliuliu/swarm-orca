"""Contract-owned CLI selection; scoped calls never export process environment.

Callers load/validate the full startup contract through their existing pin chain.
Only the native boundary resolves its executable, so injected offline transports
remain offline. Historical configurations without a contract keep explicit env.
"""

from contextlib import contextmanager
from contextvars import ContextVar
from functools import wraps
import os

from coordinator_io import parse, pinned, require


CLI_ENV = "ORCA_SERVER_CLI"
_binding = ContextVar("startup_cli_binding", default=None)


@contextmanager
def scope(contract):
    if contract is None:
        yield
        return
    binding = (dict(contract["cli"]), contract["runtime"])
    require(_binding.get() in (None, binding), "startup_cli_binding_conflict")
    token = _binding.set(binding)
    try:
        yield
    finally:
        _binding.reset(token)


def bind(call, contract):
    """Also works around routed/injected callbacks, without mutating their defaults."""
    @wraps(call)
    def bound(*args, **kwargs):
        with scope(contract):
            return call(*args, **kwargs)
    return bound


def resolve(runtime, *, legacy=None):
    binding = _binding.get()
    if binding is None:
        cli = os.environ.get(CLI_ENV) or legacy
        require(cli, "orca_server_cli_required")
        return cli
    ref, expected_runtime = binding
    from operator_continuity_route import runtime as routed_runtime
    require(routed_runtime(runtime) == routed_runtime(expected_runtime), "startup_cli_runtime_mismatch")
    # Absence is fine; even an explicitly empty conflicting override is rejected.
    require(CLI_ENV not in os.environ or os.environ[CLI_ENV] == ref["path"],
            "startup_cli_environment_conflict")
    pinned(ref)
    require(os.access(ref["path"], os.X_OK), "startup_cli_not_executable")
    return ref["path"]


def check_explicit(cli, runtime):
    """Explicit transports inside a contract scope must use that same pin."""
    if _binding.get() is not None:
        require(cli == resolve(runtime), "startup_cli_path_mismatch")


def driver_contract(driver):
    """Schema 5 is historical; new schema 6 pins the run-phase startup contract."""
    version = driver.get("schema_version")
    require(type(version) is int and version in (5, 6), "unsupported_driver_schema")
    if version == 5:
        require("startup_contract" not in driver, "invalid_driver_config")
        return None
    from coordinator_startup import validate
    contract = parse(pinned(driver["startup_contract"]))
    validate(contract)
    b = driver["binding"]
    require(isinstance(b, dict) and type(b.get("generation")) is int
            and contract["adapter"] == "trae-exec-stream-v1"
            and b == dict(runtime=contract["runtime"], run=(contract["run"] or {}).get("id"),
                generation=(contract["run"] or {}).get("generation"), workspace=contract["workspace"]["id"],
                terminal=contract["coordinator"]["terminal"], incarnation=contract["coordinator"]["incarnation"],
                session=contract["coordinator"]["session"]), "driver_startup_binding_mismatch")
    plan = parse(pinned(driver["previous_plan"]))
    require(plan["cwd"] == contract["workspace"]["path"], "driver_startup_workspace_mismatch")
    return contract


def watch_contract(config):
    driver = parse(pinned(config["driver_binding"]))
    mapping = dict(runtime="runtime", run="run", generation="expected_generation",
                   terminal="terminal", incarnation="incarnation", workspace="workspace")
    require(all(driver["binding"][k] == config[v] for k, v in mapping.items()), "driver_identity_mismatch")
    return driver_contract(driver)
