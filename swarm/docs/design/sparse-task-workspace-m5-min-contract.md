# Sparse 任务工作区：M5 最小绑定契约

状态：M5 最小版实现契约（`sparseTaskBinding`）。只记录**成功创建**的规范事实，供后续 M3 启动门禁与交接复核读取。
本文不是完整任务系统：没有逻辑任务 ID、没有跨入口路由、没有持久回执、没有 `create-status`、没有收养或清理。

依据：[开发计划](sparse-task-workspace-development-plan.md)（M5 条目）、
[M0 契约冻结](sparse-task-workspace-m0-contract.md)（receipt 与错误码）、
[创建失败的只读对账](sparse-task-workspace-reconciliation.md)（M4 最小止血）。

## 1. 落点与理由

绑定写入 Orca 持久化的 `WorktreeMeta.sparseTaskBinding`（`orca/src/shared/worktree/meta-types.ts`），
与创建时其它元数据在**同一次 `setWorktreeMeta` 写入**里提交。

| 方案 | 旧 host 读取 | 既有 Run pins | 迁移成本 | 独立核验 |
| --- | --- | --- | --- | --- |
| **WorktreeMeta 字段（选用）** | 未知字段被忽略，按字段合并写 | 不受影响 | 最低：可选字段，无迁移 | 需要交接带上摘要 |
| worktree 内 `git config` | 不读 | 不受影响 | 中：跨宿主/WSL 与 `extensions.worktreeConfig` 复杂 | 最强，任何克隆都能读 |
| userData 独立 JSON | 不读 | 不受影响 | 高：迁移、清理、与元数据生命周期不同步 | 中 |
| 元数据 `comment` | 会显示但不可解析 | 不受影响 | 最低 | 弱：可被用户改写 |

选择理由：创建成功后本来就要写元数据，绑定与其它字段同一次写入即**原子**；不需要新状态源。

## 2. 字段

```text
schemaVersion: 1
mode: 'task-workspace-v1'
pinnedSha: string            # 完整 commit id，小写；sha1 仓库 40 位、sha256 仓库 64 位
baseSource: 'request' | 'default'
resolvedRef: string          # 创建前解析出的 ref，说明 pin 来自哪里
requestedSparseCone: string[] # 严格解析后的请求 cone，首次出现顺序、去重
requiredPaths: string[]      # 声明并已核验的必需路径
createdAt: number            # 写入时刻（与元数据同一次写）
bindingDigest: string        # 上述规范字段的 sha256(hex)
```

**不持久化** `actualHead` 与 `effectiveSparseCone`：它们是工作区快照，读取方每次都重新回读；
存下来只会变成"过期但看起来像证据"的记录。receipt 本身也不持久化——它是一次性返回值，
`bindingDigest` 不是 receipt 的摘要，而是对已持久字段的自摘要。

规范化：字段按固定顺序序列化为 JSON 再哈希，因此调用方自建对象的键顺序不影响结果。

## 3. 写入时机与失败语义

1. 只在任务 sparse 创建**拿到 receipt 之后**写；位置在创建流程的元数据提交里，早于 setup/启动。
2. 与其它元数据同一次写入，因此"创建成功"即"绑定已持久"；写入抛错则创建失败
   （否则会发布一个 M3 无法门禁的工作区）。
3. legacy 全量创建与 legacy sparse 创建**完全不写**该字段，读取方因此不能把普通工作区误当任务工作区。
4. 失败创建（`needs_reconciliation`）**不写**绑定：失败坐标在错误与只读对账里，
   持久绑定留给 M4 完整版；否则 M3 容易把待对账资源当成任务候选。
5. 工作区删除时随元数据一起消失；路径复用不继承（记录绑定 `instanceId` 语义由元数据外层负责）。

## 4. 读取规则

`parseSparseTaskWorkspaceBinding` 严格读取，任何一条不满足即返回 `null`（不抛错、不修复）：

- 键集合必须**完全等于**本 schema，多一个未知字段即拒绝（避免把未来版本的记录当 v1 执行）；
- `schemaVersion`、`mode`、`pinnedSha` 形态、`baseSource` 取值、数组元素类型、`createdAt` 有限数；
- `bindingDigest` 必须等于按规范字段重算的摘要（不符即视为被改写）。

`sparseTaskBindingMatchesReceipt` 用于交接：比对 `pinnedSha`/`baseSource`/`resolvedRef`/cone/requiredPaths，
不比对 digest（receipt 里没有 digest）。

## 5. 与 M3/M4 的边界

- M3 启动门禁只对"请求了 task workspace 或带该绑定的启动"生效；缺记录、摘要不符、schema 未知一律 fail-closed。
- 绑定**不能替代**现场回读：启动时仍要回读 HEAD、cone、必需路径（M3 口径另定，见计划）。
- M4 完整版仍需：客户端请求 ID、先于副作用的持久回执、阶段化状态、`create-status`、重启后对账、收养与清理。

## 6. 已知缺口

- 元数据阶段失败（绑定写入之后、启动之前）**不会**带 M4 标记：`createSparseTaskWorkspace` 已成功返回，
  标记只覆盖创建序列内部。
- 外部（非原生创建）工作区没有绑定；收养流程未实现，读取方只能把它当普通工作区。
- 跨宿主/SSH 与 WSL 未接入；只有本地创建路径写绑定。
- 无 schema 迁移工具：v1 之外的版本一律读作 `null`，需要时另立契约。

## 7. 本轮测试证据

- `orca/src/shared/worktree/sparse-task-binding.test.ts`：11 passed（摘要规范化、字段取舍、篡改与未知 schema 拒绝、receipt 比对）。
- `orca/src/main/ipc/worktrees-local-create-flow.test.ts`：19 passed（任务创建后元数据里可解析出绑定）。
- `orca/src/main/runtime/runtime-local-worktree-materialization.test.ts`：3 passed（runtime 入口写绑定；无 receipt 时不写）。
- `oxlint` 干净；`check-max-lines-ratchet` 通过；未跑全仓 vitest、Electron/E2E 与真实 Agent 闭环。
