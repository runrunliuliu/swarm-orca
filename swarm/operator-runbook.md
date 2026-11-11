# Operator runbook（生成文件，不要手改）

本文由 `swarm/generate_runbook.py` 从 `bootstrap_actions.ACTIONS` 生成；`--check` 不一致即
`exit 2`。手改会被覆盖，规则本身写在
[strict-bootstrap-protocol.md](strict-bootstrap-protocol.md)（S0–S5）与
本文件只回答“这一步是谁、读写哪个槽、跑什么命令”。

## 读取顺序

1. `strict-bootstrap-protocol.md` §1–§9：规范与准入。
2. 本文：当前阶段的 owner、槽位与 argv。
3. 需要离线闭环或历史实测时再读
   [strict-bootstrap-offline.md](strict-bootstrap-offline.md)（#10–#13），它不是开机必读。

## 阶段表

| 阶段 | actor | mode | 写入槽 | 完成回执 | 依章节 |
| --- | --- | --- | --- | --- | --- |
| `caller-intent` | coordinator | produce | `caller_receipt` | `produce` | §2 固定路径、S0 与公共类型 |
| `observe-intent` | operator | produce | `session_observation` | `produce` | §2 固定路径、S0 与公共类型 |
| `fields-intent` | operator | submit | `contract_fields` | `fields-submission.json` | §4 原 Operator 字段生产与审查接口 |
| `contract-intent` | operator | submit | `contract_review` | `contract-submission.json` | §4 原 Operator 字段生产与审查接口 |
| `final-evidence-intent` | coordinator | readiness | `final_readiness` | `final-evidence-submission.json` | §4 |
| `readiness-intent` | operator | submit | `readiness_review` | `readiness-submission.json` | §4 原 Operator 字段生产与审查接口 |

## 命令形状

```bash
# 取下一步（返回 complete_argv / inspect_argv，不要自己拼参数）
python3 -B bootstrap_tool.py pull --owner <owner.json> --owner-sha256 <sha> --actor <role> --execute

# 机械产物（caller/observation 由 helper 产出，不是模型）
python3 -B bootstrap_tool.py produce --owner <owner.json> --owner-sha256 <sha> --actor <role> \
  --intent <intent.json> --intent-sha256 <sha> --execute

# 提交候选：人写字节，或由意图里的模板 materialize（仅 fields-intent）
python3 -B bootstrap_tool.py submit --owner <owner.json> --owner-sha256 <sha> --actor <role> \
  --intent <intent.json> --intent-sha256 <sha> --input <candidate.json> --input-sha256 <sha> --execute
python3 -B bootstrap_tool.py submit ... --from-template --execute

# 完成阶段与对账
python3 -B bootstrap_tool.py complete --owner <owner.json> --owner-sha256 <sha> --actor <role> \
  --intent <intent.json> --intent-sha256 <sha> --input <result.json> --input-sha256 <sha> --execute
python3 -B bootstrap_tool.py inspect-action --owner <owner.json> --owner-sha256 <sha> \
  --actor <role> --intent <intent.json> --intent-sha256 <sha>
```

## 不要这样做

- 手写 `complete_argv` / `inspect_argv`：它们由 helper 返回，重拼会漂移。
- 把本文件当规范读：准入、拒绝原因与边界在协议里，这里只索引。
- 为 review 阶段用 `--from-template`：`decision`/`notes` 是复核者的判断。
