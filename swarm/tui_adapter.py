"""Reviewed TUI adapter names, their observation readers and policy inputs.

The strict startup contract pins one adapter string. Everything else in the gate
(turn context, session meta, the transcript verification) differs per provider,
so this is the single place that maps a pinned adapter to the reader that can
verify it and to the reviewed input that reader pins. An adapter this build does
not have is refused; nothing falls back to another provider's reader.

Imports are lazy: readers pull native/ledger modules, and both gates import this
registry while resolving a contract.
"""

TRAE_ADAPTER = "trae-tui-runtime-v1"
PI_ADAPTER = "pi-tui-runtime-v1"
TUI_ADAPTERS = (TRAE_ADAPTER, PI_ADAPTER)

# Legacy exec/stream adapter, accepted by the startup contract but not a TUI reader.
EXEC_ADAPTER = "trae-exec-stream-v1"


class AdapterRefused(ValueError):
    def __init__(self, code):
        super().__init__(code)


def is_tui(adapter):
    return adapter in TUI_ADAPTERS


def policy_key(adapter):
    """The keyword that carries the reviewed provider input into the reader."""
    return {TRAE_ADAPTER: "trae_runtime_config", PI_ADAPTER: "pi_policy"}.get(adapter)


def provider(adapter):
    """Which provider name a TUI pane carries (`agentIdentity`) for this adapter."""
    return {TRAE_ADAPTER: "trae", PI_ADAPTER: "pi"}.get(adapter)


def kind_adapter(kind):
    """Map an observation kind back to the adapter that may have produced it."""
    if kind in ("trae_tui_startup_anchor", "trae_tui_session_observation"):
        return TRAE_ADAPTER
    if kind in ("pi_tui_startup_anchor", "pi_tui_session_observation"):
        return PI_ADAPTER
    return None


def reader(adapter):
    """Return (observe, policy keyword) for a pinned TUI adapter."""
    if adapter == TRAE_ADAPTER:
        from trae_tui import observe
        return observe, "trae_runtime_config"
    if adapter == PI_ADAPTER:
        from pi_tui import observe
        return observe, "pi_policy"
    raise AdapterRefused("tui_adapter_unsupported")


def policy(adapter, source):
    """Validate the reviewed provider input the reader will pin.

    Trae takes an execution-config path (the contract pins its Ref separately);
    Pi takes the pinned Ref itself, because that policy is the expectation its
    transcript is compared against.
    """
    if adapter == TRAE_ADAPTER:
        from trae_coordinator import TUI_EXECUTION, read_trae_execution
        path = source["path"] if isinstance(source, dict) else source
        if read_trae_execution(path) != TUI_EXECUTION:
            raise AdapterRefused("tui_runtime_config_required")
        return None
    if adapter == PI_ADAPTER:
        from pi_policy import read_ref
        return read_ref(source)
    raise AdapterRefused("tui_adapter_unsupported")


def input_value(adapter, runtime_config):
    """The value a caller hands the reader: a pinned Ref for Pi, a path for Trae."""
    if adapter == PI_ADAPTER:
        return runtime_config
    return runtime_config["path"] if isinstance(runtime_config, dict) else runtime_config
