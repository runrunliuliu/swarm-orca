# 端到端示例：从信号到 issue 文件到 guardrail 提案

- 配套文档：[issue-sedimentation.md](issue-sedimentation.md)
- 日期：2026-11-12（Asia/Shanghai）
- 状态：**虚构示例**，不是运行证据，不是验收结论
- 标注约定：`[已实现]` 现有代码已产出该字段/该行为；`[设计中]` 本文定义但无实现；
  `[缺口]` 无实现也无定义。每处标注都指向依据文件，不指向本文。

> 本文所有 `run_example01`、`task_example07`、`disp_example07a`、`term_example`、
> `inc_...`、`clu_...`、`grd_...` 均为虚构标识符。示例中不出现真实 Run/Task/Dispatch/终端 ID、
> 主机名、私有路径、凭据或 session 原文。字段名沿用现有代码词汇；示例值不可用于对账。

## 0. 场景一句话

一个实施 worker 的回合续跑器连续三个回合只"重述计划"、不执行动作，被**进程外**观察者判定为
无进展；第一次只落一条 incident record，第二次出现同一模式后才形成 issue 文件，并产出两条
防复发提案。

## 1. 信号（S0，均为已有观测面）

三个来源各自只陈述事实，都不下"这是 bug"的结论：

| 来源 | 级别 | 例子（虚构） | 说明 |
| --- | --- | --- | --- |
| 回合续跑器 journal | `[已实现]` | `events.jsonl` 追加 `execution_stalled`，`no_progress_turns=3` | `coordinator_driver.py` 的 `no_progress_turns` 与 `execution_stalled` 事件；计数来自"本回合是否产生新证据"，不是模型自评 |
| 外部观察者快照 | `[已实现]` | `status.json.alerts = ["progress_report_stale", "development_inactivity_diagnostic_not_death"]` | `progress_watch.py` 原子替换 `status.json`，`alerts.jsonl` 记录 raised/cleared 变化 |
| 执行者自报 | `[设计中]` | 结构化 blocker 记录（`kind=blocked_on_unknown_input`、`typed_code`、`minimal_repro`） | 当前执行者 blocker 仍是散文；`[缺口]` 无 schema |

```json
{"at": "2026-11-12T03:10:00Z", "kind": "raised", "alert": "progress_report_stale"}
{"at": "2026-11-12T03:12:30Z", "kind": "raised", "alert": "development_inactivity_diagnostic_not_death"}
{"event": "execution_stalled", "attempt": 14, "no_progress_turns": 3,
 "novel_evidence_count": 0, "max_no_progress_turns": 3}
```

注：`development_inactivity_diagnostic_not_death` 是现有观察者刻意使用的名字——15 分钟无进展
只报"诊断"，不报"死亡"。沉淀层同样不得把它升级成"已确认 bug"。

## 2. 触发（S1）：T1 阈值型，判定者是进程外观察者

```
T1 | judge=off-process watcher (not the driver, not the worker)
condition: no_progress_turns >= max_no_progress_turns (3) AND no declared wait
waive: wait_reason + expected_wait_until not present -> no suppression
verdict: 触发沉淀（不是"确认 bug"）
```

`[已实现]` 抑制条件本身存在（`wait_reason` + `expected_wait_until`，见 `progress_watch.py`）；
`[设计中]` "阈值命中即生成 incident record" 这一步。

反例（本示例**不**触发）：同一 Run 的 Coordinator 在 03:05 写出
`wait_reason=awaiting_reviewer_receipt`、`expected_wait_until=03:20Z`，则 03:10 的陈旧报告不告警。
限制：该声明由被怀疑系统自己产出，"声明了等待"不证明等待合理，所以 incident 里必须把它
连同声明者身份一起记录，而不是当作已排除。

## 3. incident record（S2）：一次实例，不可变

`[设计中]` 目录与文件族；`[已实现]` 其中被引用的字段来源。

```json
{
  "schema_version": 1,
  "incident_id": "inc_example01_14_no_progress",
  "class": "no_progress",
  "typed_code": "execution_stalled",
  "trigger": {"channel": "T1", "judge": "progress_watch", "judge_independence": "off_process_read_only"},
  "binding": {"run": "run_example01", "task": "task_example07", "dispatch": "disp_example07a",
              "attempt": 14, "turn": 14, "terminal_pseudonym": "term_example"},
  "replay_class": "not_admitted",
  "expected": "每回合产生一个 exec 动作或新证据；3 回合内推进到 implementation",
  "actual": {"novel_evidence_count": 0, "no_progress_turns": 3, "actions": ["plan_only", "plan_only", "plan_only"]},
  "contract_ref": {"excerpt": "派发契约原文片段（≤200 字，脱敏）", "sha256": "…"},
  "evidence": [
    {"origin": "driver_events", "path": "<run>/events.jsonl", "offset": 12841,
     "sha256": "…", "grade": "L0", "durable": true},
    {"origin": "watcher_snapshot", "path": "<run>/progress/status.json",
     "sha256": "…", "grade": "L0", "durable": true},
    {"origin": "session_tail", "path": "<run>/transcripts/…tail.md", "sha256": "…",
     "grade": "L1", "durable": false}
  ],
  "unknown_boundaries": [
    "worker 是否已对 allowed_paths 产生写入：未取树级对比，N/A",
    "第 12 回合的启动回执是否为本 attempt：驱动侧无回执"
  ],
  "repro_min_input": "未取得",
  "disposition": {"state": "untriaged", "why": "单次模式，未达聚类阈值"},
  "next_step": "人工/owner 判定是否与 11-13 的同类模式合并；不得自动重试"
}
```

关键点：

- `disposition.state=untriaged` 是**合法终态**。系统可以记录"无人有资格判定"，不得把
  `unknown`、`needs_reconcile` 或"看着像 bug"当成已确认（见主文档 §10 红线）。
- `replay_class` 只说明能否重放，不说明是不是 bug；`unknown` / `needs_reconcile` 都不可重放。
- `evidence[].grade` 必须自洽：`L1` 记录不得出现在"已归档"摘要里；`L0` 需要归档回读 SHA256。

## 4. 第二次出现 → 聚类 → issue 文件（S3）

次日同一 `typed_code` 在另一个 task 上再次出现，两侧 record 都不可变，聚类结果是**派生视图**：

```json
{
  "cluster_key_version": 2,
  "cluster_id": "clu_example_stalled_plan_only",
  "members": ["inc_example01_14_no_progress", "inc_example02_09_no_progress"],
  "key": {"class": "no_progress", "channel": "T1", "stage": "turn_action_selection",
          "typed_code": "execution_stalled", "site": "coordinator_driver.turn_settled",
          "acceptance_criterion": null},
  "severity": {"impact": "task_stalled_human_intervention_required", "unknown_states": 0},
  "review": {"merge_judged_by": "independent_review_session", "verdict": "same_pattern",
             "independence": "different_context_same_operator"},
  "issue_ref": "<archive>/issues/issue_example_stalled_plan_only.md"
}
```

`[设计中]` 聚类与 `issue_ref`；`[缺口]` 无聚类实现。

issue 文件（`issue_example_stalled_plan_only.md`）骨架，只填已确认事实，分析留白：

```markdown
# issue：回合续跑器在 plan-only 动作上耗尽无进展预算

- 状态：open（guardrail: proposed, not merged）
- 首次出现：2026-11-12　最近一次：2026-11-13　出现次数：2
- 影响：任务停在 implementation 之前，需人工介入；无 unknown 状态残留
- 判据来源：派发契约 §验收（sha256 …）；判定者：进程外观察者 + 独立审查会话

## 1. 摘要（30 秒）
连续回合只重述计划、不执行，续跑器按 3 回合阈值正确停止；失败点在"动作选择后没有校验
动作类型"，而不是续跑器本身。

## 2. 背景与预期（原文引用契约片段，≤200 字）

## 3. 时间线（只写已确认事实）
| 时间 (UTC) | 事件 | 证据 |
| 03:06 | attempt 14 turn 12 结算：plan_only | events.jsonl@12841 (L0) |
| 03:09 | turn 13：plan_only，novel=0 | events.jsonl@12903 (L0) |
| 03:12 | turn 14：plan_only，no_progress_turns=3 → execution_stalled | events.jsonl@12960 (L0) |
| 03:12 | 观察者 raised: progress_report_stale | alerts.jsonl (L0) |

## 4. 未填：机制分析
（自动化只能写事实；根因与"哪层该拦住"由审查会话填写，见主文档 §6 的写法约束）

## 5. 未知边界
- 第 12 回合之前是否已有 plan_only：窗口只回溯 3 回合

## 6. 证据与 pins
（path + sha256 + grade；L1 单独列出并标 durable=false）

## 7. 防复发处置（proposed）
见 §5；未合并前本 issue 不得置 closed。

## 8. 待观察/不修复理由（仅在无代码 guardrail 时填写）
```

## 5. guardrail 提案（S5 → 修复循环的输出物）

`[设计中]` 提案结构；`[已实现]` 其引用的既有门禁（独立审查、离线套件、delivery 流程）。

```
grd_example_plan_only_1（代码/契约类）
  target: coordinator_driver 的动作校验：settled 记录为 plan_only 且无 exec 项 -> 立即
          typed code `driver_plan_only_action`，而不是等 3 回合预算耗尽
  acceptance: PYTHONPATH=.:tests python3 -B -m unittest core.test_coordinator_driver
  blast: coordinator_driver.py -> core.test_coordinator_driver（tests/run_blast.sh 选择）
  status: proposed（未改任何代码；合并需独立修改任务 + worktree + delivery 授权）

grd_example_plan_only_2（观察/降噪类）
  target: 观察者告警抑制：仅当 coordinator 报告 contain wait_reason 且未过期时压制
          progress_report_stale；当前行为符合此规则 -> 结论"无需改动，作为已知边界记录"
  status: no_change_recorded（属于 §8 的"有处置但无代码改动"）
```

第二个提案是要点：**不是每条 incident 都能产出代码 guardrail**。允许"记录为已知边界 + 降噪规则"
作为处置，但必须写在 issue 文件里可复核；不允许无声关闭。

## 6. 状态标注核对（本示例范围内）

| 环节 | 状态 | 依据 |
| --- | --- | --- |
| `events.jsonl` / `execution_stalled` / `no_progress_turns` | 已实现 | `swarm/coordinator_driver.py` |
| `status.json` / `alerts.jsonl` / `wait_reason` 抑制 | 已实现 | `swarm/progress_watch.py` |
| 归档清单 + 回读 SHA256 | 已实现（清单级别） | `swarm/evidence_archive.py` |
| L0/L1/L2 分级规则 | 设计中 | `swarm/docs/design/blocking-isolation.md` §3.8（草案） |
| incident record 文件族 | 设计中 | 主文档 §5 |
| 聚类 + issue 文件 | 设计中 | 主文档 §5.4、§6 |
| 定期只读挖掘 / 提案生成 | 设计中 | 主文档 §7 |
| 自动改代码 / 自动合并 | **非目标** | 主文档 §7、§10 |
| 结构化自报 blocker schema | 缺口 | 执行者 blocker 目前是散文 |

## 7. 这个示例明确没有证明的事

- 没有证明任何一次真实 Run 会产生上述字段：本文件是虚构示例。
- 没有证明聚类判据在真实数据上能区分"同一 bug"与"同一错误码的不同 bug"：需要实现后回放验证。
- 没有证明 L0 归档路径可用：归档根目录、回读与脱敏需部署方配置，本文不写私有地址。
