"""Keep offline assertions independent of the caller's private Operator policy.

A shell that runs the suite may export `SWARM_WORKER_PROFILES` for real deployment
work. Modules that assert on the bundled fixture start from a cleared environment so
the same assertions describe the same file everywhere.
"""

import os
from unittest.mock import patch


def cleared():
    """Start (and return, for `addCleanup(....stop)`) an empty-environment patch."""
    environ = dict(os.environ)
    environ.pop("SWARM_WORKER_PROFILES", None)
    guard = patch.dict(os.environ, environ, clear=True)
    guard.start()
    return guard
