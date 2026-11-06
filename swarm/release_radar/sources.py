"""Bounded HTTP fetch and the Runner release-notes adapter.

All returned text is untrusted data, never an instruction or executable input.
"""

import gzip
from html.parser import HTMLParser
import io
import re
import subprocess
import tempfile
from urllib.request import Request, urlopen


RUNNER_URL = "https://runnersh.dev/release-notes/"
MAX_BYTES = 4 * 1024 * 1024


def fetch_curl(url=RUNNER_URL, *, limit=MAX_BYTES):
    """Explicit optional transport for hosts needing HTTP/2 / modern compression.

    No redirects, shell, automatic fallback, or retries. curl bounds transfer
    duration/size; the pipe independently bounds decompressed bytes in Python.
    """
    with tempfile.TemporaryFile() as errors:
        with subprocess.Popen(["curl", "--disable", "--compressed", "--fail", "--silent", "--show-error",
                               "--proto", "=https", "--max-time", "45", "--max-filesize", str(limit),
                               "--user-agent", "release-radar/1", "--write-out", "\n%{http_code}", url],
                              stdout=subprocess.PIPE, stderr=errors) as process:
            try:
                raw = process.stdout.read(limit + 5)
                if len(raw) > limit + 4:
                    raise ValueError("decoded_response_too_large")
                if process.wait(timeout=5) != 0:
                    raise ValueError("curl_fetch_failed_no_state_change")
                if not raw.endswith(b"\n200"):
                    raise ValueError("unexpected_http_status")
                return raw[:-4].decode("utf-8", errors="strict")
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()


def fetch(url=RUNNER_URL, *, opener=urlopen, limit=MAX_BYTES):
    request = Request(url, headers={"Accept-Encoding": "gzip", "User-Agent": "release-radar/1"})
    # No automatic retry: the scheduler/operator may retry this read-only stage.
    with opener(request, timeout=45) as response:
        if response.status != 200 or response.geturl() != url:
            raise ValueError("unexpected_http_status_or_redirect")
        if "text/html" not in response.headers.get("Content-Type", ""):
            raise ValueError("expected_html")
        raw = response.read(limit + 1)
        if len(raw) > limit:
            raise ValueError("response_too_large")
        encoding = response.headers.get("Content-Encoding", "identity").lower()
        if encoding == "gzip":
            with gzip.GzipFile(fileobj=io.BytesIO(raw)) as stream:
                raw = stream.read(limit + 1)
        elif encoding != "identity":
            raise ValueError("unsupported_content_encoding")
        if len(raw) > limit:
            raise ValueError("decoded_response_too_large")
        return raw.decode("utf-8", errors="strict")


class RunnerParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.releases = []
        self.current = None
        self.parts = []
        self.ignored = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "article" and "release-entry" in attrs.get("class", "").split():
            if self.current is not None:
                raise ValueError("nested_release_article")
            anchor = attrs.get("id", "")
            if not re.fullmatch(r"v\d+\.\d+\.\d+(?:[-.][a-zA-Z0-9.-]+)?", anchor):
                raise ValueError("invalid_release_anchor")
            self.current = {"version": anchor[1:], "url": RUNNER_URL + "#" + anchor,
                            "date": ""}
            self.parts = []
        if self.current is None:
            return
        void = tag in {"br", "hr", "img", "input", "meta", "link", "source", "wbr"}
        volatile = {"latest", "release-downloads", "older-downloads"}
        if self.ignored or tag in {"script", "style", "svg"} or volatile.intersection(
                attrs.get("class", "").split()):
            if not void:
                self.ignored.append(tag)
            return
        if not self.ignored:
            if tag == "time" and not self.current["date"]:
                self.current["date"] = attrs.get("datetime", "")
            if tag in {"p", "li", "h2", "h3", "h4", "br", "section", "div"}:
                self.parts.append("\n")
            if tag == "a" and attrs.get("href", "").startswith("https://"):
                self.parts.append(" [" + attrs["href"] + "] ")

    def handle_endtag(self, tag):
        if self.current is None:
            return
        if self.ignored:
            if self.ignored[-1] == tag:
                self.ignored.pop()
            return
        if tag in {"p", "li", "h2", "h3", "h4", "section", "div"}:
            self.parts.append("\n")
        if tag == "article":
            lines = [" ".join(line.split()) for line in "".join(self.parts).splitlines()]
            self.current["text"] = "\n".join(line for line in lines if line)
            if not self.current["date"] or len(self.current["text"]) < 30 or self.ignored:
                raise ValueError("incomplete_release")
            self.releases.append(self.current)
            self.current = None

    def handle_data(self, data):
        if self.current is not None and not self.ignored:
            self.parts.append(data)


def parse_runner(html):
    parser = RunnerParser()
    parser.feed(html)
    parser.close()
    releases = parser.releases
    if parser.current is not None or not releases:
        raise ValueError("missing_or_truncated_releases")
    if len({r["version"] for r in releases}) != len(releases):
        raise ValueError("duplicate_release_version")
    # Do not trust visual/page order for the bootstrap window.
    from datetime import datetime
    for release in releases:
        date = datetime.fromisoformat(release["date"].replace("Z", "+00:00"))
        if date.utcoffset() is None:
            raise ValueError("release_date_without_timezone")
    return sorted(releases, key=lambda r: datetime.fromisoformat(
        r["date"].replace("Z", "+00:00")), reverse=True)
