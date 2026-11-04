"""Read a finite log snapshot without imposing a lifetime transcript size limit."""

import hashlib


def prefix_lines(source, size):
    """Yield records up to the initial EOF, including a possible partial last line.

    Memory is proportional to the largest record, not the whole transcript.
    Concurrent appends belong to the next observation; truncation is an error.
    """
    remaining = size
    while remaining:
        line = source.readline(remaining)
        if not line:
            raise ValueError("log truncated during read")
        remaining -= len(line)
        yield line


def prefix_digest(source, size):
    source.seek(0)
    remaining = size
    digest = hashlib.sha256()
    while remaining:
        chunk = source.read(min(remaining, 1024 * 1024))
        if not chunk:
            raise ValueError("log truncated during read")
        remaining -= len(chunk)
        digest.update(chunk)
    return digest.hexdigest()
