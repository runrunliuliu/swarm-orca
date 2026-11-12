"""A watcher that never sees an event, for tests whose subject is the wait's semantics.

Why this exists: the two strict waits used to publish from inside the fixture's patched
`time.sleep` — the "time passed, so the producer acted" tick. Once a real wait is an inotify poll
that `sleep` is never called, so a fixture that keeps publishing there would never publish at all
and the module would hang on the real fallback period instead of failing. These tests are about
the deadline, the pins and the tamper checks, not about inotify, so they substitute the waiting
mechanism the same way they already substitute the clock: every wait reports "no event" and
advances the fixture clock by one old polling period, so the loop re-checks its file exactly as it
did before this change.

The real watcher stays in play where it is the subject: `core.test_publication_wait` runs it
against a live directory, and one event test in each strict module drives it end to end with a
real publication. A wrong watch path therefore cannot hide here as a passing test.
"""


class PollingWatcher:
    """`wait()` spends one polling period (the period this change removes) and reports no event.

    `advance` is the fixture clock tick; it is resolved at call time so the test's own
    `patch("...time.sleep", side_effect=...)` keeps driving the clock.
    """

    POLL_SECONDS = 0.25

    def __init__(self, advance):
        self.events = 0
        self.timeouts = 0
        self.closed = False
        self._advance = advance

    def wait(self, seconds):
        self._advance(self.POLL_SECONDS)
        self.timeouts += 1
        return False

    def close(self):
        self.closed = True


def polling_watch(advance):
    """A `publication_wait.watch` replacement for fixtures whose producer answers the wait.

    Several fixtures simulate "another process published while you waited" by publishing from the
    period the loop spends. That period is now a real poll instead of `time.sleep`, so the
    producer has to hang off the wait: this returns one passive watcher per `watch()` call, and
    each wait spends exactly the old polling period on the fixture's own clock.
    """
    return lambda target: PollingWatcher(advance)
