# strict bootstrap live：定向取证清单

本文件是**记录模板与取证清单**，不是验收标准，也不授权任何运行。

- 判定语义只有一个来源：[reliability.md](reliability.md)。状态词（`NOT_RUN` / `NON_HIT` /
  `PARTIAL` / `BLOCKED` / `FAIL` / `PASS`）、报告头字段、逐项表结构都以它的 §8 为准；
  本文件**不定义**状态词，**不新增** PASS 判据，**不构成**第二套验收口径。
- 需要一条新的判定语义时，改动落在 `reliability.md`（由其 owner 批准），不落在本文件。
- 本文只回答一件事：跑一次 strict bootstrap 的 live 验证时，**要留下哪些记录才算取证完整**。
- 运行本身仍受既有授权与门禁约束：本文件被引用不等于允许启动 Agent、创建 Run、写入或部署；
  部署输入（objective、授权文件、provider/模型、`max_workers`、deadline、独立 BOOTSTRAP 根）
  缺失时按缺失处理，不得用示例或历史 attempt 顶替。

层级与门禁见 [strategy.md](strategy.md)；缺口的静态覆盖度与缺口性质（A/B/C）见
[gap-matrix.md](gap-matrix.md)；协议正文见 [strict-bootstrap-protocol.md](../../strict-bootstrap-protocol.md)
与 [coordinator-strict-start.md](../../coordinator-strict-start.md)；动作与槽位表见
[operator-runbook.md](../../operator-runbook.md)。

## 1. 必须写明的两处消歧

### 1.1 `S0–S5` 有两套无关编号

| 写法 | 含义 | 出处 |
| --- | --- | --- |
| `bootstrap S0–S4` | strict bootstrap 的**阶段**：S0 = provision/pinning，S1–S4 = `events/0001`–`0004` 四个固定 marker | `strict-bootstrap-protocol.md` §2–§3、`bootstrap_protocol.EVENTS` |
| `S5`（在人名而非阶段名后面出现时） | 见下：bootstrap 语境里指"同一控制实例之后的准入/发布段"；**不是第五个 marker** | `bootstrap_s5.py`、`strict-bootstrap-protocol.md` §7 |
| `S1`–`S7`（gap-matrix 语境） | 七个 Swarm **场景**：S1 跨域升级、S2 循环委托、S3 上下文饱和、S4 共享状态并发、S5 **token 失控与无终止**、S6 提示注入、S7 下游错误传播 | `gap-matrix.md` §3 |

报告里必须写清用的是哪一套；同一个 "S5" 在两套里指完全不同的事。

### 1.2 marker 链合法不等于协作被验证

人工（或上层 agent）逐条给某个角色 pane 下发命令所得到的 marker 链，只能作为
**D-contract 取证**；它**不得**计入 `reliability.md` §4 的 L-flow / L-collaboration
"自主协作"证据。L-collaboration 的判据不变：至少两个真实 Worker 生命周期重叠、
独立 Reviewer 按固定标准拒绝某版本、Coordinator 有界返工、单写入者串行集成、
集成后重跑（`reliability.md` §4 L-collaboration）。

驱动者是谁、发了几条命令、每条命令对应哪个 marker，都是必须记录的事实；但这些事实只改变
"D-contract 取证是否完整"，不改变任何 L 层判据。

## 2. 报告头

按 `reliability.md` §8 的表头填，另加 bootstrap 专有的四项（其余字段定义以 §8 为准）：

| 专有项 | 记录什么 |
| --- | --- |
| 固定源码 | `git rev-parse HEAD` 的完整 SHA，以及它是否同时含待验各条线的 tip |
| attempt 标识 | `attempt_id`、BOOTSTRAP 根的绝对路径、承载文件系统（`findmnt -T` 输出，不用 `df`） |
| 两个 gate role | 每个 role 的 `provider`、pane 的 `terminal` / `incarnation` / `pane_key`、provider session |
| 驱动方式 | 谁在驱动、驱动者属于哪个 pane、每条命令的下发时间与对应 marker（用于 §1.2 的归类） |

## 3. 阶段记录

逐阶段一行；每行的"证据"必须给绝对路径 + SHA256，缺失就写缺失。

### 3.1 S0（provision / pinning / arm）

- `attempt-binding.json`：`paths` 是否为完整槽位映射、`fixed_inputs` 五项 Ref 是否逐个可读、
  `authorization_refs` 是否等于业务任务文件里的清单。
- `registration.json`：两个 role 的 `process` 身份字段与 `provider` 声明。
- `provision` 与 `arm` 的原始回执；`arm` 的执行者及其所属进程树（见 §3.6）。
- `owner.json` 的 Ref；S0 的 skill-read evidence 是谁产出、由谁独立复算。

### 3.2 S1–S4（四个 marker）

每个 marker 记：路径 + SHA256、`consumes` 指向上一个 marker 的实际字节是否一致、
producer、以及该阶段的产物（caller / observation / contract fields + review / readiness + review）。

- S3 的两份审查（fields 与 contract）要记**审查者是否独立于生产者**、`notes` 是否非空，
  以及候选路径与最终路径不同、字节相同。
- S4 要记探针清单是否为空（`file_tool_evidence_paths` 约定）以及 `required_refs` 的实际值。

### 3.3 S5（同一控制实例之后的准入与发布）

按 `coordinator-strict-start.md` 的 8 步逐条记：命令、执行者 role、输入/输出 Ref、
以及该步是否在 S4 绑定之下。至少覆盖 request v5 生成、`strict-start-prepare`、
独立 `strict-config-review`、lifecycle v2 准备、config publish、两个 wait、原生 session gate、
`strict-start-publish --ready-sha256`（必须是 Operator 亲自审查过的真实 `ready.json`）。

任何一步没有产物就如实写"未产出"，不要用后续步骤的产物反推它存在。

### 3.4 时间线（三个时限互相独立）

| 时限 | 必须记录 |
| --- | --- |
| context 最大年龄（1800s） | 起点（caller 的 `checkedAt`）、每次复验时刻、到期时刻、以及到期后的处置 |
| 握手窗（900s） | `startup_window` 的 `prepared_at` 与实际截止 |
| gate TTL（180s） | gate 发布时间、TTL 终止时刻 |

过期不续期、不重放；记录里要能看出"到期 → 停下 → 发了 STOP"这条链，而不是只有最后状态。

### 3.5 停止、对账与归档

- 停止的唯一形式是 STOP；记录 STOP 的 Ref、发布者、以及此前是否还有在途 intent。
- 对账只按原 pin 查，不重发；记录 `inspect`/`query` 的返回与时间。
- 归档要带索引（host、账号、源工作目录、解析后的归档绝对路径、承载文件系统、逐文件 SHA256），
  并**读回比对**；索引里写明哪些属于 in-flight、哪些是退役包。

### 3.6 驱动者归属

一眼能看出来的事实：每条命令的调用者进程是否位于它所操作的那个 role 的进程树内。
"借用身份变量"或"从外部 pane 直接驱动"必须在记录里显式标注为借位，并说明它是否被
拒绝（例如角色身份核验类的错误码）。这类拒绝是证据，不是障碍。

## 4. 已知失败形态（用于确定"要记什么"，不用于判分）

下面这些在真实运行里出现过；记录时必须给出**原始错误码字符串**与当时的只读状态输出，
判定仍按 `reliability.md` §8：

- `caller_stale_or_future`：S1 之后 context 超过 1800s，后续入口全部 fail closed。
- `bootstrap_operation_unverifiable`：错误码被安全折叠后的形状；真因须从只读状态检查里取。
- 角色身份/进程树不匹配类的拒绝（`bootstrap_peer_role_unverifiable` 一类）。
- 存储/端点类失败（端点的私有父目录与长度约束、存储探测的排他发布）。
- 候选/最终路径混淆（把 owner 的最终槽当候选写入）。

记录格式：原始码 + 触发它的输入/时刻 + 只读状态的完整输出 + 是否已发 STOP。

## 5. 结论与责任

报告末尾分别给：**阶段链结论**（按 §8 状态词）、**未覆盖项**、**下一步的执行者角色**
（不是"待修复"，而是"谁在什么授权下继续"）。

本文件维护者：测试/验收标准维护者。运行结果归部署方的私有归档，不提交到本仓库。
