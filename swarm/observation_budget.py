"""Scoped read-only I/O budget, independent of protocol and mutation clients.

Cooperative for local file I/O: a blocked filesystem syscall is not cancellable.
No scope means no behavior change. Never use this scope around business mutations.
"""

from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from functools import wraps
import json
import math
import subprocess
import sys
import time


_current = ContextVar("swarm_observation_budget", default=None)
_limit = ContextVar("swarm_observation_limit", default=None)
_stage = ContextVar("swarm_observation_stage", default=())
TURN_END_SECONDS = 60


@dataclass(frozen=True)
class Budget:
    started: float
    deadline: float


class ObservationTimeout(ValueError):
    def __init__(self, reason="deadline"):
        super().__init__("tui_turn_end_observation_timeout")
        budget = _current.get()
        self.details = dict(stage="/".join(_stage.get()), timeout_kind=reason,
                            elapsed_seconds=round(time.monotonic() - budget.started, 3),
                            budget_seconds=round(budget.deadline - budget.started, 3))


def active():
    return _current.get() is not None


def query_name(args):
    """Export only known operation names, never arbitrary user arguments."""
    return {("status",): "runtime_status",
            ("orchestration", "strict-caller-check"): "strict_caller",
            ("orchestration", "run-show"): "run_owner",
            ("orchestration", "check"): "mailbox",
            ("terminal", "show"): "terminal",
            ("worktree", "show"): "worktree"}.get(tuple(args[:2]), "native_query")


def check():
    budget = _current.get()
    if budget is not None and time.monotonic() >= min(budget.deadline, _limit.get() or budget.deadline):
        raise ObservationTimeout()


def timeout(seconds):
    check()
    budget = _current.get()
    if budget is None:
        return seconds
    remaining = min(budget.deadline, _limit.get() or budget.deadline) - time.monotonic()
    if remaining <= 0:
        raise ObservationTimeout()
    return min(seconds, remaining)


def _emit(event):
    budget = _current.get()
    tick = time.monotonic()
    row = dict(event="observation_stage", phase=event, stage="/".join(_stage.get()),
               elapsed_seconds=round(tick - budget.started, 3),
               remaining_seconds=round(max(0, budget.deadline - tick), 3))
    # Diagnostics are not receipts; never print argv, paths, raw replies or errors.
    try:
        print(json.dumps(row, sort_keys=True), file=sys.stderr, flush=True)
    except OSError:
        pass


@contextmanager
def stage(name):
    if not active():
        yield
        return
    token = _stage.set((*_stage.get(), name))
    try:
        _emit("begin")
        check()
        try:
            yield
        except (subprocess.TimeoutExpired, TimeoutError) as exc:
            raise ObservationTimeout("io_timeout") from exc
        check()
    except BaseException:
        _emit("failed")
        raise
    else:
        _emit("end")
    finally:
        _stage.reset(token)


def observed(name):
    def decorate(function):
        @wraps(function)
        def wrapped(*args, **kwargs):
            with stage(name):
                return function(*args, **kwargs)
        return wrapped
    return decorate


@contextmanager
def scope(seconds=TURN_END_SECONDS):
    if type(seconds) not in (int, float) or not math.isfinite(seconds) or seconds <= 0:
        raise ValueError("invalid_observation_budget")
    prior = _current.get()
    tick = time.monotonic()
    budget = Budget(prior.started if prior else tick,
                    min(prior.deadline, tick + seconds) if prior else tick + seconds)
    token = _current.set(budget)
    try:
        with stage("turn_end"):
            yield
    finally:
        _current.reset(token)


@contextmanager
def limit(seconds):
    """Carry a callback's timeout without changing its legacy call signature."""
    if not active():
        yield
        return
    deadline = time.monotonic() + timeout(seconds)
    prior = _limit.get()
    token = _limit.set(min(prior, deadline) if prior is not None else deadline)
    try:
        check()
        yield
        check()
    finally:
        _limit.reset(token)


def call_with_timeout(call, cli, runtime, args, seconds):
    with limit(seconds), stage("readiness_query"):
        return call(cli, runtime, args)
