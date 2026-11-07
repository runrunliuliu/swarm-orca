# Sparse 任务工作区 M0 契约冻结

状态：M0 契约冻结稿。本文只定义 M1/M2 要实现和测试的新增能力协商路径；不改变 legacy 全量或 legacy sparse 创建语义。

## 真实调用链与旧行为

当前 Orca 没有第二套 worktree 创建器。任务 sparse 工作区必须复用现有 RPC、runtime、Git helper 和 metadata 路径，只在新协商字段存在时启用更严格的 sparse 任务契约。

| 入口 | 当前 sparse 调用链 | 旧调用者行为必须保持 |
| --- | --- | --- |
| runtime/mobile `worktree.create` | `WorktreeCreate` schema → runtime managed create args → `createRuntimeLocalGitWorktree` → `normalizeSparseDirectories` → `addSparseWorktree` / `addWorktree` → `resolveCreatedWorktree` → metadata/setup/startup | 不发送新增字段时，`sparseCheckout.directories` 仍按 legacy 规则 trim/规范化/去重；全量创建仍可使用 prepared checkout；返回旧字段即可；setup/startup 顺序不因本文改变。 |
| desktop/IPC 本地 create | IPC create args → 本地 worktree create span/metadata → `normalizeSparseDirectories` → prepared checkout miss for sparse → `addSparseWorktree` / `addWorktree` → worktree catalog/metadata | 旧 sparse textarea/preset 仍是性能优化，不变成任务就绪证明；preset attribution、metadata 字段和 legacy 错误文案不因 M1/M2 改严。 |
| desktop/IPC SSH create | IPC remote provider create → provider `worktree add` with optional `noCheckout` → provider `sparse-checkout init --cone` → provider `sparse-checkout set -- ...` → provider `checkout` → remote metadata | SSH execution 仍归 provider/执行主机所有；旧 SSH sparse 不自动获得任务契约，也不被静默回退全量。新增任务 sparse 语义必须在后续接入 SSH 时给出同样结论：固定 SHA、回读 HEAD/cone、树校验和必需路径核验。 |
| folder workspace | 不是 Git worktree create | 新任务 sparse 字段对 folder workspace 无意义，调用方必须在副作用前拒绝。M1/M2 不把 folder workspace 转成 Git worktree。 |

## 新能力名

新增 runtime capability：`worktree.sparse-task-workspace.v1`。

语义：host 支持 `worktree.create` 的任务 sparse 协商字段，并在该字段存在时执行 M1/M2 的固定基线、创建回执、tree entry 校验与必需路径核验。客户端未看到该 capability 时不得发送新增字段；如果旧 host 收到未知字段并剥离，调用方不能把 legacy sparse 回执解释为任务 sparse 成功。

## 请求字段

新增字段均为可选；缺省即 legacy 行为。

| 字段 | 位置 | 类型 | M1/M2 语义 |
| --- | --- | --- | --- |
| `sparseCheckout.directories` | 既有 | `string[]` | legacy 路径保持旧规范化；任务路径启用严格解析：至少一项、稳定去重、保留内部空格、拒绝空/`.`/绝对路径/drive/UNC/`..`/NUL/control/首尾空白。 |
| `sparseCheckout.requiredPaths` | 新增 | `string[]` | 任务路径声明启动前必须存在的仓库相对路径，例如 `AGENTS.md`、角色 skill、测试/构建配置。创建后逐项按实际 worktree 核验存在；缺失即失败，不扩 cone、不回退全量。 |
| `sparseCheckout.mode` | 新增 | `'task-workspace-v1'` | 显式选择新增任务 sparse 契约。只有这个值触发 M1/M2；字段缺省或其他 legacy payload 不触发。 |
| `baseBranch` | 既有 | `string | undefined` | 任务路径解析一次，并把最终创建 base 固定为完整 commit SHA。legacy 路径仍传原 base/ref。 |
| `clientMutationId` | 既有 | `string | undefined` | 本轮不实现 M4 durable replay；如果存在，仍只享受既有短期 dedupe/idempotency 行为。 |

M2 限制：任务 sparse 选择最多 128 个目录；目录 UTF-8 编码总量最多 16 KiB。`requiredPaths` 最多 256 项；UTF-8 编码总量最多 32 KiB。超限在 Git 副作用前失败。

## 回执字段

新增回执放在 `sparseCheckoutReceipt`，只在任务 sparse 路径成功时返回。

| 字段 | 类型 | 来源与含义 |
| --- | --- | --- |
| `baseSource` | `'request' | 'default'` | base 来自显式 `baseBranch` 还是创建器默认 base。 |
| `resolvedRef` | `string` | 创建前解析出的有效 ref 名称；用于说明哪个 ref 被固定。 |
| `pinnedSha` | `string` | 创建前固定的完整 commit SHA；Git worktree 创建必须使用它，而不是移动 ref。 |
| `actualHead` | `string` | 创建后回读的 worktree HEAD。必须等于 `pinnedSha`，否则不返回成功。 |
| `requestedSparseCone` | `string[]` | 严格解析后的请求 cone，按首次出现顺序稳定去重。 |
| `effectiveSparseCone` | `string[]` | 创建后从 worktree sparse-checkout 状态回读的实际 cone。 |
| `requiredPaths` | `string[]` | 严格解析后的必需路径，按首次出现顺序稳定去重。 |

## 错误码

现有错误通道仍可能只承载 message；M1/M2 新错误 message 必须包含以下稳定码，便于后续结构化错误时保持兼容。

| 码 | 触发条件 | 副作用边界 |
| --- | --- | --- |
| `sparse_task_capability_required` | 请求任务 sparse 字段但 host/调用路径不支持该能力 | Git 副作用前 |
| `sparse_task_directory_invalid` | sparse 目录格式非法 | Git 副作用前 |
| `sparse_task_directory_limit_exceeded` | sparse 目录数量或编码大小超限 | Git 副作用前 |
| `sparse_task_directory_missing` | pinned tree 中不存在请求目录 | Git 副作用前 |
| `sparse_task_directory_not_tree` | pinned tree 中请求目录是 blob、symlink 或 gitlink | Git 副作用前 |
| `sparse_task_required_path_invalid` | required path 格式非法或超限 | Git 副作用前 |
| `sparse_task_head_mismatch` | 创建后 `actualHead !== pinnedSha` | 不返回成功；M4 前不声明可恢复清理语义 |
| `sparse_task_effective_cone_mismatch` | 创建后实际 cone 与请求 cone 不一致 | 不返回成功 |
| `sparse_task_required_path_missing` | 创建后必需路径不存在 | 不返回成功，不扩 cone、不回退全量 |

## 兼容矩阵

| Caller | Host | Payload | 结果 |
| --- | --- | --- | --- |
| 旧 caller | 新 host | 无 `mode: 'task-workspace-v1'` | legacy 行为不变；不会得到 `sparseCheckoutReceipt`。 |
| 新 caller | 新 host | `mode: 'task-workspace-v1'` 且 host advertises `worktree.sparse-task-workspace.v1` | 执行 M1/M2；成功返回 `sparseCheckoutReceipt`。 |
| 新 caller | 旧 host | 新字段 | 旧 schema 可能剥离未知字段；caller 必须因缺 capability 在发送前失败关闭，不能解释 legacy sparse 成功为任务 sparse 成功。 |
| 新 caller | 新 host | sparse dirs 但无任务 mode | legacy sparse；无固定 SHA/树校验/必需路径语义。 |
| 任意 caller | 任意 host | 全量创建 | legacy 全量创建；默认值、prepared checkout、setup/startup 不变。 |
| 任意 caller | folder workspace | 任务 sparse 字段 | 副作用前拒绝；folder workspace 不支持 Git sparse worktree 创建。 |

## M1/M2 实现边界

- M1/M2 只保证单次创建调用的固定 SHA、回读和内容校验；不实现 M3 的 setup/Agent 启动门禁。
- M1/M2 不实现 M4 durable receipt/replay，也不改变现有 sparse helper 的 catch-all rollback 策略。
- M1/M2 不自动扩大 cone，不自动回退全量，不迁移既有 worktree/metadata。
- SSH 旧路径必须保持兼容；任务 sparse 接入 SSH 前不得宣称 SSH live 验收完成。
