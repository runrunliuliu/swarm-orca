"""Bound caller waiting, not kernel I/O or mutation execution.

Threads retain the original process/peer identity. Timed-out work is never
retried, joined, or treated as cancelled. Slots remain occupied until it exits.
Diagnostics are bounded memory only: no log writes on the critical path.
"""

from collections import deque
from contextlib import contextmanager
from contextvars import ContextVar, copy_context
from functools import wraps
from itertools import count
import math
import threading
import time
import uuid


_current = ContextVar("blocking_io_operation", default=None)
_slots = threading.BoundedSemaphore(4)


class BlockingIOTimeout(ValueError):
    def __init__(self, operation):
        super().__init__("bootstrap_io_timeout_requires_reconciliation" if operation.mutation
                         else "bootstrap_io_observation_timeout")
        self.details = operation.snapshot() | dict(outcome="unknown", retry_allowed=False,
                                                   execution_cancelled=False)


class Operation:
    def __init__(self, name, seconds=None, *, mutation=False):
        self.id = uuid.uuid4().hex
        self.name, self.mutation = name, mutation
        self.started = time.monotonic()
        self.deadline = None if seconds is None else self.started + seconds
        self.events = deque(maxlen=64)
        self.sequence = count()

    def emit(self, phase, stage, target=None):
        # One execution thread writes each Operation. On supported CPython,
        # deque append/copy are atomic; diagnostic readers cannot drop a begin.
        self.events.append(dict(phase=phase, stage=stage, target=target,
                                elapsed_seconds=time.monotonic() - self.started,
                                sequence=next(self.sequence)))

    @property
    def dropped(self):
        rows = self.events.copy()
        return rows[-1]["sequence"] + 1 - len(rows) if rows else 0

    def snapshot(self):
        rows = list(self.events.copy())
        dropped = rows[-1]["sequence"] + 1 - len(rows) if rows else 0
        return dict(op_id=self.id, operation=self.name, durable=False,
                    elapsed_seconds=time.monotonic() - self.started,
                    events=rows, dropped=dropped, partial=bool(dropped))


def check():
    operation = _current.get()
    if operation is not None and operation.deadline is not None and time.monotonic() >= operation.deadline:
        raise BlockingIOTimeout(operation)


@contextmanager
def tracking(operation):
    token = _current.set(operation)
    try:
        yield
    finally:
        _current.reset(token)


@contextmanager
def stage(name, target=None, *, check_after=True):
    operation = _current.get()
    if operation is None:
        yield
        return
    operation.emit("begin", name, target)
    try:
        check()
        yield
        if check_after:
            check()
    except BaseException:
        operation.emit("failed", name, target)
        raise
    else:
        operation.emit("end", name, target)


def observed(name, target=None):
    def decorate(function):
        @wraps(function)
        def wrapped(*args, **kwargs):
            with stage(name, target(*args, **kwargs) if target else None):
                return function(*args, **kwargs)
        return wrapped
    return decorate


def run(function, *, seconds=30, name="helper", mutation=False):
    if type(seconds) not in (int, float) or not math.isfinite(seconds) or seconds <= 0:
        raise ValueError("bootstrap_io_budget_invalid")
    if _current.get() is not None:
        # A nested call shares its original deadline; no new thread or budget.
        with stage(name):
            return function()
    slots = _slots
    if not slots.acquire(blocking=False):
        raise ValueError("bootstrap_io_capacity_exhausted")
    operation = Operation(name, seconds, mutation=mutation)
    done, result = threading.Event(), []
    context = copy_context()

    def execute():
        try:
            with tracking(operation), stage(name):
                value = function()
            result.append((True, value))
        except BaseException as exc:
            result.append((False, exc))
        finally:
            done.set()
            slots.release()

    worker = threading.Thread(target=context.run, args=(execute,), daemon=True, name="swarm-io-" + operation.id)
    try:
        worker.start()
    except BaseException:
        slots.release()
        raise
    if not done.wait(max(0, operation.deadline - time.monotonic())):
        raise BlockingIOTimeout(operation)
    success, value = result[0]
    if not success:
        raise value
    return value


def bounded(name, *, seconds=30, mutation=False):
    def decorate(function):
        @wraps(function)
        def wrapped(*args, **kwargs):
            return run(lambda: function(*args, **kwargs), seconds=seconds, name=name, mutation=mutation)
        return wrapped
    return decorate
