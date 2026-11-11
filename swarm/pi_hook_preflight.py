"""Read-only preflight for the Orca Pi per-pane hook channel; never authority.

The Pi gate roles need one `source=pi` row in Orca's `agent-hooks/last-status.json`
for the observed pane. `swarm_ledger.runtime_binding` already refuses without it
(`runtime_state_missing_pane`), and that refusal stays exactly as it is. What the
reader cannot say is *why* the row is missing: the pane can be a live, writable,
`terminal create --agent pi` pane running the managed status extension and still
never place a row. Two verified shapes produce that silence on this build, and
neither is a provider capability gap:

1. Delivery. A sender that posts with the runtime's global `fetch` is handed to
   the configured environment proxy unless the no-proxy list names loopback
   **literally**: the dispatcher's matcher understands exact hosts, `.suffix` and
   `*`, not CIDR ranges, so a list that only carries `127.0.0.0/8` leaves loopback
   proxied and the snapshot dies as a swallowed delivery error. This is what the
   shipped extension did; a build carrying the loopback-`http` transport is immune
   to it, so a hijacked global fetch is now **advisory**: it says a fetch-based
   sender would fail, not that this pane did.
2. Shape. A Pi `session_start` snapshot is published as a *resume identity*
   (`providerSessionOnly`), not as live attribution; the strict reader rejects it
   on purpose. A pane whose only delivered event was `session_start` therefore
   still has no usable row, and the gate needs at least one turn event.

This module only names which of those holds. It reads a pane's environment, the
hook store row and nothing else; it writes no row, opens no transport and grants
nothing. `execution_authorized` is always false, and no gate may branch on it: a
green preflight is "this channel might deliver", never evidence that it did.
"""

import argparse
import json
import sys

# Reused names: the reader's own evidence channels, so a missing row is reported
# with the same vocabulary as `provider_capability.py`, not a parallel one.
MISSING_PANE_ROW = "agent_hooks_pane_status"
MISSING_SESSION = "session_id"
MISSING_TRANSCRIPT = "transcript_path"
MISSING_COMMITMENT = "launch_token_hash"

# The extension posts to this literal host; loopback bypass is decided for it.
LOOPBACK_HOST = "127.0.0.1"
PROXY_VARIABLES = ("http_proxy", "https_proxy", "all_proxy",
                   "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY")

TRANSPORT_HIJACKED = "pi_hook_transport_proxied_loopback"
TRANSPORT_DIRECT = "pi_hook_transport_loopback_direct"
ROW_MISSING = "pi_hook_row_missing"
ROW_USABLE = "pi_hook_row_usable"
ROW_PROVIDER_SESSION_ONLY = "pi_hook_row_provider_session_only"
ROW_REPLAY_OR_RESTORED = "pi_hook_row_replay_or_restored"
ROW_FOREIGN_SOURCE = "pi_hook_row_foreign_source"
ROW_PANE_MISMATCH = "pi_hook_row_pane_mismatch"
ROW_SESSION_MISSING = "pi_hook_row_provider_session_missing"
ROW_COMMITMENT_MISSING = "pi_hook_row_launch_commitment_missing"


def parse_no_proxy(value):
    """Parse a no-proxy list the way the runtime's dispatcher does.

    Exact host, `.suffix`, `*`, and an optional `:port` (or `[v6]:port`) are
    understood. A CIDR entry such as `127.0.0.0/8` parses as a host named
    `127.0.0.0/8` and can therefore never match, which is the whole point: it is
    kept as an entry rather than silently dropped so the report shows what the
    host actually declared.
    """
    if not isinstance(value, str):
        return []
    entries = []
    for raw in value.replace("\n", " ").split(","):
        for entry in raw.split():
            if not entry:
                continue
            hostname, port = entry, 0
            if entry.startswith("[") and "]:" in entry:
                hostname, _, port_text = entry[1:].partition("]:")
                port = int(port_text) if port_text.isdigit() else 0
            elif entry.count(":") == 1:
                left, _, right = entry.partition(":")
                if right.isdigit():
                    hostname, port = left, int(right)
            wildcard = entry.startswith("*")
            # A bare `*` stays `*`: it is the "bypass everything" entry, not an
            # empty host that could never match.
            normalized = "*" if hostname == "*" else hostname.lstrip("*").lstrip(".").rstrip(".").lower()
            entries.append({"hostname": normalized, "port": port, "wildcard": wildcard,
                            "raw": entry, "cidr": "/" in normalized})
    return entries


def no_proxy_matches(entries, hostname, port=0):
    """True when this host/port bypasses the proxy, mirroring the dispatcher."""
    name = hostname.lower()
    for entry in entries:
        if entry["hostname"] == "*":
            if entry["port"] and entry["port"] != port:
                continue
            return True
        if entry["port"] and entry["port"] != port:
            continue
        if not entry["wildcard"] and name == entry["hostname"]:
            return True
        if name.endswith("." + entry["hostname"]):
            return True
    return False


def environment(environ):
    """Decided proxy/no-proxy inputs, first definition wins per variable name.

    Presence matters, not truthiness: a runtime that reads `no_proxy` first obeys
    an empty `no_proxy` even when `NO_PROXY` carries loopback, so an empty value
    is recorded rather than treated as absent.
    """
    resolved = {}
    for name in (*PROXY_VARIABLES, "no_proxy", "NO_PROXY"):
        if name in environ and environ[name] is not None:
            resolved[name] = environ[name]
    return resolved


def transport(environ, host=LOOPBACK_HOST):
    """Would a global-`fetch` POST to loopback go direct, or into the proxy?

    The runtime prefers lowercase `no_proxy` even when the uppercase list is the
    one that carries loopback, so the report names the source it actually used.
    """
    resolved = environment(environ)
    proxy = next((name for name in PROXY_VARIABLES if resolved.get(name)), None)
    if "no_proxy" in resolved:
        source, value = "no_proxy", resolved["no_proxy"]
    elif "NO_PROXY" in resolved:
        source, value = "NO_PROXY", resolved["NO_PROXY"]
    else:
        source, value = None, ""
    entries = parse_no_proxy(value)
    bypassed = no_proxy_matches(entries, host)
    return {
        "proxy_variable": proxy,
        "no_proxy_source": source,
        # Only the entries that could plausibly be about loopback, so a long
        # corporate list does not bury the one line that decides this.
        "no_proxy_loopback_entries": [entry["raw"] for entry in entries
                                      if entry["cidr"] and entry["hostname"].startswith("127.")
                                      or entry["hostname"] in (host, "localhost", "::1", "*")],
        "cidr_entries_ignored": [entry["raw"] for entry in entries if entry["cidr"]],
        "loopback_bypasses_proxy": bypassed,
        # Advisory only: this is about a *fetch-based* sender. A shipped sender on
        # the loopback-http transport delivers regardless of these variables.
        "fetch_sender_would_deliver": bypassed or proxy is None,
        "reason": TRANSPORT_HIJACKED if proxy is not None and not bypassed else TRANSPORT_DIRECT,
    }


def row_verdict(row, *, provider="pi", worktree_id=None, tab_id=None,
                require_launch_commitment=True):
    """Classify one hook-store row exactly as the strict reader would.

    The codes are diagnosis, not decisions: the reader re-derives every one of
    these requirements itself and is the only thing that can accept or refuse.
    """
    if not isinstance(row, dict):
        return {"present": False, "reasons": [ROW_MISSING], "missing_evidence": [MISSING_PANE_ROW]}
    reasons = []
    if row.get("source") != provider or (row.get("payload") or {}).get("agentType") != provider:
        reasons.append(ROW_FOREIGN_SOURCE)
    if (worktree_id is not None and row.get("worktreeId") != worktree_id) or \
            (tab_id is not None and row.get("tabId") != tab_id):
        reasons.append(ROW_PANE_MISMATCH)
    if row.get("structuredHost") or row.get("restoredUnconfirmed") or row.get("isReplay"):
        reasons.append(ROW_REPLAY_OR_RESTORED)
    if row.get("providerSessionOnly") or row.get("toolAgentId"):
        reasons.append(ROW_PROVIDER_SESSION_ONLY)
    session = row.get("providerSession") or {}
    if session.get("key") != "session_id" or not session.get("id") or not session.get("transcriptPath"):
        reasons.append(ROW_SESSION_MISSING)
    if require_launch_commitment:
        commitment = row.get("launchTokenHash")
        if not (isinstance(commitment, str) and len(commitment) == 64
                and all(c in "0123456789abcdef" for c in commitment)):
            reasons.append(ROW_COMMITMENT_MISSING)
    missing = []
    if ROW_SESSION_MISSING in reasons:
        missing += [MISSING_SESSION, MISSING_TRANSCRIPT]
    if ROW_COMMITMENT_MISSING in reasons:
        missing.append(MISSING_COMMITMENT)
    return {"present": True, "reasons": reasons or [ROW_USABLE], "usable": not reasons,
            "missing_evidence": missing}


def preflight(*, environ, row, worktree_id=None, tab_id=None,
              require_launch_commitment=True, provider="pi"):
    """One read-only record. It is not evidence and it authorizes nothing."""
    channel = transport(environ)
    verdict = row_verdict(row, provider=provider, worktree_id=worktree_id, tab_id=tab_id,
                          require_launch_commitment=require_launch_commitment)
    reasons = list(verdict["reasons"])
    if channel["reason"] == TRANSPORT_HIJACKED:
        reasons.insert(0, TRANSPORT_HIJACKED)
    return {
        "schema_version": 1,
        "kind": "pi_hook_preflight",
        "provider": provider,
        "diagnostic_only": True,
        "execution_authorized": False,
        # "Looks able to deliver", never "delivered". The reader decides that. The
        # verdict rests on the observed row, not on the proxy variables: a hijacked
        # global fetch only tells you a fetch-based sender would have failed.
        "channel_plausible": verdict.get("usable", False),
        "transport": channel,
        "row": verdict,
        "reasons": reasons,
        "missing_evidence": verdict["missing_evidence"] or (
            [] if verdict.get("usable") else [MISSING_PANE_ROW]),
        "note": "A passing preflight says the channel might deliver. Only a fresh "
                "runtime_binding capture may bind a pane. Transport reasons are "
                "advisory for fetch-based senders; the row is the evidence.",
    }


def read_pane_environ(path):
    """`/proc/<pid>/environ` is NUL-separated; a KEY=VALUE text file also parses."""
    with open(path, "rb") as source:
        raw = source.read()
    text = raw.decode("utf-8", "replace")
    pairs = text.split("\0") if "\0" in text else text.splitlines()
    environ = {}
    for pair in pairs:
        key, separator, value = pair.partition("=")
        if separator and key and key not in environ:
            environ[key] = value
    return environ


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--pane-env", help="pane environment, e.g. /proc/<pid>/environ")
    parser.add_argument("--hook-store", help="agent-hooks/last-status.json")
    parser.add_argument("--pane-key", help="tabId:leafId of the observed pane")
    parser.add_argument("--worktree-id")
    parser.add_argument("--tab-id")
    parser.add_argument("--no-launch-commitment", action="store_true",
                        help="usage accounting reads the row without the gate's commitment")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    environ = read_pane_environ(args.pane_env) if args.pane_env else {}
    row = None
    if args.hook_store and args.pane_key:
        with open(args.hook_store, "r", encoding="utf-8") as source:
            store = json.load(source)
        entries = store.get("entries") if isinstance(store, dict) else None
        row = (entries or {}).get(args.pane_key) if isinstance(entries, dict) else None
    record = preflight(environ=environ, row=row, worktree_id=args.worktree_id,
                       tab_id=args.tab_id,
                       require_launch_commitment=not args.no_launch_commitment)
    if args.json:
        json.dump(record, sys.stdout, indent=1, sort_keys=False)
        sys.stdout.write("\n")
    else:
        print("channel_plausible:", record["channel_plausible"])
        print("reasons:", ", ".join(record["reasons"]))
        print("proxy:", record["transport"]["proxy_variable"] or "none",
              "| loopback bypasses proxy:", record["transport"]["loopback_bypasses_proxy"])
        if args.hook_store and args.pane_key:
            print("row present:", record["row"]["present"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
