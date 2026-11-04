"""Unnormalized request counters. Never feed these into normalized token totals."""

import re

from supervisor.config import require

# Versioned contracts keep old exports stable and do not imply billing equivalence
# across producers. Extend only after checking token records and replay tests.
TRAE_JSONL_CONTRACTS = {
    "0.209.1": "trae-jsonl-0.209.1-token_usage_record",
    "0.210.1": "trae-jsonl-0.210.1-token_usage_record",
    "0.211.1": "trae-jsonl-0.211.1-token_usage_record",
    "0.212.1": "trae-jsonl-0.212.1-token_usage_record",
    "0.213.1": "trae-jsonl-0.213.1-token_usage_record",
}
CONTRACT = TRAE_JSONL_CONTRACTS["0.209.1"]  # Historical import compatibility.
FIELDS = ("input_tokens", "output_tokens", "cached_input_tokens",
          "cache_creation_input_tokens", "reasoning_output_tokens", "total_tokens")


def trae_jsonl_contract(version):
    require(isinstance(version, str) and version in TRAE_JSONL_CONTRACTS,
            "unsupported Trae JSONL producer/version")
    return TRAE_JSONL_CONTRACTS[version]


def sha256_id(value):
    require(isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None,
            "invalid raw usage digest")
    return value


def counts(value):
    require(isinstance(value, dict), "invalid raw usage object")
    result = {k: value.get(k) for k in FIELDS}
    require(all(v is None or type(v) is int and v >= 0 for v in result.values()),
            "invalid raw usage counter")
    return result


def totals(requests):
    values = [r["counts"] for r in requests]
    return {
        "counts": {k: sum(v[k] for v in values) if values and all(v[k] is not None for v in values)
                   else None for k in FIELDS},
        "known_counts": {k: sum(v[k] for v in values if v[k] is not None) for k in FIELDS},
    }


def requests(value):
    require(isinstance(value, list), "raw usage requests must be an array")
    result, seen = [], set()
    for row in value:
        require(isinstance(row, dict), "invalid raw request")
        key = sha256_id(row["id"])
        require(key not in seen, "duplicate raw request")
        seen.add(key)
        result.append({"id": key, "record_sha256": sha256_id(row["record_sha256"]),
                       "counts": counts(row["counts"])})
    return sorted(result, key=lambda r: r["id"])


def groups(samples):
    """Group only compatible raw contracts; unknown samples remain visible elsewhere."""
    buckets = {}
    for sample in samples:
        raw = sample.get("raw_usage")
        if raw:
            key = (sample["provider"], raw["contract"])
            buckets.setdefault(key, []).extend(raw["requests"])
    return [{"provider": provider, "contract": contract, "counter_semantics": "unverified",
             "request_count": len(rows), **totals(rows)}
            for (provider, contract), rows in sorted(buckets.items())]
