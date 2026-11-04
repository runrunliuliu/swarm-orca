import hashlib
import io
import unittest

from log_io import prefix_digest, prefix_lines


class PrefixReaderTests(unittest.TestCase):
    def test_initial_eof_and_incomplete_last_record(self):
        source = io.BytesIO(b"first\nsecond\nappended\n")
        self.assertEqual(list(prefix_lines(source, 9)), [b"first\n", b"sec"])
        self.assertEqual(prefix_digest(source, 9), hashlib.sha256(b"first\nsec").hexdigest())

    def test_digest_reads_fixed_chunks_not_whole_transcript(self):
        class Chunked(io.BytesIO):
            def read(self, size=-1):
                if not 0 < size <= 1024 * 1024:
                    raise AssertionError("unbounded read")
                return super().read(size)
        content = b"x" * (3 * 1024 * 1024 + 5)
        self.assertEqual(prefix_digest(Chunked(content), len(content)), hashlib.sha256(content).hexdigest())

    def test_truncated_prefix_rejected_by_both_readers(self):
        with self.assertRaisesRegex(ValueError, "truncated"):
            list(prefix_lines(io.BytesIO(b"one\n"), 10))
        with self.assertRaisesRegex(ValueError, "truncated"):
            prefix_digest(io.BytesIO(b"one\n"), 10)
