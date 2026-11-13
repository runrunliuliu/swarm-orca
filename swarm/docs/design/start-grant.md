# Run 启动凭据（start grant）：把校验放到特权被行使的地方

状态：**方案草案；M0（契约定稿）已完成，实现未开始**。§2 与 §4.1 是 M0 的产出：记录形状、zod 草案、
拒绝码、判定顺序与可执行断言。本文只给设计、开发计划、清理计划与文档更新计划，**不构成**实现、部署、重启、
启动 Agent、迁移既有 attempt/Run 或放宽任何现有 gate 的授权。与
[strict-bootstrap-protocol.md](../../strict-bootstrap-protocol.md) 冲突时，现行协议仍是规范；
本文的定位是**替换**它，不是解释它。

替代关系：[strict bootstrap liveness](strict-bootstrap-liveness.md) 记录了 D1–D3 与 P0–P3。
P0（失败分类闭合）已完成并保留；**P1–P3 由本文的 M1–M4 取代**。P2 的"门数与权限相称"在本文里
升级为默认路径而不是可选优化。

## 0. 一页结论

- **目标不变**：让"启动一个 Run 的授权"不能由将要执行它的 Agent 自己制造。（这条保证**以 mint 者与
  执行者分离为前提**。若 §8 决策 5 答"不要求分离"，能主张的只是"不能静默制造"：每次 mint 带活身份、
  可归因。两个说法不能混用，§7 与 §2.6 都按这一条写。）
- **手段替换**：从"证据向上流、每步重新验证"换成"**凭据向下流、只在特权点校验**"。方向定了，
  大半机制就不需要了。
- **一处结构性错误**：现行门禁全部落在 `create` 之前，而伤害发生在 `create` 之后（worker）。
  strict 结束于 `created`，之后 worker 怎么派发它一概不管。
- **一条可核验的事实**：`max_workers` —— 用户唯一明确指定的数 —— **在 Orca 里不存在**
  （`orca/src/main/runtime/orchestration/db/runs/run-create.ts:15` 的 `createRun` 只收 objective、
  coordinator 身份和可选的 strict authority；`maxConcurrent` 只存在于旧 coordinator-loop
  API，`orca/src/main/runtime/orchestration/coordinator.ts:22,55,237`）。今天它是提示词里的一句话。
- **一条诚实边界**：三个校验点（create / spawn / delivery）里只有两个能被强制。计数是服务端事实，
  仓库范围在 spawn 参数上可见；"worker 不写到仓库外"今天**没有** OS 级沙箱兜底（pi 无 sandbox 面；
  `--writable-roots` 只对 trae 生效且实现为 `--add-dir` 提示，
  `orca/src/main/runtime/rpc/methods/orchestration/worker/worker-start-validation.ts:60`、
  `orca/src/main/runtime/trae-worker-workspace-write.ts:106`）。本文把它降级为**可审计的声明**，
  由交付阶段的 `git status --porcelain` 兜底，不假装已强制。§2.3 里同样只有声明的还有 `spend`。

成本样本（同一宿主、只读复核任务、`max_workers=8`、Coordinator 与 Operator 均为 pi，实测）：

| 指标 | 数值 |
| --- | --- |
| 草稿 → 首个 Worker 请求 | **17 min 09 s** |
| 其中 S0–S5 | 11 min 16 s |
| 角色空闲占比（两侧 transcript） | ≈82% |
| 可证明的空转（下一份输入已存在但无回合在跑） | ≈363 s |
| attempt 内持久文件 | **80**（扣除 staging/probe/锁仍 69） |
| 两侧模型调用 | ≈100（Coordinator 45 / Operator 55） |
| 业务结论 | 0 |

这不是"慢"，是**门的位置错了**：付了 17 分钟买了一张"创建前的记录"，而 worker 不受控。

## 1. 现行设计错在哪（诊断结论，不是风格意见）

1. **保护的是启动记录，不是启动之后。** `created.json` 之后没有任何一条与授权绑定的强制点。
   8 个 worker 并发、每条 worker 落在哪个仓库，全部由 Coordinator 自己决定。
2. **唯一指定的数字无人检查。** 见 §0。
3. **双进程公证是自签的。** S3/S4 的"独立复核"建立在 Operator 与 Coordinator 是不同授权主体上；
   实际部署里两者同 provider、同 model、同 policy、同一个外层驱动。同一个模型重读同一批已 pin 的
   字节并写下 `approve`，`identity_verified:false`。它买到的是**审计叙事**，不是独立判断。
4. **门的时限比传输层还短。** gate TTL 180 s < 实测回合唤醒延迟 30–180 s，所以模型被迫写
   `op-*.sh` 这类批处理脚本在单回合内跑完多步。这是用户态在给协议打补丁。
5. **推进责任没有所有者。** 只读轮询预算以回合为单位（`swarm/observation_budget.py:23`
   `TURN_END_SECONDS = 60`；超时在 `swarm/bootstrap_control.py:799-811` 被映射成干净的
   `pending`），于是每个阶段跳转必然吃掉一个模型回合。**这是 82% 空闲的直接来源。**

结论：现行方案把一个**幂等 + 取证**问题当成了**授权**问题来做，于是每一层都要 durability barrier，
而传输层是"唤醒一个 LLM"。三个前提里两个在当前部署下不成立（威胁模型、职责分离），
剩下的那个（幂等）一个 `flock` + `O_EXCL` + 一次原生查询就能拿到。

## 2. 契约（M0 定稿）

M0 的产出就是这一节。它**不含实现代码、不授权实现**，只把上一版的三段草图（字段表 / 不变量 / 三个校验点）
展开到"照着写能实现、写完能被断言"的粒度：§2.1–§2.3 记录与字段，§2.4 不变量，§2.5 判定顺序，
§2.6 拒绝码，§2.7 与现行表的对照，§2.8 计数口径，§2.9 无副作用要求。§2.10 列出本节相对上一版的修正，
**需要 owner 复核**。

### 2.1 记录形状：三张表，插入即不可变

沿用 `strict_run_coordinators` 的既有做法（一行 = 一段 JSON receipt，zod 在写与读两侧各校验一次），
不新造序列化格式：

| 表 | 键 | 内容 | 可变性 |
| --- | --- | --- | --- |
| `start_grants` | `grant_id` PK | 一行一条 `StartGrant` receipt | 不可变：`BEFORE UPDATE`/`BEFORE DELETE` 触发器 `RAISE(ABORT)` |
| `start_grant_runs` | `grant_id` PK `REFERENCES start_grants(grant_id)`，`run_id` UNIQUE `REFERENCES runs(id)` | `{bound_at, bound_authority}` | 不可变、只增 |
| `start_grant_revocations` | `grant_id` PK | 一行一条 `StartGrantRevocation` receipt | 不可变、只增 |

三条理由，每条都对应一个会写错的版本：

1. **撤销是一次插入，不是一次更新。** 上一版把 `revoked_at` 写成 grant 的字段，那会让 grant 行可变，
   而 `strict_run_coordinators` 的全部价值恰恰在 `policy is immutable` 触发器
   （`db/schema/strict-coordinator-schema.ts:3`）。拆成撤销表后 grant 仍只增，撤销自带时间与执行者身份。
2. **`run_id` 要有 UNIQUE。** 一个 Run 若能被两条 grant 覆盖，交付期无法回答"这次写入是谁批的"。
   一个 grant 能被几个 Run 用是 §8 决策 3（**已定：1**）：若将来改成 N，`start_grant_runs` 的 PK 要变成
   `(grant_id, run_id)`，且 `start_grant_already_bound` 这个码随之删除。**一处决策只改一个键**，
   不能两处各留一半。外键还让 §2.6 的 `start_grant_unknown` 在 spawn 侧不可达（spawn 按 `run_id` 查绑定，
   不存在的 `grant_id` 写不进来）。**两个驱动都启用外键**：`node:sqlite` 的 `DatabaseSync` 默认
   `enableForeignKeyConstraints: true`（实测 `PRAGMA foreign_keys` → 1），bun 驱动显式
   `PRAGMA foreign_keys = ON`（`orca/src/main/sqlite/bun-sqlite-database.ts:86`）。即便如此，读侧仍要
   显式 fail-closed：`readGrantForRun` 发现"绑定行在、grant 行不在"时抛 `start_grant_invalid_record`，
   不返回 `undefined`——外键是驱动行为，不是本模块的契约。
3. **新建 worktree 的归属不另开表。** spawn 时要判定的 worktree 可能还不存在（`--worktree new-child`）；
   它的归属从既有行推导——本 Run 的一次 dispatch 在 `worker_dispatches.worktree_id` 或
   `worker_terminal_resources.worktree_id` 里写了它。M2 必须先验证两条 spawn 路径都写了这一列（§2.8），
   否则这条推导是空的。

### 2.2 `StartGrant` zod 草案

```ts
// src/main/runtime/orchestration/start-grant-policy.ts（Orca 侧新增；zod 是唯一格式，读也要 parse）
import { posix } from 'node:path'
import { z } from 'zod'
import { requiredString } from '../../../shared/rpc-contract/rpc-param-primitives' // 同 orchestration-worker-start-params 的用法
import { strictTerminalAuthoritySchema } from './strict-coordinator-policy'

const sha256 = z.string().regex(/^[0-9a-f]{64}$/)
const Ref = z.object({ path: z.string().min(1), sha256 })
const canonicalAbsolutePath = z
  .string()
  .min(1)
  .refine((p) => p.startsWith('/') && posix.normalize(p) === p, 'must be an absolute canonical path')

const RepoScope = z.object({
  repoId: z.string().min(1),
  // null = 该 repo 的任意 worktree；非 null = worktree **id** 白名单（不是路径，理由见 §2.10）
  worktreeIds: z.array(z.string().min(1)).min(1).max(64).nullable()
})

export const StartGrant = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('start_grant'),
    grantId: z.string().uuid(),
    objectiveText: z.string().min(1).max(16_384),
    // 必须等于 hashCanonical(objectiveText)；比较在调用方做（rpc/orchestration-mutation-receipt.hashCanonical）
    objectiveHash: sha256,
    taskSource: Ref,                          // 审批原文（path + sha256）；仅溯源
    authorizationRefs: z.array(Ref).max(32),  // 可为空：授权原文留在 mint 者一侧
    maxWorkers: z.number().int().min(1),      // 不含 Coordinator；无上限常量，实际数字由部署给定
    repos: z.array(RepoScope).min(1).max(32),
    writableRoots: z.array(canonicalAbsolutePath).max(32), // 仅审计，不强制（§2.3）
    spend: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('none') }),
      z.object({ kind: z.literal('capped'), limitUsd: z.number().positive() })
    ]),                                       // 声明，不强制（§2.3）
    deadline: z.string().datetime({ offset: true }),
    minter: strictTerminalAuthoritySchema,    // 复用既有身份词表，不新造
    mintedAt: z.string().datetime({ offset: true }),
    executionAuthorized: z.literal(false)     // 与仓库既有记录的约定一致
  })
  .superRefine((grant, ctx) => {
    // deadline > mintedAt；repos 的 repoId 不重复；writableRoots 不重复
  })

export const StartGrantRevocation = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('start_grant_revocation'),
  grantId: z.string().uuid(),
  revokedAt: z.string().datetime({ offset: true }),
  authority: strictTerminalAuthoritySchema,   // 谁撤的（活身份），只用于审计归因
  reason: z.string().min(1).max(2048),
  executionAuthorized: z.literal(false)
})

// 新 RPC 的参数形状：grant 必填（新动词 + 必填字段，老服务端不会静默忽略）
export const RunCreateGrantedParams = z.object({
  objective: requiredString('Missing --objective'),
  from: requiredString('Missing coordinator terminal'),
  grant: requiredString('Missing --grant')
})
```

三处是刻意的选择：

- `minter` 复用 `strictTerminalAuthoritySchema`（`orchestration/strict-coordinator-policy.ts:7` 的
  `terminalHandle / paneKey / processIncarnation / launchTokenHash / hostScope`），因为
  `requireStrictTerminalCaller` 已经产出这个形状。另造一套身份字段会把"活身份"降级成"声明身份"。
  **它由服务端写入，客户端不得提交**（M4 实现时更正）：`launchTokenHash` 是所有回执都刻意不返回的，
  客户端永远造不出这个字段；所以 mint 的入参用 `startGrantSchema.omit({minter})`，记录里出现
  `minter` 一律按 `start_grant_invalid_record` 拒绝，而不是静默忽略。
- 没有 `revokedAt` 字段（§2.1）；没有 `maxWorkers: 0`（那会让 Run 永远起不了 worker，是死锁不是限制）。
- `taskSource` / `authorizationRefs` 不进任何判定式，只进审计输出。写不出判定式却看起来像门的字段，
  最后都会被当成门来引用。
- **命名用 camelCase，是因为这张表与 `strict_run_coordinators` 同库同风格**：后者的 `authority` 今天就是
  `terminalHandle/paneKey/processIncarnation/launchTokenHash/hostScope`。Python 侧 bootstrap 协议里的
  `execution_authorized:false` 属于那套 JSON，不要把两种约定混进同一条 receipt。
- **RPC 名与 CLI 名分开写**：`orchestration.workerStart` 是 RPC 方法，`orca orchestration worker-start`
  是 CLI 子命令。文档与测试名混用这两个会让拒绝码挂到不存在的方法上。

### 2.3 字段 → 列 → 能不能强制

| 字段 | 存储 | 强制点 | 可强制？ |
| --- | --- | --- | --- |
| `grantId` | `start_grants.grant_id` | create/spawn 按 id 读取记录 | **是** |
| `objectiveText` + `objectiveHash` | receipt | create 时 `hashCanonical(params.objective) === objectiveHash` | **是**（相等性） |
| `taskSource`, `authorizationRefs` | receipt | 无 | 否（溯源；"批准内容对不对"由 mint 者负责，见 §7） |
| `maxWorkers` | receipt | spawn 事务内计数（§2.8） | **是**（服务端计数） |
| `repos` | receipt | spawn 事务内比对已解析 worktree 的 `repoId`/`worktree id` | **是** |
| `writableRoots` | receipt | 交付期 `git status --porcelain` 比对（§2.5 第三行） | **否**，仅审计 |
| `spend` | receipt | 无 | **否**，仅声明 |
| `deadline` | receipt | create 与 spawn 的事务内，用运行时进程时钟比较 | **是** |
| `minter` | receipt | 记录 + 审计；是否与执行者比对取决于 §8 决策 5 | 记录**是**；分离**条件** |
| 撤销 | `start_grant_revocations` | create 与 spawn 的事务内做存在性查询 | **是** |

一句必须写死的边界：**`writableRoots` 与 `spend` 是声明，不是门。** 前者的理由在 §0（`--writable-roots`
只对 trae 生效、实现是 `--add-dir` 提示，pi 没有 sandbox 面）；后者是这条路径上没有可执行的用量判定点。
把它们写成门，比不写更糟：读者会以为已经被挡住。

### 2.4 六条不变量（I4 修订）

- **I1 单向凭据**：grant 只向下传。任何角色都不能铸造、修改、派生出第二份；`start_grants` 无 UPDATE 路径。
  撤销是**新增一条撤销记录**，不是修改 grant。
- **I2 唯一判定点**：每个特权点恰好一个判定函数，且判定必须发生在**第一个持久写之前**。
  不允许"先做再回滚"，也不允许靠 teardown 兜底——`failed-worker-start-teardown.ts` 的存在本身就说明
  回滚会失败。
- **I3 计数在服务端**：`maxWorkers` 是同一事务内的服务端计数，不是 agent 自律（§2.8 给出计数口径）。
- **I4 幂等键不重复发明（修订）**：create 以 `grant_id` 为幂等键——同一 grant + 同一协调者活身份 +
  同一 objective 的重复 create 返回原 Run（`effectsApplied:false`），不产生第二个 Run；
  spawn 沿用既有的 `mutation_receipts` / `--retry-request` 身份，grant **不提供第二个幂等键**。
- **I5 服务端时钟**：deadline 与 revoke 由运行时进程时钟判定（不是 SQLite 的 `datetime('now')`，
  也不是 agent 自报的时间）；agent 不能续期、不能回拨。
- **I6 未知不重放**：结果未知时按 `grant_id` 查原记录；不重发、不换路径、不生成新字节。

### 2.5 三个校验点：判定顺序

**第零点 · mint（只在这里产生凭据，不在任何地方修改它）**

grant 记录住在 Orca 的库里，由 `orchestration.startGrantMint` 写入；它要求的调用者证据与今天的
`runCreateStrict` 同一级（`requireStrictTerminalCaller`），写进 `minter` 的就是这份活身份——
**是服务端写，不是客户端申报**（理由见 §2.2）。
M4 的 Python `mint`（`swarm/start_grant.py`）不持有额外的权限：它只是**决定并提交**（以及用
`publish_new` 写一份自己的溯源副本）。所以“谁能 mint”与“谁能 create 一个 strict Run”今天是一样的；
差别只在 mint **不产生 Run**，而 create 只能消费已存在的 grant。执行者能不能自己 mint，是 §8 决策 5。

**第一点 · create（`orchestration.runCreateGranted`，新动词；参数见 §2.2）**

1. zod parse 参数。`grant` 缺失即 `invalid_argument`（参数层，不是 grant 码）。无 I/O。
2. `requireStrictTerminalCaller` 取得协调者的活身份（原生查询）。这条既有门不变，失败码不变。
3. `db.createGrantedRun({ objective, coordinator, grantId })`，在 `createRun` 已有的
   `BEGIN IMMEDIATE`（`db/runs/run-create.ts:32`）里按序判定：
   a. 读 `start_grants`：不存在 → `start_grant_unknown`；receipt 不能 parse 或 `objectiveHash` 与
      `objectiveText` 不自洽 → `start_grant_invalid_record`。
   b. `start_grant_revocations` 有行 → `start_grant_revoked`。
   c. `Date.now() > Date.parse(deadline)` → `start_grant_expired`。
   d. `hashCanonical(params.objective) !== objectiveHash` → `start_grant_objective_mismatch`。
   e. `start_grant_runs` 已有该 grant 的绑定：
      - 同一协调者活身份 + 同一 objective hash → **返回原 Run**（幂等，`effectsApplied:false`，无写入）；
      - 否则 → `start_grant_already_bound`。
   f. （§8 决策 5 的答案决定是否启用）协调者活身份 ≡ `minter` → `start_grant_self_minted`。
   g. 只有 a–f 全过才写：`runs` 行 → 既有 `pinStrictCoordinator` → `start_grant_runs` 行 → `COMMIT`。

   为什么 f 在 g 之前、为什么 e 在 f 之前：所有判定都在第一个写之前，事务存在的意义只是让"读绑定"
   与"写绑定"不能交错（两个 create 并发时只有一个能拿到 `BEGIN IMMEDIATE`）。

**第二点 · spawn（两条插入点，同一个共享判定）**

| 路径 | hook 的准确位置 | 事务 |
| --- | --- | --- |
| `orca orchestration worker-start`（RPC `orchestration.workerStart`） | `createStartingWorkerDispatch`：`BEGIN IMMEDIATE`（`db/worker-dispatch/worker-dispatch-start.ts:46`）之后、**第一条写入之前**——也就是 `:48-70` 的 `mutation_receipts` 插入、以及随后的 `createTask` 与 `insertStartingDispatchContextRow`（`:137`）之前 | 有 |
| `orchestration.dispatch`（收养既有终端，`dispatch-methods.ts:29`） | `createDispatchContext`：`SAVEPOINT`（`db/dispatch-context/dispatch-context-store.ts:62`）之后、`claimDispatchContextRow`（`:64`）之前 | 有 |

**这一格写错就没有无副作用。** 该事务里的第一条持久写不是 dispatch 行，而是 `mutation_receipts`
（`:48-70`）；`--spec` 时随后还会建 Task。所以"判定点在 dispatch 插入之前"是不够的表述：
判定必须紧跟 `BEGIN IMMEDIATE`，早于 `:48`。

两条路径都调用同一个 `assertSpawnAdmissible(db, { runId, repoId, worktreeId })`，判定顺序：

1. 按 `runId` 查 `start_grant_runs`：
   - 有绑定：receipt parse 失败 → `start_grant_invalid_record`，否则继续；
   - 没有绑定：该 Run 是 strict Run 且 grant-required 开关已开 → `start_grant_required`（fail-closed）；
     开关关闭（迁移窗口）→ 按现状放行，并把"未绑定"记进诊断（窗口何时关闭是 §8 决策 4）。
2. 撤销 → `start_grant_revoked`；`Date.now() > deadline` → `start_grant_expired`。
3. 仓库范围，按三种情形分别判：
   - 已解析 worktree（`--worktree current` / `id:…`）：`repoId` ∈ `repos`，且 `worktreeIds` 为 null
     或包含该 worktree id；
   - 新建 worktree（`new-child` / `new-top-level`）：判定时**还没有** worktree id，所以
     **只有 `worktreeIds: null` 的 repo 级授权才允许新建**，且目标 repo
     （`params.repo ?? 协调者 worktree 的 repoId`）必须在 `repos` 内；`worktreeIds != null` 时新建一律
     拒绝——否则"枚举了 worktree 却又能新建"就是白名单漏洞；
   - 本 Run 的一次 dispatch 已经创建的 worktree 视为在范围内（§2.1 第 3 条）。
   不满足 → `start_grant_repo_not_granted`。
4. 远端：该事务携带 federation 参数时 → `start_grant_remote_unsupported`。**这个码今天不可达**：
   唯一来源 `--on` 已在更早的 `workers.ts:63` 被 `strict_coordinator_required` 拒绝。保留它的理由不是
   "现在会命中"，而是"若将来放宽那道门，计数不会跟着静默失效"——这种码必须在表里说明自己是防御性的，
   否则读者会以为它已经是一条生效的路径（§2.6 有同样的标注）。
5. 计数：该 grant 覆盖的活跃 dispatch 数 `< maxWorkers` → 否则 `start_grant_worker_limit`，拒绝体里附
   被计入的 `dispatch_id` + `status` + `updated_at`（只给 id 无法判断是不是 stale 行）。
6. 只有 1–5 全过，才按既有顺序写：mutation receipt → Task（`--spec` 时）→ dispatch 行 → Task 状态迁移。

`worker-start` 不加 `--grant` 参数：grant 由 Run 推导（§2.10 第 1 条）。判定点在 `:48` 之前，
因此被拒的第 9 次 spawn 不会创建终端、不会创建 Task、也不会留下 mutation receipt。

**第三点 · delivery（不是门）**

1. `readlink -f` 解析 worktree 真实路径；`findmnt -T` 记录承载文件系统（AGENTS.md 的既有要求）。
2. `git -C <path> status --porcelain=v1 -z --untracked-files=all`；对每个子模块再 `git submodule foreach`
   枚举（超级仓库只显示一行脏标记）。
3. 把每个变更路径 `realpath` 后与 `grant.writableRoots` 做前缀比对。
4. 输出 finding `start_grant_write_outside_declared_roots`（路径清单 + 根清单），非零退出码。
5. 看不见的东西要说明：仓库外写入（`/tmp`、`$HOME`）、其它仓库、被删除后重建的同名文件、
   以及"文件写过又恢复原样"。这一行只提供审计叙事，不改变任何记录。

### 2.6 拒绝码表

| 码 | 判定点 | 触发 | 若不存在会有人受损的具体后果 |
| --- | --- | --- | --- |
| `start_grant_unknown` | create | 引用的 `grant_id` 在 `start_grants` 里没有 | 批准号变成装饰：create 照样成功，审计无法区分"已批准"与"打错字" |
| `start_grant_required` | spawn | strict Run 没有 `start_grant_runs` 绑定，且 grant-required 开关已开 | "唯一启动凭据"不能只靠"旧动词标 deprecated"：旧 `runCreateStrict` 仍能创建未绑定的 strict Run，它的 spawn 不受 cap 与 repo 范围约束——模型换一条 create 路径就绕开整套机制 |
| `start_grant_invalid_record` | create, spawn | 行存在但 receipt 不能 parse，或 `objectiveHash` 与 `objectiveText` 不自洽 | 损坏的记录若被当成"没有 grant"，就走到"未绑定 = 不计数"分支，cap 静默消失（fail-open） |
| `start_grant_expired` | create, spawn | `Date.now() > Date.parse(deadline)` | owner 离开、任务被取代之后，一份旧批准继续授权新工作，且 agent 无法自证时间是诚实的 |
| `start_grant_revoked` | create, spawn | `start_grant_revocations` 有行 | 撤销只是建议，owner 无法阻止新的 Run / Worker |
| `start_grant_objective_mismatch` | create | `hashCanonical(params.objective) !== objectiveHash` | 用 A 的批准启动 B——系统里没有第二个地方比较这两个字符串 |
| `start_grant_already_bound` | create | 该 grant 已绑定 Run，且不是同一协调者 + 同一 objective | 一份批准被复制成 N 个 Run，每个各带一份 `maxWorkers`，上限乘以 N；交付期也无法回答哪个 Run 属于这份批准 |
| `start_grant_worker_limit` | spawn | 本 Run 活跃 dispatch 数 ≥ `maxWorkers` | owner 唯一明确指定的数字无人执行（实测样本：8 个并发 worker，≈363 s 可证明空转、0 条业务结论） |
| `start_grant_repo_not_granted` | spawn | 已解析的 `repoId`/worktree id 不在 `repos` 内 | worker 写到 owner 没批准过的仓库，交付审计无法把它归到任何批准上 |
| `start_grant_record_conflict` | mint, revoke | 同一个 id 收到**不同**的第二份内容（批准记录或撤销理由） | 一个 grant_id 下存在两份不同的批准，审计与计数都无法回答"这个 Run 究竟是哪一份批的" |
| `start_grant_remote_unsupported` | spawn（federation 插入，**防御性、今天不可达**） | 事务携带 federation 参数；唯一来源 `--on` 已被 `workers.ts:63` 更早拒绝 | 一旦那道更早的拒绝被放宽，远端 worker 会让计数与仓库范围同时静默失效；此码保证"放宽那道门不会顺带放宽计数" |
| `start_grant_self_minted` | create | 协调者活身份 ≡ `minter`（**条件码**，取决于 §8 决策 5） | 执行者给自己签发批准，整套设计的前提当场失效 |

**刻意删除的码**（M0 的验收标准是"写不出后果就删"，这里删的理由是"写得出后果但没有判定点"）：

- `start_grant_spend_exceeded`：花钱会有后果，但这条路径上没有可执行的用量判定点。写出来就是一个**假的**门，
  所以 `spend` 降级为声明（§2.3）。
- `start_grant_write_outside_roots`（作为 RPC 拒绝码）：交付期不是门。它没有被删掉，而是降级为审计 finding
  `start_grant_write_outside_declared_roots`，只出现在交付报告里。

**补上的两个码（上一版没有）**：

- `start_grant_required`：**这是评审发现的真缺口**。上一版把"strict Run 没有 grant 绑定"当成"不是受
  grant 约束的 Run → 放行"，等于在迁移窗口里保留了一条完整的绕过路径。现在它是一条会命中的码，
  开关的默认值与截止时间由 §8 决策 4 决定，但"没有绑定 = 放行"这个默认已经不是唯一选项。
- `start_grant_remote_unsupported`：上一版的 `repos`/`maxWorkers` 判定默认"所有 worker 都在本机"，
  而 federation 插入点是真实代码路径。它在表里被标成**防御性**，因为它今天确实不可达（见 §2.5 第 4 步）——
  一个不可达却被描述成生效的码，与一个没有判定点的码一样会误导读者。

**只出现一个判定点的码**：`start_grant_unknown` 只在 create 出现。spawn 按 `run_id` 查绑定、不接
`grant_id` 参数，所以 spawn 侧不会"引用一个不存在的 grant"。外键在两种驱动上都是开的（`node:sqlite`
默认启用，bun 驱动显式 `PRAGMA`），所以这个状态在正常写入下不可达；读侧仍显式判定
"绑定行在、grant 行不在 → `start_grant_invalid_record`"，因为外键是驱动行为而不是本模块的契约。

### 2.7 与 `strict_run_coordinators` 的对照

| 维度 | `strict_run_coordinators`（现状） | `start_grants`（本方案） |
| --- | --- | --- |
| 键 | `run_id`（Run 已存在） | `grant_id`（Run 尚不存在） |
| 写入时机 | create 事务内，凭调用者的活身份 | mint（先），create 只消费 |
| 内容 | authority 五字段 | objective + 上限 + 范围 + deadline + minter + 溯源 |
| 可变性 | 不可变（UPDATE/DELETE 触发器） | 不可变；撤销走独立只增表 |
| 基数 | 每 Run ≤1 | 每 grant ≤1 Run（§8 决策 3）；每 Run ≤1 grant（UNIQUE） |
| 谁能写 | 任何活 strict caller（create 时） | minter（mint 时）；create 只能引用 |
| 谁读 | dispatcher fence + create 触发器 | create/spawn 的事务内（新增）；fence 仍读它做身份判定 |
| 失败码 | 一个 `strict_coordinator_required` + reason | `start_grant_*` 按原因分码 |
| 迁移 | 已上线，无迁移 | 一次 migration + 三张新表 |

这张对照表同时是 §8 决策 1 的技术证据：该表的主键是 `run_id` 且 `REFERENCES runs(id)`，而 grant 必须
**先于** Run 存在。把 grant 字段扩进这张表，等于要求主键可空或允许无 Run 的行——那不是扩列，是一次
换表。反过来，选新表则可以在不动 `strict_run_coordinators` 任何语义的前提下并存。

### 2.8 `max_workers` 到底数什么

计数口径写死为：

```sql
SELECT COUNT(*) FROM dispatch_contexts d
JOIN start_grant_runs g ON g.run_id = d.run_id
WHERE g.grant_id = ? AND d.status IN ('pending', 'dispatched')
```

- 活跃 = `pending` / `dispatched`；已结束 = `completed` / `failed` / `circuit_broken`
  （`db/schema/create-graph-tables-sql.ts:164-165`）。`worker_done` 经 worker-report-settlement 调
  `settleActiveDispatchesForTask`（`db/dispatch-context/dispatch-completion.ts:43`），把行迁到
  `completed` 或 `failed`，计数随之下降。
- 计数包含：`--spec` 新建 Task 的 dispatch、`--terminal` 复用、`orchestration.dispatch` 收养的终端；
  **不含** Coordinator 本身（它不是本 Run 的 dispatch 行）。
- **两条插入点**（上一版漏掉的事实）：`createStartingWorkerDispatch`（`worker-start`）与
  `createDispatchContext`（`orchestration.dispatch`，`rpc/methods/orchestration/runs/dispatch-methods.ts:172`）。
  strict Run 上 `orchestration.dispatch` 是**允许**的（只拒绝协调者自己的终端），
  所以只做 `worker-start` 会让 cap 被一次收养绕开。
- 计数是"已记录"，不是"还活着"：worker 进程死了但行仍是 `dispatched` 时计数偏高 → 多拒（安全方向）。
  所以 `start_grant_worker_limit` 必须附被计入的 `dispatch_id` + `status` + `updated_at`，让 operator 能收敛。
- 一个 Run 只能被一个 grant 覆盖（UNIQUE），因此"这个 dispatch 属于哪个 grant"永远有唯一答案。
- **数的是 supervised dispatch，不是 worker。** `orchestration.dispatch` 可以产生没有 `worker_dispatches`
  行的 context-only dispatch：它计入 cap，却不对应"有一个 agent 在跑"。所以这个上限既不是 worker 数，
  也不是进程数（§7）。

**不声称**（进 §7）：cap 不覆盖 `terminal.create`。`isStrictCoordinatorEffect`
（`rpc/strict-coordinator-effect-scope.ts`）只包含 orchestration mutation、`orchestration.check`、
`terminal.send` 与 agentSession 写；`terminal.create` 不在其中。所以协调者仍可以开第 9 个终端并在里面
跑 agent，只是它不成为 supervised dispatch、不进计数。本文不把它写成门（那要改终端创建这条所有人都用的路径），
只在交付审计里数活跃 agent 终端与 `worker_terminal_resources`，把差异报出来。

### 2.9 无副作用要求（逐点断言清单）

总规则：**拒绝只能发生在第一个持久写之前**；"先写后删"不算无副作用。
`worker-start` 的第一个持久写是 `mutation_receipts`（`worker-dispatch-start.ts:48-70`），所以
"没有残留"这句话只有在 hook 早于 `:48` 时才成立——S1/S3/S8 都要断言这张表不变。

- **create 被拒**：`runs` 行数不变；`start_grant_runs` 无新行；无 `mutation_receipts` 残留
  （在事务内 `ROLLBACK`）；`cancelMessageWaiters` 未被调用（它在 create 之后才执行）。
- **spawn 被拒（`worker-start`）**：`dispatch_contexts` / `worker_dispatches` / `tasks` /
  `mutation_receipts` 行数不变；
  无 `worker_terminal_resources` 行；`runtime.createTerminal` 调用次数为 0；无 agent 进程；
  `--worktree new-child` 时没有新 worktree；没有 preamble 注入；没有 mailbox 投递。
- **spawn 被拒（`orchestration.dispatch`）**：无 dispatch 行；Task 状态未迁移到 `dispatched`；
  `--inject` 没有向该终端投递任何字节（第 9 个终端里已有的 agent 不受影响——它本来就在跑，
  这一点必须在报告里说明，不能声称"没有进程"）。
- **delivery**：只读 `git` 与 `stat`；finding 不改变任何记录。

### 2.10 本节相对上一版的修正（需 owner 复核）

1. **`--grant` 参数被删除。** 上一版让每个 worker 携带 `grant_id`。实际有两条插入点，且
   `worker-start` 已经从协调者解析出 Run（`rpc/methods/orchestration/worker/workers.ts:43`），
   Run 又已唯一绑定 grant——再让 worker 自报 grant 只会多一个可伪造的参数。改为"由 Run 推导"。
2. **`revoked_at` → 独立撤销表**（§2.1 第 1 条）。
3. **`spend` 从"部分可强制"改为"声明，不强制"**，并删除 `start_grant_spend_exceeded`（§2.6）。
4. **`repos` 从 `<repo-id>::<worktree-path>` 改为 `{repoId, worktreeIds}`。** 路径不是原生键：
   `--worktree current` 由运行时解析出 id 与 path，按 id 判定不依赖客户端自报的路径，也不会因为
   worktree 被重新指到别的目录而失效。
5. **文件数上调**：§4.2 原来写的"M1/M2 各只碰 2–3 个文件"不成立——M2 有两条插入点 + 一个共享判定 +
   一个 schema 文件 + 至少两个测试文件。修正后的估计见 §4.2。

### 2.11 评审修订（M0 第二轮，2026-11-13）

两位独立评审（codex-ark、trae，互不可见，只读）在同一份字节上给了结论：一位 `ACCEPT_WITH_FIXES`
（无 blocker），一位 `REJECT`（2 个 blocker）。下面是按固定判据裁决后落进本节的改动，以及没有改动的东西。

| # | 改动 | 来源 | 裁决 |
| --- | --- | --- | --- |
| R1 | spawn 的 hook 位置精确到"`BEGIN IMMEDIATE`（`worker-dispatch-start.ts:46`）之后、`mutation_receipts`（`:48`）之前"；`mutation_receipts` 进入 S1/S3/S8 的断言 | 两边都报（codex-ark M1、trae M1） | **接受**。原文"dispatch 插入之前"会让实现把 hook 放在 receipt 之后，而 receipt 就是第一条持久写 |
| R2 | 新增 `start_grant_required`：strict Run 无 grant 绑定时，开关打开即拒绝 | trae B1 | **接受**。原文把"没有绑定"当放行，中间窗口里旧 `runCreateStrict` 是完整绕过；开关默认值与截止时间仍是 §8 决策 4 |
| R3 | 自签的保证写成条件句：§0/§7/§2.6 都改成"分离为前提，否则只能主张不可静默制造" | trae B2 | **接受（措辞层面）**。是否要求分离是 §8 决策 5，本文不替它答；但"目标"不能写得像已经被强制 |
| R4 | 新建 worktree 的范围规则：`worktreeIds != null` 时禁止新建，只有 repo 级授权（`null`）允许 | codex-ark M2 | **接受**。判定时没有 worktree id，原文把创建路径留成"由本 Run 的一次 dispatch 创建"，实现上等于过宽 |
| R5 | `orchestration.dispatch` 的 hook 精确到 `SAVEPOINT`（`:62`）之后、`claimDispatchContextRow`（`:64`）之前 | codex-ark M3 | **接受** |
| R6 | C7 拆成 C7a（同身份并发幂等）/ C7b（异身份并发冲突） | trae M2 | **接受**。原文一条断言同时覆盖两种语义，等于两种都不测 |
| R7 | M0 完成范围收窄："只覆盖本文"，并点明 §6 里四项 M0 文档更新未做 | trae M3 | **接受**。曾声称 M0 完成而 `entry-paths.md` 仍指向旧路径，是文档与状态不一致 |
| R8 | 计数口径措辞统一为"该 grant 覆盖的活跃 dispatch"；拒绝体加 `status`/`updated_at`；补"context-only dispatch 计入 cap 但不等于有 agent" | codex-ark m3/n2、trae m2 | **接受** |
| R9 | 外键在 §2.1 表格里明列 | codex-ark m1 | **接受**。§2.6 的 `start_grant_unknown` 只在 create 出现，依赖的正是这两条外键 |
| R10 | `start_grant_remote_unsupported` 标注为**防御性、今天不可达**，并给出"放宽更早那道门时它才生效"的理由 | trae m1 | **部分接受**。不删（它有判定点、也有具体后果），但必须在表里自报"今天不可达"，否则与 §2.6 反对的假门同类 |
| R11 | RPC 名与 CLI 名分开写：`orchestration.workerStart` / `orca orchestration worker-start` | trae m3 | **接受** |
| R12 | `executionAuthorized` 用 camelCase 的理由写进 §2.2 | trae n1 | **接受（解释而非改字段）**。这个 receipt 与 `strict_run_coordinators.authority` 同库同风格，那一行本来就是 camelCase；Python 侧的 `execution_authorized` 是 bootstrap 协议，不是这张表 |
| R13 | S3b：`worktreeIds` 非 null + `--worktree new-child` 被拒，并断言无 worktree、无终端 | trae Q4 的追加建议（也是 codex-ark M2 列出的选项之一） | **接受**。纯增量断言，不改任何已评审条款；因为它是两位给出 CONSENSUS 之后追加的，单列一行 |

**明确没有改的**（避免下一轮把已裁决的东西再翻一遍）：

- §8 的 5 项 owner 决策一条都没被上述改动决定。R2 只决定了"要有 fail-closed 开关"，开关的默认值、
  打开时间与是否接受中间态，仍是决策 4；R3 只改措辞，不决定是否要求分离（决策 5）。
- `--grant` 参数仍不加到 `worker-start` 上（§2.10 第 1 条，两位评审都没有反对这条推导）。
- 没有采纳"把 `start_grant_remote_unsupported` 删掉"的另一种解法：它在本节的判据下是**有判定点、
  有后果**的码，只是当前不可达；删掉会让"放宽 `--on` 时不再有人计数"这件事没有任何记录。

## 3. 代码放哪：由"能不能被模型绕过"决定，不是由语言偏好决定

| 能力 | 模型能否绕过 | 必须在 | 依据 |
| --- | --- | --- | --- |
| grant 有效性、过期、撤销 | 不能 | **Orca 原生** | 所有 RPC 都过 dispatcher，但判定必须在 handler 的事务内（dispatcher 在 handler 之前、无事务） |
| `run ↔ grant` 绑定、幂等 | 不能 | **Orca 原生** | `createRun` 已有 `strict_run_coordinators` 同类表 |
| `max_workers` 原子计数 | 不能 | **Orca 原生** | 需要与 spawn 同事务 |
| `worktree/repo ∈ grant.repos` | 不能 | **Orca 原生** | spawn 参数已在原生侧 |
| mint 记录、一次性交接 | 是（无需防） | Python | 它是"唯一一次持久写"，不构成门 |
| 审计投影、`reconcile` 表 | 是（无需防） | Python | 只读诊断 |
| 交付期 `git status` 核对 | 是（交付本身要人看） | Python | 复用既有交付流程 |

**结论：不是"选 Orca 还是 Python"，而是按可绕过性切。** 判据一句话：*如果把这段逻辑删掉，
模型换个 CLI 参数还能做同一件事，那它就不该在 Python 里。*

具体落点（全部是既有机制，不是新造）：

| 落点 | 现状 | 本方案增量 |
| --- | --- | --- |
| `orca/src/main/runtime/orchestration/db/schema/start-grant-schema.ts`（新增） | 同目录的 `strict-coordinator-schema.ts:3` 是同类先例 | 三张表 + 不可变触发器（§2.1）；`strict_run_coordinators` 一字不改 |
| `orca/src/main/runtime/orchestration/start-grant-policy.ts`（新增） | 同目录的 `strict-coordinator-policy.ts` 是同类先例 | zod 草案 + 读写两侧的 parse（§2.2） |
| `orca/src/main/runtime/rpc/strict-coordinator-request.ts:26` `assertStrictCoordinatorRequest` | 双传输、方法级的 fence | **不加** grant 判据：它在 handler 之前运行、不在事务里，而计数必须与插入同事务（§2.5）。这里继续只做身份 |
| `orca/src/main/runtime/rpc/methods/orchestration/runs/strict-run-create.ts:39` | 已有 `runCreateStrict`（新动词先例） | 新增 `orchestration.runCreateGranted`；`createRun` 事务内做 §2.5 第一行的 a–g |
| `orca/src/main/runtime/orchestration/db/worker-dispatch/worker-dispatch-start.ts:46` | `createStartingWorkerDispatch` 的 `BEGIN IMMEDIATE` | 插入点 1：`assertSpawnAdmissible` 在写 mutation receipt 与 Task 之前 |
| `orca/src/main/runtime/orchestration/db/dispatch-context/dispatch-context-store.ts:62` | `createDispatchContext` 的 `SAVEPOINT` | 插入点 2（`orchestration.dispatch` 收养终端）：同一个判定函数 |
| `orca/src/cli/specs/orchestration-run-specs.ts:24` + `cli/handlers/orchestration/run-handlers.ts:57` | `run-create` 已有 `--strict-coordinator` / `--retry-request` | 加 `--grant`，只在带 `--strict-coordinator` 时合法，并路由到新 RPC 名 |
| `orca/src/cli/specs/orchestration-worker-specs.ts:8` | CLI `orca orchestration worker-start`（RPC `orchestration.workerStart`）已有 `--retry-request`、`--writable-roots` | **不加** `--grant`：grant 由 Run 推导（§2.10 第 1 条）；`--retry-request` 仍是 spawn 幂等键 |
| `swarm/coordinator_io.py:257` `publish_new` | 独占发布 + fsync | **保留**，mint 记录用它 |

## 4. 开发计划

依赖顺序 M0 → M1 → M2 是硬序；M3/M4 可与 M2 并行；M5 收口。

### M0 · 契约定稿（0.5 天，无代码）— **本文部分已完成，2026-11-13**

- 产出：本文 §2（记录形状、zod 草案、字段可强制性、不变量、三个判定点、拒绝码、计数口径、
  无副作用清单、对上一版的 5 处修正、§2.11 的评审修订）+ §4.1 的可执行断言矩阵。
- 验收：11 个拒绝码各有一条"若不存在会有人受损"的具体后果；`start_grant_spend_exceeded` 因
  "有后果但没有判定点"被删除，`writableRoots` 的检查由一个 RPC 码降级为交付期 finding；
  `start_grant_remote_unsupported` 自报为防御性（今天不可达），`start_grant_required` 由第二轮评审补入。
- 配套文档更新（§6 的 2/3/4/10 四项）已在同一批补齐：`entry-paths.md` 的单角色行改为入口选择并新增
  "启动凭据"一行（明写**未实现**）、协议正文加弃用横幅（冻结正文、按范围分冲突）、liveness 状态改为
  "P0 保留 / P1–P3 由 start grant 取代"、根 `AGENTS.md` 的 strict 缺口段指向本文。
- 未做：没有写任何实现代码，没有写测试，没有执行任何一条断言（§4.1 的 C/S/D/R 全部未执行）。

### M1 · grant 存储 + create 绑定（Orca，2–3 天）

- 改动：`db/schema/start-grant-schema.ts`（三张表 + migration）与 `orchestration/start-grant-policy.ts`
  （zod）；`orchestration.startGrant{mint,show,revoke}` 三个 RPC；新增 `orchestration.runCreateGranted`，
  在 `createRun` 的 `BEGIN IMMEDIATE` 内做 §2.5 第一行的 a–g。
- 验收：§4.1 的 C1–C8（C9 取决于 §8 决策 5）。其中"无 grant / 过期 / 已撤销 → 拒绝且不产生 runs 行"
  是 C3/C4，"objective 不匹配"是 C5。
- 不做：不碰 worker 路径，不改 `strict_run_coordinators` 语义（决策 1 已定：新表，三张）。
- 进展（2026-11-13）：**slice 1 `e2448f0f`**——`db/schema/start-grant-schema.ts`（三张表 + 6 个不可变
  触发器）、`orchestration/start-grant-policy.ts`（zod + 读写两侧 parse + `readGrantForRun` 的 fail-closed
  读侧）、接入 `orchestration-db.ts`、两个测试模块（20 例）。
  **slice 2 `f63fcca3`**——`createRun` 内的 §2.5 第一点 a–g（读 grant → 撤销 → 过期 → objective →
  已绑定（同身份=幂等返回原 Run）/异身份=拒绝 → 写入 + 绑定）、新动词 `orchestration.runCreateGranted`
  （`grant` 必填）、CLI `run-create --grant`（不带 `--strict-coordinator` 直接拒绝）、6 个 `start_grant_*`
  码进入 RPC 白名单（否则被压成 `runtime_error`）、`start-grant-create.test.ts`（11 例，含双连接幂等/冲突）。
  验证：39 files / 396 tests；`tsc` 与 `oxlint` 对本改动零问题（唯一 tsc 错误是快照内预先存在的
  `cli/build-pointer.test.ts`）。
  **M1 slice 3 `268ea200`**——`startGrant{mint,show,revoke}` 三个 RPC：mint 只接受**调用者自己**的活身份
  （记录里写别人的 minter 直接拒绝）、同字节重提幂等、同 id 不同内容 `start_grant_record_conflict`；
  `show` 在读侧推导 `valid/expired/revoked`（不存"有效"这种过去时判断）并报告它覆盖的 Run；
  `revoke` 记录撤销者与理由，同意图重放、不同理由冲突。
  **M2 `start-grant-spawn.ts`**——判定函数落在**两处** dispatch 插入点的同一个事务内、第一条持久写之前：
  `createStartingWorkerDispatch`（`worker-start`，hook 紧跟 `BEGIN IMMEDIATE`、早于 mutation receipt）与
  `createDispatchContext`（`orchestration.dispatch` 收养终端，`SAVEPOINT` 之后、`claimDispatchContextRow`
  之前）。计数口径、仓库范围（含"新建 worktree 只认 repo 级授权"、以及本 Run 已创建工作树仍在范围内）、
  过期/撤销、federation 拒绝、`start_grant_required` 全部就位。
  验证：`start-grant-spawn.test.ts` 12 例 + 回归 `orchestration/`、`rpc/methods/orchestration/`、
  `shared/`、`cli/handlers/` 共 12,821 项（10 失败全部是**预先存在**或**环境**问题，见下）。
- **`start_grant_required` 的开关是一个具名常量**（`start-grant-spawn.ts` 的
  `START_GRANT_REQUIRED = false`），放进代码而不是配置项：它现在的唯一作用是"别让这次提交把既有 strict Run
  在下次 spawn 时打死"，翻成 `true` 就是全部动作，且该路径已有开关打开的测试。**这就是 §8 决策 4 现在要
  定的东西：什么时候翻。**
  **M4**——`swarm/start_grant.py`（mint / hand / state，stdlib）：记录只构造一次、`publish_new` 独占落地、
  提交的就是那份字节（重试必须重提同一份，否则 mint 报 `record_conflict` 而不是 replay）；`state` 用
  `start-grant-show` 读回，并与本地记录做"去掉 `minter` 后的规范化比对"（`minter` 是服务端写的，
  逐字节比较永远不成立）。跨语言哈希已对齐并用三条向量钉住（ASCII / 中文 / 引号+反斜杠+换行）。
  为了让它有传输通道，同时补了 `orca orchestration start-grant-{mint,show,revoke}` 三个 CLI 动词
  （原属 M5 的"接入"，但不先有它 M4 无处可发），`start-grant-show` 现在也返回 `workers{active,max}`
  ——与 spawn 判定同一个计数函数，回答"第 9 个为什么被拒"。
  验证：`core.test_start_grant` 14 例、`core.test_wait_pane` + `core.test_generate_orientation` 一并跑，
  `TARGETED OK`（44 tests）。
- **未做**：撤销对已在跑 worker 的处理（§8 决策 2 未定，当前 revoke 只拦新 create/spawn）；自签检查
  （§8 决策 5 未定）；C7 的"两个进程同时争 `BEGIN IMMEDIATE`"（现在测的是同事务语义 + 双连接）；
  M5 的 `coordinator_launch.py start-grant` 子命令、`README`/`reliability` 收口、旧路径标 deprecated。

### M2 · spawn 计数 + 仓库范围（Orca，2–3 天）— **价值拐点**

- 改动：两处 dispatch 插入点各接同一个 `assertSpawnAdmissible`（§2.5 第二点）；`worker-start` **不**加参数。
- 验收：§4.1 的 S1–S9。核心那两行是 S1（第 9 次 spawn 被拒，且 `createTerminal` 调用次数为 0）与
  S4（`orchestration.dispatch` 收养路径同样被拦——只做 `worker-start` 会让 cap 一次绕过）。
- 完成 M2 之后，"worker 受控"才第一次成为对**已绑定 grant 的 Run**成立的事实；中间态见 §8 决策 4。

### M3 · deadline 与撤销（Orca，1–2 天）

- 改动：服务端时钟判定；`revoke` 后新 create/spawn 拒绝；已在跑的 worker 按 §8 决策 2 处理。
- 验收：过期 grant 拒绝；revoke 立即生效；把 agent 侧时间前后拨动不影响判定。

### M4 · mint 与只读投影（Python，1 天）

- 新增 `swarm/start_grant.py`，只做三件事：
  1. `mint`：读已审过的 task_source / 授权 Ref，写一条记录（`publish_new`）；
  2. `hand`：把 `grant_id` + 记录 Ref 向下投递给 Coordinator（一次，mailbox）；
  3. `state`：只读投影，逐项输出 `grant{valid,expired,revoked}`、`run{bound,absent}`、
     `workers{n,cap}`、`phantom{intent-without-output}`。
- 验收：mint 后 owner 死亡，`state` 能回答"grant 在、Run 不在" → 可 reconcile，**不重放**。

### M5 · 接入与收口（1–2 天）

- `swarm/coordinator_launch.py` 增加 `start-grant mint|hand|state` 三个只读/单写子命令；
- strict 的 create 路径改为"带 grant 的 create"；旧路径标 deprecated；
- `ORIENTATION.md` 重新生成（`generate_orientation.py --check` 会挡住漏项）。

### 4.1 验收矩阵（M0 产出：可执行断言）

每行是一条能判定的断言，不是"验证一下"。`orca/` 侧测试与被测源码同目录、同 basename 前缀；
Python 侧按 `swarm/tests/<area>/test_<module>.py`。执行命令见本节末尾。

**C · create 绑定**（`src/main/runtime/rpc/methods/orchestration/runs/start-grant-create.test.ts`）

| ID | 断言 | 证明什么 |
| --- | --- | --- |
| C1 | 同 `grant_id` + 同协调者 + 同 objective 连续两次 create：`runs` 行数 = 1，第二次返回同一 `run.id` 且 `effectsApplied:false` | I4：幂等键不产生第二个 Run |
| C2 | 两个不同 grant → 两个 Run，各自 `start_grant_runs` 一行 | 绑定是按 grant 而不是按协调者 |
| C3 | `grant_id` 不存在 → `start_grant_unknown`，且 `runs` / `dispatch_contexts` / `mutation_receipts` 行数全部不变 | 拒绝无副作用（§2.9） |
| C4 | deadline 已过 / 有撤销行 → 分别是 `start_grant_expired` / `start_grant_revoked`，`runs` 行数不变 | I5 + 撤销是插入而非更新 |
| C5 | `params.objective` 换一个字符 → `start_grant_objective_mismatch`，`runs` 行数不变 | 防"拿 A 的批准启动 B" |
| C6 | 同一 grant 换一个协调者终端的活身份 → `start_grant_already_bound` | §8 决策 3 的默认值（1）被真的执行 |
| C7a | 两个连接并发 create 同一 grant，**同一协调者活身份 + 同一 objective**：恰好 1 个 Run，第二次返回原 Run 且 `effectsApplied:false`（I4 的幂等分支） | 并发下的幂等，不是"谁先谁赢" |
| C7b | 两个连接并发 create 同一 grant，**不同协调者活身份**：恰好 1 个 Run，另一个 `start_grant_already_bound`，不留下半个事务 | `BEGIN IMMEDIATE` 内的"读绑定 + 写绑定"不可交错 |
| C8 | receipt 被手工改坏（如 `objectiveHash` 与 `objectiveText` 不一致）→ `start_grant_invalid_record`，且**不**按"无 grant"放行 | 损坏记录不 fail-open |
| C9 | （§8 决策 5 定案后）协调者 ≡ minter → `start_grant_self_minted`，`runs` 行数不变 | 执行者不能给自己签发批准 |

**S · spawn 计数与范围**（`.../worker/start-grant-spawn.test.ts`、`.../worker/start-grant-repo-scope.test.ts`）

| ID | 断言 | 证明什么 |
| --- | --- | --- |
| S1 | `maxWorkers=8`，第 9 次 `worker-start`：返回 `start_grant_worker_limit`；`dispatch_contexts` / `worker_dispatches` / `tasks` / `mutation_receipts` 行数均不变；`runtime.createTerminal` 调用次数 = 0；无 `worker_terminal_resources` 行 | cap 真的执行；"无副作用"到第一条持久写为止（不是"无进程"，见本节末） |
| S2 | 一个 worker 报 `worker_done`（dispatch 迁到 `completed`/`failed`）后再起一个：成功，活跃计数不泄漏 | 计数读的是活跃状态，不是累计 |
| S3 | `worktree` 解析出的 `repoId` 不在 `repos` → `start_grant_repo_not_granted`，`createTerminal` 调用次数 = 0，`mutation_receipts` 行数不变 | 仓库范围在终端创建前判定 |
| S3b | `worktreeIds` 非 null 的白名单 + `--worktree new-child` → `start_grant_repo_not_granted`，且没有创建 worktree、`createTerminal` 调用次数 = 0、`mutation_receipts` 行数不变 | "枚举了 worktree 却还能新建"这个漏洞有断言（§2.5 第 3 步） |
| S4 | `orchestration.dispatch` 收养第 9 个终端 → `start_grant_worker_limit`，无 dispatch 行，Task 未转 `dispatched`，`--inject` 未投递任何字节 | 第二条插入点也被覆盖（§2.8） |
| S5 | 同一次 `--retry-request` 重复 `worker-start` → 一条 dispatch | spawn 幂等键仍是既有 mutation receipt，不是新键（I4） |
| S6 | 两个连接并发 `worker-start`，`maxWorkers=1`：恰好一条 dispatch，另一半拿拒绝或 `SQLITE_BUSY` | 计数与插入同事务 |
| S7 | 直接给 `createStartingWorkerDispatch` 传 `federation` 参数 → `start_grant_remote_unsupported`；同时断言 `--on` 仍由 `workers.ts:63` 以 `strict_coordinator_required` 拒绝（两条边界分开测，不互相替代） | 防御性码有判定点；放宽那条更早的门不会顺带绕过计数 |
| S8 | 已撤销 / 已过期 grant 的 Run 再 spawn → 对应码，`createTerminal` = 0，`mutation_receipts` 行数不变；把进程时钟前后拨动不改变判定方向 | revoke/expired 在 spawn 侧也生效，且只认服务端时钟 |
| S9 | 未绑定 grant 的 strict Run：开关**关闭**时 spawn 放行且诊断里带"未绑定"；开关**打开**时 `start_grant_required`，`mutation_receipts` 行数不变 | fail-closed 有开关，而不是靠"旧动词 deprecated" |

**D · delivery 审计**（`swarm/tests/core/test_start_grant.py`）

| ID | 断言 | 证明什么 |
| --- | --- | --- |
| D1 | 变更路径全部落在 `writableRoots` 内 → 无 finding，退出码 0 | 正常路径 |
| D2 | 有一个文件在根外 → 输出 `start_grant_write_outside_declared_roots` 且非零退出 | 越界可被发现 |
| D3 | 子模块脏工作区 → 被枚举（`git submodule foreach`），不是只报超级仓库那一行 | 交付覆盖子模块 |
| D4 | 该工具只读：运行前后被测仓库的 `git status` 输出逐字节相同 | 它是审计不是门，也不产生副作用 |

**R · mint 与只读投影**（`swarm/tests/core/test_start_grant.py`）

| ID | 断言 | 证明什么 |
| --- | --- | --- |
| R1 | mint 后 owner 进程消失：`state` 输出 `grant{valid}`、`run{absent}`、`workers{0,N}`，且没有发起任何重放 | I6：未知只对账不重放 |
| R2 | revoke 后 `state` 显示 `revoked`，且 create/spawn 侧拒绝（与 C4/S8 对齐） | 两个方向的记录一致 |
| R3 | `state` 不写任何字节（被测目录在运行前后的文件清单 + sha256 相同） | 只读投影 |

**不在离线断言里的两件事**（写进报告，不写成通过）：

- "第 9 个 spawn 没有 agent 进程"在单元层只能证明**没有请求创建终端**。真正的进程断言要在宿主上跑：
  `orca terminal list --json` 前后计数不变。这是 live 门，不是离线门。
- `orchestration.dispatch` 被拒时，被收养的那个终端里**本来就已经在跑 agent**。所以 S4 只断言"没有成为 supervised
  dispatch、没有注入"，不断言"没有进程"。

执行（`orca/` 侧，小批量，`--maxWorkers=2`）：

```bash
cd orca && node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts \
  src/main/runtime/rpc/methods/orchestration/runs/start-grant-create.test.ts \
  src/main/runtime/rpc/methods/orchestration/worker/start-grant-spawn.test.ts \
  src/main/runtime/rpc/methods/orchestration/worker/start-grant-repo-scope.test.ts \
  --maxWorkers=2
```

Python 侧：`swarm/tests/run_offline.sh --modules core.test_start_grant`（新增模块，按目录规则落在
`tests/core/`）。M0 只产出这张表，**没有写任何测试，也没有执行过任何一条**。

### 4.2 工作量与风险

- 总计 ≈10–12 人日（M0 把 M2 的真实触点暴露出来之后上调），其中 Orca 侧 7–9 天。**绝大部分是
  Orca 侧**——这正是"在 Python 里做 strict"绕不过去的地方：模型可以绕过 Python。
- Orca 是上游快照（`swarm-orca/AGENTS.md` 第一节）：diff 要最小、不重排、不带私有配置，
  每处改动都要能在下次升级时重放。M1 约 3 个改动文件（schema、policy、create 路径），
  M2 约 5–6 个（两处插入点、共享判定、类型、CLI 参数、测试），仍在上限内。
- 最大技术风险不是并发，而是**把 `writable_roots` 说成强制**。本文明确不这么做。

## 5. 旧代码清理方案（不做回滚兼容）

三条纪律：**不留 `--allow-legacy`、不留双写、不留"先读新再读旧"**；每批在同一 commit 里删测试；
每批合入前跑 `tests/run_blast.sh` 并列出"消失了哪些测试模块"。

### 批 1 · S3/S4 交叉复核与 marker 链（随 M2 合入删除）

| 删除 | 文件 |
| --- | --- |
| marker 链、`operator_step`、`emit_batch` 的复核前置 | `swarm/bootstrap_driver.py`（`marker()`、`operator_step()`、`advance()`） |
| 四个 submit/readiness action | `swarm/bootstrap_actions.py`（保留 `caller-intent`/`observe-intent` 直到批 2） |
| 审查动作入口 | `swarm/bootstrap_tool.py`（`submit`/`commit_candidate`/`submit_readiness`/`materialize_template`） |
| 测试 | `swarm/tests/bootstrap/` 下 `test_bootstrap_flow.py`、`test_bootstrap_submission.py` |

保留：`swarm/bootstrap_events.py` 的只读诊断（`--check` 仍可用于历史 attempt 的事后取证）。

### 批 2 · owner / control 面（随 M4 合入删除）

| 删除 | 文件 |
| --- | --- |
| 单写者 owner、flock、commit_new/confirmed 链 | `swarm/bootstrap_control.py`、`swarm/bootstrap_transport.py`、`swarm/bootstrap_admission.py` |
| 角色工具剩余部分 | `swarm/bootstrap_tool.py`、`swarm/bootstrap_driver.py` |
| 阶段等待（改为直接等 run/spawn 读回） | `swarm/bootstrap_stage_wait.py` |
| 测试 | `swarm/tests/bootstrap/test_bootstrap_control.py`、`test_bootstrap_commit_states.py`、`test_bootstrap_production.py`、`test_bootstrap_isolation.py`、`test_bootstrap_admission.py`、`test_bootstrap_stage_wait.py` |

保留：`swarm/coordinator_io.py` 的 `publish_new` / `fsync_dir` / `directory_lock`（mint 记录与其它
模块仍在用）。**不要跟着 `bootstrap_control` 一起删。**

### 批 3 · S5 之后的握手（随 M5 合入删除）

| 删除 | 文件 |
| --- | --- |
| prepare / delivery / wait / publish / gate | `swarm/coordinator_request_prepare.py`、`swarm/coordinator_strict_delivery.py`、`swarm/coordinator_strict_start.py` |
| lifecycle v2（spec/activation/lifecycle） | `swarm/operator_startup.py` 的 prepare/publish 段 |
| 契约与字段生产 | `swarm/coordinator_strict_request.py` 的 input schema v4 / request v5 / admission 绑定 |
| 测试 | `swarm/tests/` 下 `test_coordinator_strict_start*`、`test_coordinator_strict_delivery*`、`test_operator_startup*` 的 lifecycle 段 |

### 明确不删（这些是真正的运行时 fence，也是 M2 的落脚点）

- `orca/src/main/runtime/rpc/strict-coordinator-request.ts` 与 `strict-coordinator-authority.ts`
  （`assertStrictCoordinator*`）——扩它，不删它。
- `orca/src/main/runtime/rpc/methods/orchestration/runs/run-scope.ts`（`resolveRunScope`）。
- `orchestration strict-caller-check`（`swarm/coordinator_strict.py` 的 `caller_result`）——
  身份来自原生查询，是本文唯一继承的旧门。
- `swarm/coordinator_io.py` 的 `publish_new` / `fsync_dir`。

### 删除前的引用清查（每批执行一次，缺一项不合入）

```bash
# 三个入口
grep -n "bootstrap_\|strict-start\|strict-config" swarm/coordinator_launch.py
# skills 与文档
grep -rn "strict-bootstrap\|strict-start-prepare\|strict-config-review" swarm/skills swarm/*.md
# ORIGINATION 索引（生成物，--check 会失败直到重生成）
python3 -B swarm/generate_orientation.py --check
```

## 6. 文档更新计划

先改路由与弃用声明，再改实现文档；**不允许文档先承诺一个未实现的门**。

| # | 文档 | 动作 | 时机 |
| --- | --- | --- | --- |
| 1 | `swarm/docs/design/start-grant.md`（本文件） | 新增（M0 已完成：§2 契约 + §4.1 断言矩阵）；M1–M5 状态在合入时回填 | ✅ 2026-11-13 |
| 2 | `swarm/docs/entry-paths.md` | §2 表格里"只读核验且无两个不同权限角色 → 单角色"从"草案未定"改为入口选择；新增一行"启动凭据"（**标注未实现**）；`max_workers` 那句补上"今天只是 brief 约束" | ✅ M0 |
| 3 | `swarm/strict-bootstrap-protocol.md` | 顶部加"**已弃用**，由 start-grant 取代"横幅；§1–§8 冻结不再更新，正文不删（历史取证仍要读）；冲突按"历史 attempt vs 新 Run"分 | ✅ M0 |
| 4 | `swarm/docs/design/strict-bootstrap-liveness.md` | 状态改为"P0 已实现并保留；P1–P3 由 start-grant M1–M4 取代"；D1–D3 保留为诊断记录 | ✅ M0 |
| 5 | `swarm/coordinator-strict-start.md` | 保留 `strict-caller-check` 与 create 段；删除 §3–§7（config/lifecycle/gate/ready）；交接改为"一次 grant 投递" | M4 |
| 6 | `swarm/operator-prepare.md` | 删除 S0 materials / skill-read-evidence / registration 段（或降级为可选审计），改指向 M4 的 mint | M4 |
| 7 | `swarm/ORIENTATION.md` | `generate_orientation.py` 重新生成（`--check` 守着行区间） | 每批 |
| 8 | `swarm/README.md` | 入口表：strict 两行 → grant + 非 strict 两行 | M5 |
| 9 | `swarm/docs/testing/reliability.md` | 并入 §4 的验收矩阵；旧 strict 的 11 项续验标为历史 | M5 |
| 10 | `AGENTS.md`（本仓根即 `swarm-orca/AGENTS.md`） | 把"strict bootstrap 的已知缺口与草案"那段改为指向本文（并保留"现行协议仍具约束力"） | ✅ M0 |

文档纪律：一处状态只写一遍（状态表在本文件 §4；其它文档引用，不复述）；每批删除在
`strict-bootstrap-offline.md` 追加一条"删了什么、证据在哪"，不重写历史章节。

## 7. 风险与不声称

- **不声称**能防恶意同 UID 进程、能防文件系统谎报 fsync（与现行协议同一假设）。
- **不声称**解决"授权内容对不对"：objective 是否等于用户真意仍由 mint 者负责，和今天一样。
- **不声称** `writable_roots` 已被强制（§0、§2.3）。
- **不声称** M2 之后就不会有重复 worker：`grant_id` 幂等只覆盖"同一意图重复提交"，不覆盖
  "Coordinator 用两个不同意图派两次"——后者由 `max_workers` 与任务 DAG 负责。
- **不声称** `max_workers` 能限制 Agent 进程数。它数的是**受监督的 dispatch**：`terminal.create`
  不在 `isStrictCoordinatorEffect`（`rpc/strict-coordinator-effect-scope.ts`）里，所以协调者仍可
  开终端并在里面跑 agent，只是那些不成为 dispatch、不进计数。这条只有交付审计（数活跃 agent 终端与
  `worker_terminal_resources`，报差异）能发现，本文不把它写成门。
- **不声称**计数等于存活：dispatch 行在 worker 进程死后仍可能停在 `dispatched`，此时计数偏高（多拒，
  安全方向）。所以 `start_grant_worker_limit` 的拒绝体必须附被计入的 `dispatch_id` 列表。
- **不声称** `spend` 被强制：它是声明（§2.3），Orca 在这条路径上没有用量判定点。
- **不声称**"启动授权不可能由执行者制造"在所有情形下都成立：这条保证以 mint 者与执行者分离为前提。
  §8 决策 5 若答"不要求分离"，本文只能保证"不能**静默**制造"——每次 mint 都带活身份、可归因。
  两句话不能混着说。
- **不声称** grant-required 开关关闭期间的 strict Run 受 cap 约束：那段时间里未绑定的 strict Run 仍按现状
  派发（`start_grant_required` 只在开关打开时命中）。窗口的默认值与截止时间见 §8 决策 4。
- M1–M5 的收益数字本文一律不给：唯一可报的是 §0 那张**已发生**的成本样本。

## 8. 待 owner 决策（本文不代替）

下面 5 条里，**1 与 3 已定**（2026-11-13，owner；第 3 条由 owner 授权本文判断）：
新表；一个 grant 只允许 **1** 个 Run。其余 3 条（revoke 语义、批次 + `start_grant_required` 开关默认值、
只读任务是否要求 mint≠执行者）仍然待定，**没有一条被本文自行决定**。每条后面附的是技术后果。

1. **✅ 已定（owner，2026-11-13）：用新表。** `start_grants` / `start_grant_runs` /
   `start_grant_revocations` 三张表，`strict_run_coordinators` **一字不改**。
   新表：边界清楚、`strict_run_coordinators` 一字不改、升级冲突小，代价是一次 migration + 三张表。
   扩列：该表主键是 `run_id` 且 `REFERENCES runs(id)`，而 grant 必须先于 Run 存在——扩列实际要求
   主键可空或无 Run 的行，等于换表再迁移。**两者不是等价选项**（§2.7 给出了这条对照）。
2. **`revoke` 时已在跑的 worker：立即停，还是放行到当前波次结束？**
   可用的既有动作是 `orchestration.workerStop`（有 verdict 与 `stop_unknown` 分类）与
   `workerRelease`（回收终端）。立即停：伤害窗口最短，丢中间产物，且 STOP 不撤销已发生的写入。
   放行到波次结束：证据完整，但撤销到那一刻为止不是"停止"。两种答案都要求 revoke 只拦**新**的
   create/spawn；差别只在要不要主动发 stop。
3. **✅ 已定：1 个**（owner 授权本文判断，2026-11-13）。理由与重开条件：
   - cap 不放大。答 N 就得把 `max_workers` 从"每 Run"改成"每 grant 合计"，否则上限乘以 N；那要同时换
     `start_grant_runs` 主键、改计数 join、删 `start_grant_already_bound`——三处一起动，收益只是"同一份批准
     能开第二个 Run"。
   - 重开有更便宜的路：Run 死掉 → `runRetireStrict` 退休，然后**重新 mint 一份**（一次插入）。两次尝试
     用相同的 `objectiveHash` + 相同的 `authorizationRefs` 在审计里连成"同一份批准的第 1、2 次"，每次一个
     `grant_id`，谁负责、何时过期都清楚——比一份 grant 挂 N 个 Run 更好归因。
   - 代价（承认）：minter 已离线时无法重开第二次尝试。这是"mint 必须由活身份完成"的直接后果，不是缺陷。
   - **重开条件**：若实测反复出现"create 后立刻失败 + owner 离线 + 必须马上重跑"，改成 N，且必须
     **同时**把 cap 改成每 grant 合计（主键、计数、拒绝码一起改，不许只改主键）。

   若答 N，`start_grant_runs` 的 PK 改成
   `(grant_id, run_id)`、`start_grant_already_bound` 删除、`max_workers` 变成"每 grant 合计"而不是
   "每 Run"——否则 N 个 Run 各拿一份 cap，上限乘以 N。
4. **`START_GRANT_REQUIRED` 什么时候从 `false` 翻成 `true`？以及批 1–3 一次合入还是分批？**
   （开关本身已落地为具名常量，不再是待实现项；见 §4 M1 的进展。）
   独立交付的中间态会更弱：M1 之后 `runCreateGranted` 与 `runCreateStrict` 并存，未绑定 grant 的 strict Run
   只有在开关打开后才被拒绝（§2.5 第二点第 1 步），而目前所有 strict Run 都属于这一类。所以这一条现在必须
   一次给出两个值：**默认关还是默认开**（默认关 = 中间期仍可绕过；默认开 = 现有 Run 立刻拒绝派发，需要一次显式
   迁移），以及**窗口何时关闭**。M2 落地是中间态不再更弱的前提，开关默认值是它成立与否的条件。
5. **只读任务是否仍要求 mint 者与执行者不同进程？** 本文倾向**不要求**：凭据仍然向下发，只读任务
   的伤害面是"多花时间"而不是"写错地方"。但这一条决定 `start_grant_self_minted` 是否启用——
   若不要求分离，则"执行者可以自己 mint"，整套设计的前提只剩"mint 会被记录"；若要求，则该码
   必须真的存在，并且这条要求要写进 entry-paths（不能靠惯例），因为单角色流程会因此需要第二个 pane。
