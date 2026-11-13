> **冻结（2026-11-13）**：生成器与它描述的 `swarm/bootstrap_actions.py` 已删除，本文不再更新。
> 它是旧 strict bootstrap 握手的阶段/槽位记录，只用于读懂历史 attempt；新任务走
> [start grant](docs/design/start-grant.md)。

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

由 `bootstrap_actions.command()` 渲染，与 action 回执里的 `complete_argv` /
`inspect_argv` 同源；**直接使用回执给的 argv**，不要照本页手拼。

```bash
python3 -B <swarm>/coordinator_launch.py strict-bootstrap pull --owner <owner.json> --owner-sha256 <owner-sha256> --actor <role> --intent <intent.json> --intent-sha256 <intent-sha256> --execute
python3 -B <swarm>/coordinator_launch.py strict-bootstrap produce --owner <owner.json> --owner-sha256 <owner-sha256> --actor <role> --intent <intent.json> --intent-sha256 <intent-sha256> --execute
python3 -B <swarm>/coordinator_launch.py strict-bootstrap submit --owner <owner.json> --owner-sha256 <owner-sha256> --actor <role> --intent <intent.json> --intent-sha256 <intent-sha256> --execute
python3 -B <swarm>/coordinator_launch.py strict-bootstrap readiness --owner <owner.json> --owner-sha256 <owner-sha256> --actor <role> --intent <intent.json> --intent-sha256 <intent-sha256> --execute
python3 -B <swarm>/coordinator_launch.py strict-bootstrap complete --owner <owner.json> --owner-sha256 <owner-sha256> --actor <role> --intent <intent.json> --intent-sha256 <intent-sha256> --execute
python3 -B <swarm>/coordinator_launch.py strict-bootstrap inspect-action --owner <owner.json> --owner-sha256 <owner-sha256> --actor <role> --intent <intent.json> --intent-sha256 <intent-sha256>

# submit 还需候选：--input <candidate.json> --input-sha256 <sha>，
# 或（仅 fields-intent）--from-template。complete 不接受 --input：
# 它从 contract.outputs 的 candidate_path 本地取 pin。
# 除 inspect-action 外都带 --execute：CLI 拒绝缺它的调用
# （bootstrap_explicit_execute_required）。
```

## 不要这样做

- 手写 `complete_argv` / `inspect_argv`：它们由 helper 返回，重拼会漂移。
- 把本文件当规范读：准入、拒绝原因与边界在协议里，这里只索引。
- 为 review 阶段用 `--from-template`：`decision`/`notes` 是复核者的判断。
