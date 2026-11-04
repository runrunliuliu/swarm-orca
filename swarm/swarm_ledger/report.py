"""Private JSON/CSV/Markdown views; JSON is authoritative, index is rebuildable."""

import csv
import io
import json
import os
import tempfile

from supervisor.config import digest
from supervisor.store import private_directory
from .raw_usage import FIELDS as RAW_FIELDS


TOKEN_DISPLAY_NOTE = (
    "Token 展示采用十进制 K/M/B（1K=1,000，1M=1,000,000，1B=1,000,000,000），"
    "最多两位小数；精确整数见 JSON/CSV。"
)


def format_tokens(value):
    """Display exact nonnegative counts with half-up rounding; never alter storage."""
    if value is None:
        return "未知"
    if type(value) is not int:
        raise TypeError("token count must be an integer or None")
    if value < 0:
        raise ValueError("token count must be nonnegative")
    if value < 1_000:
        return str(value)
    for scale, suffix in ((1_000, "K"), (1_000_000, "M"), (1_000_000_000, "B")):
        # Integer arithmetic avoids float precision loss, including beyond 2**53.
        hundredths = (value * 100 + scale // 2) // scale
        if hundredths >= 100_000 and suffix != "B":
            continue  # Promote 1000K/1000M after rounding to the next unit.
        whole, fraction = divmod(hundredths, 100)
        decimal = f".{fraction:02d}".rstrip("0") if fraction else ""
        return f"{whole}{decimal}{suffix}"


def atomic_text(path, content):
    fd, name = tempfile.mkstemp(prefix=".ledger-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as target:
            target.write(content)
            target.flush()
            os.fsync(target.fileno())
        os.replace(name, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def cell(value):
    if value is None:
        return "未知"
    return str(value).replace("|", "\\|").replace("\n", " ").replace("\r", " ")


def markdown(data):
    s = data["summary"]
    lines = ["# Swarm 耗时与 Token 台账", "", f"Run：{cell(data['run_id'])}", "",
             f"开始 UTC：{cell(data['started_at'])}；结束 UTC：{cell(data['ended_at'])}；结果：{cell(data['outcome'])}。",
             f"最近原生采集 UTC：{cell(data['observed_at'])}；耗时未知 Agent：{s['unknown_agent_duration_count']}。", "",
             f"整轮耗时：{cell(s['wall_seconds'])} 秒；已知 Agent 累计耗时：{s['known_agent_seconds']} 秒。",
             f"Token 完整合计：{format_tokens(s['total_tokens'])}；已知小计：{format_tokens(s['known_tokens']['total_tokens'])}；"
             f"未知 Agent：{s['unknown_usage_count']}；未确认完整 Agent：{s['partial_usage_count']}。", "",
             "并行 Agent 耗时不可当成整轮耗时；耗时包含等待/工具，不是模型推理耗时。",
             "Trae 回合秒另列，含工具/等待；与 Worker 秒不可相加，回合明细见 JSON。",
             "输入包含缓存，输出包含 reasoning，不能重复相加；未知不是 0。用量不等于最终账单。",
             TOKEN_DISPLAY_NOTE, "",
             "| Agent / Dispatch | 角色 / 状态 | 提供方 / 模型 | 开始 UTC | 结束 UTC | 耗时秒 | 回合秒 | 输入 | 输出 | 缓存读 | 缓存写 | Reasoning | 总 token | 用量状态 |",
             "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
    for row in data["agents"]:
        values = [row["agent_id"], row["role"] + " / " + cell(row["status"]), cell(row.get("provider")) + " / " + cell(row.get("model")),
                  row["started_at"], row["ended_at"], row["elapsed_seconds"], row["turn_seconds"],
                  *(format_tokens(row["tokens"][k]) for k in ("input_tokens", "output_tokens", "cache_read_tokens",
                                               "cache_write_tokens", "reasoning_tokens", "total_tokens")), row["usage_status"]]
        lines.append("| " + " | ".join(cell(v) for v in values) + " |")
    coverage = data.get("usage_binding_coverage")
    if coverage and coverage["missing_worker_ids"]:
        lines += ["", "## Worker 用量采集绑定缺失", "",
                  "最近 sync 未给以下非 final Worker 配置用量绑定；同步生命周期不会自动读取 token。",
                  "已有历史样本不代表本次检查点已采集，不能用标准化口径未知解释漏采。", "",
                  *["- " + cell(aid) for aid in coverage["missing_worker_ids"]]]
    if data["summary"]["raw_usage_groups"]:
        lines += ["", "## Trae JSONL 原始计数（口径未核验）", "",
                  "下表仅为去重请求的原始计数，不计入上表标准化 token，不表示完整消耗或账单。",
                  "task_complete 与单次读取稳定也不证明日志已静止；来源摘要、绑定及告警见 JSON。", "",
                  "| Agent / Dispatch | 原始协议 | 请求数 | 原始输入 | 原始输出 | 原始缓存读 | 原始缓存写 | 原始 Reasoning | 原始 total |",
                  "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
        for row in data["agents"]:
            for group in row["raw_usage_groups"]:
                values = [row["agent_id"], group["contract"], group["request_count"],
                          *(format_tokens(group["counts"][k]) for k in RAW_FIELDS)]
                lines.append("| " + " | ".join(cell(v) for v in values) + " |")
    lines += ["", "时间及用量来源、会话窗口、完整性告警见同目录 ledger.json。", ""]
    return "\n".join(lines)


def csv_text(rows, fields):
    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fields, extrasaction="ignore")
    writer.writeheader()
    for row in rows:
        # Neutralize spreadsheet formula injection in all text cells.
        writer.writerow({k: "'" + v if isinstance(v, str) and v.lstrip().startswith(("=", "+", "-", "@")) else v
                         for k, v in row.items()})
    return output.getvalue()


def export(ledger, output):
    root = private_directory(output)
    runs = private_directory(root / "runs")
    summaries = []
    host_receipts = ledger.store.entries("host-receipt:")
    runtime_receipts = ledger.store.entries("runtime-state-receipt:")
    for data in sorted(ledger.reports(), key=lambda r: (r["started_at"], r["runtime_id"], r["run_id"])):
        key = digest([data["runtime_id"], data["run_id"]])
        target = private_directory(runs / key)
        atomic_text(target / "ledger.json", json.dumps(data, ensure_ascii=False, indent=2) + "\n")
        atomic_text(target / "ledger.md", markdown(data))
        receipts = {key.removeprefix("host-receipt:"): receipt for key, receipt in host_receipts.items()
                    if receipt["payload"]["request"]["scope"]["runtime_id"] == data["runtime_id"] and
                    receipt["payload"]["request"]["scope"]["run_id"] == data["run_id"]}
        atomic_text(target / "host-bindings.json", json.dumps(receipts, ensure_ascii=False, indent=2) + "\n")
        runtime_evidence = {key.removeprefix("runtime-state-receipt:"): receipt for key, receipt in runtime_receipts.items()
                           if receipt["scope"]["runtime_id"] == data["runtime_id"] and
                           receipt["scope"]["run_id"] == data["run_id"]}
        atomic_text(target / "runtime-bindings.json", json.dumps(runtime_evidence, ensure_ascii=False, indent=2) + "\n")
        rows = [{**r, **r["tokens"], "known_total_tokens": r["known_tokens"]["total_tokens"]} for r in data["agents"]]
        atomic_text(target / "agents.csv", csv_text(rows, ["agent_id", "role", "task_id", "retry_of", "status",
                    "dispatch_status", "provider", "model", "effort", "started_at", "ended_at", "released_at",
                    "elapsed_seconds", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens",
                    "reasoning_tokens", "total_tokens", "known_total_tokens", "usage_status",
                    "turn_seconds", "known_turn_seconds", "turn_count", "turn_timing_status"]))
        raw_rows = [{"agent_id": r["agent_id"], "provider": s["provider"], "session_id": s["session_id"],
                     "since": s["since"], "until": s["until"], "source": s["source"],
                     "binding_source": s["raw_usage"]["binding"]["source"],
                     "contract": s["raw_usage"]["contract"], "counter_semantics": "unverified",
                     "request_count": len(s["raw_usage"]["requests"]), "warnings": ",".join(s["warnings"]),
                     **{"raw_" + k: v for k, v in s["raw_usage"]["counts"].items()},
                     **{"known_raw_" + k: v for k, v in s["raw_usage"]["known_counts"].items()}}
                    for r in data["agents"] for s in r["usage_sources"] if "raw_usage" in s]
        atomic_text(target / "raw-usage.csv", csv_text(raw_rows, ["agent_id", "provider", "session_id", "since", "until",
                    "source", "binding_source", "contract", "counter_semantics", "request_count",
                    *("raw_" + k for k in RAW_FIELDS), *("known_raw_" + k for k in RAW_FIELDS), "warnings"]))
        summaries.append({"runtime_id": data["runtime_id"], "run_id": data["run_id"],
                          "started_at": data["started_at"], "ended_at": data["ended_at"], "outcome": data["outcome"],
                          "observed_at": data["observed_at"],
                          **data["summary"], "known_total_tokens": data["summary"]["known_tokens"]["total_tokens"],
                          "report": "runs/" + key + "/ledger.md"})
    atomic_text(root / "index.json", json.dumps(summaries, ensure_ascii=False, indent=2) + "\n")
    atomic_text(root / "runs.csv", csv_text(summaries, ["runtime_id", "run_id", "started_at", "ended_at", "outcome", "observed_at",
                "wall_seconds", "known_agent_seconds", "unknown_agent_duration_count", "agent_count",
                "known_total_tokens", "total_tokens", "unknown_usage_count", "partial_usage_count", "report"]))
    lines = ["# Swarm 台账总表", "", "已知小计不是完整消耗；未知不是 0。Agent 秒包含并行、等待和工具执行，不能代替整轮秒。",
             TOKEN_DISPLAY_NOTE, "",
             "| Run | 开始 UTC | 结果 | 整轮秒 | 已知 Agent 秒 | 已知 token 小计 | 完整 token 合计 | 未知/未完整 Agent | 明细 |",
             "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
    for row in summaries:
        values = [*(row[k] for k in ("run_id", "started_at", "outcome", "wall_seconds", "known_agent_seconds")),
                  format_tokens(row["known_total_tokens"]), format_tokens(row["total_tokens"])]
        lines.append("| " + " | ".join(cell(v) for v in values) +
                     f" | {row['unknown_usage_count']}/{row['partial_usage_count']} | [查看]({row['report']}) |")
    atomic_text(root / "index.md", "\n".join(lines) + "\n")
    return {"index": str(root / "index.md"), "csv": str(root / "runs.csv"), "runs": len(summaries), "public": False}
