# auto_evolve RPC reference

本文件相对 `SKILL.md` 使用。RPC 名称/字段据本仓库源码核对；运行时仍必须只读核验。
第一版附带的 Python 客户端只支持 Linux/macOS Unix socket 与 GitHub issue，非通用 RPC shell。
它没有 WebSocket 配对、自动安装依赖、进程提权、CLI fallback 或重试逻辑。

## 调用方式

由操作者给出目标 runtime 的 `orca-runtime.json` 路径及刚核验的 runtime ID。
使用现有授权读取 metadata，但不要打印/复制它：其中有 authToken。脚本不自动搜索 profile。
元数据 ID 不符、响应不带相符 `_meta.runtimeId` 或 socket 被拒绝都停止。

以下变量均为**用户已确认的输入**，不能照抄占位符执行；`SKILL_DIR` 是本 skill 的绝对目录。
`PRIVATE_DIR` 是已批准的持久私有目录，不是公共 checkout。`params.json` 是 JSON object。

```bash
python3 "$SKILL_DIR/scripts/rpc.py" \
  --metadata "$METADATA_PATH" --runtime-id "$RUNTIME_ID" \
  --method github.listWorkItems --params-file "$PRIVATE_DIR/list-params.json"
```

列表参数示例（需替换 repo ID、标签）：

```json
{"repo":"id:<owner-repo-id>","query":"is:issue is:open label:agent-ready","limit":20,"page":1,"noCache":true}
```

同一方式可调用的只读方法：

| 方法 | 参数 | 用途 |
| --- | --- | --- |
| `status.get` | `{}` | runtime/能力/退化状态 |
| `repo.show` | `{"repo":"id:<repo-id>"}` | 路径、归属、repo 配置 |
| `github.repoSlug` / `github.repoUpstream` | 同上 | 核对 issue source 与 fork/upstream，不能只用 checkout origin 猜 |
| `github.listWorkItems` | 上例 | 候选，限制页数并记录未覆盖范围 |
| `github.workItem` / `github.workItemDetails` | `{"repo":"id:<repo-id>","number":123,"type":"issue"}` | 当前状态、标题/URL及详情（两个响应形状不同，不预设同一 schema） |
| `worktree.list` | `{"repo":"id:<repo-id>","limit":100}` | 检查 truncated 与 hostScope，再对每条核验 |
| `worktree.show` | `{"worktree":"id:<完整worktree.id>"}` | 绑定与 taskWorkspace readiness |
| `worktree.createStatus` | `{"repo":"id:<repo-id>","limit":20}` | 任务 sparse 创建日志，只读对账，不是通用幂等查询 |
| `terminal.list` | `{"worktree":"id:<完整worktree.id>"}` | 新工作区的终端 |
| `terminal.show` | `{"terminal":"<handle>"}` | 终端身份与事实 |
| `terminal.read` | `{"terminal":"<handle>","limit":1000}` | 启动证据；后续按原生 cursor 分页 |

返回原生 envelope `{id,ok,result|error,_meta}`，不能只看进程退出码。
只读 RPC 不表示零网络/缓存活动；此处含义是不会创建工作区/Agent 或改写 issue。

## 固定创建请求

这是字段说明示例，**不是可执行的授权**。所有占位符必须来自读回事实和用户授权。
`baseBranch` 替换成完整 40 位 commit SHA，不能用移动的 `main` 代替。
`projectId` 从目标 project/host setup 取得，不凭字符串规则推导。

```json
{
  "repo": "id:<owner-repo-id>",
  "name": "issue-123-short-description",
  "baseBranch": "<confirmed-40-character-commit-sha>",
  "linkedIssue": 123,
  "linkedWorkItem": {
    "provider": "github", "type": "issue", "number": 123,
    "title": "<verified title>",
    "url": "https://github.com/<owner>/<repository>/issues/123",
    "repoId": "<owner-repo-id>"
  },
  "linkedTaskSourceContext": {
    "kind": "task-source", "provider": "github",
    "projectId": "<verified-project-id>",
    "hostId": "local", "repoId": "<owner-repo-id>",
    "providerIdentity": {
      "provider": "github", "host": "github.com", "owner": "<owner>", "repo": "<repository>"
    }
  },
  "noParent": true,
  "setupDecision": "skip",
  "activate": false,
  "startupAgent": "<approved-agent-id>",
  "startupPrompt": "<brief: issue, goal, authority, scope, tests, budgets, archive, stop conditions>",
  "clientMutationId": "<one-fixed-unique-operation-id>"
}
```

`hostId: local` 表示当前**被调用的 owner runtime**本地拥有，不是桌面 context 中的 local。
带 SSH/WSL/paired 委托的 repo 不在此 helper 创建范围；不可改个 hostId 冒充本地。
若 repo 存在 `projectHostSetupId`，在 context 中保留已核验值。不要填 CLI provenance 冒充 CLI。

需要 sparse 时增加：

```json
{"sparseCheckout":{"mode":"task-workspace-v1","directories":["<existing-directory>"],"requiredPaths":["AGENTS.md","<required-policy-or-test-file>"]}}
```

### 先预览，后显式执行

```bash
# 不连接 runtime、不建目录、不生成 intent、不启动 Agent；只验证和显示请求
python3 "$SKILL_DIR/scripts/rpc.py" \
  --metadata "$METADATA_PATH" --runtime-id "$RUNTIME_ID" \
  --method worktree.create --params-file "$PRIVATE_DIR/create-params.json"

# 仅在 skill 的授权、能力、去重与政策门检查完毕后
python3 "$SKILL_DIR/scripts/rpc.py" \
  --metadata "$METADATA_PATH" --runtime-id "$RUNTIME_ID" \
  --method worktree.create --params-file "$PRIVATE_DIR/create-params.json" \
  --execute --state-dir "$PRIVATE_DIR/launch-intents" --timeout 180
```

首条输出 `mode: preview, sent: false`。第二条先以 O_EXCL 创建私有意图文件（0600，fsync），
再一次 RPC；回执另存 `.response.json`（不包含 metadata/authToken）。参数文件和回执可能含任务敏感
信息，须按私有政策保存，报告中用摘要/hash 引用。state-dir 只能由本 launcher/操作者写入。

同 profile 使用**同一 state-dir**，它不随进程或 runtime 重启变化；同 repo/provider issue 的意图已存在
就拒绝再次提交（并发同目录也如此）。这是刻意保守：崩溃在发送前也可能留下未发送意图；
只读核对后由操作者处理。不能删掉它、换目录、换 repo ID 或修改配置来“重试”。
原生 clientMutationId 的去重不当成跨重启持久保证；本地 journal 也不替代原生事实。

helper 仅校验有限字段、防意外写方法和同目录重复提交。**它不是安全沙箱、授权签发器或完整
工作流引擎**：用户授权来源、候选资格、预算、单一启动者、host/source 一致性与实时已有绑定
仍由 skill 执行者按 SKILL.md 核验。换脚本/直连 API 不会获得额外权限。

## 源码核对入口（仅源码布局，不随控制平面产物发布）

下列为仓库相对代码定位，不是运行时需要安装的依赖：

- `orca/src/cli/runtime/transport.ts`：Unix RPC NDJSON、authToken、keepalive、请求 ID。
- `orca/src/shared/runtime-bootstrap.ts`：`orca-runtime.json` 与 transports/legacy transport。
- `orca/src/shared/rpc-contract/github-repo-work-item-params.ts`：查询/详情请求。
- `orca/src/main/runtime/rpc/methods/github-repo-work-item-methods.ts`：方法注册。
- `orca/src/shared/rpc-contract/worktree-create-params.ts`：创建字段与 clientMutationId。
- `orca/src/main/runtime/rpc/methods/worktree.ts`：创建/去重、show、createStatus。
- `orca/src/shared/rpc-contract/worktree-params.ts`：task sparse mode 与 requiredPaths。
- `orca/src/shared/task-source-context.ts`、`workspace-linked-item.ts`：绑定/source 结构。

## 验证与已知边界

离线定向测试（源码仓库 `swarm/` 下，串行 1 job）：

```bash
env -u SWARM_WORKER_PROFILES -u RSI_CHECKER_TEST_ROOT \
  PYTHONPATH=.:tests python3 -B -m unittest core.test_auto_evolve -v
```

测试覆盖 preview 无副作用、写方法白名单、请求身份/sparse 校验、排他意图与未知结果、
Unix framing/keepalive/响应身份。它们不证明真实 Agent 收到任务、UI 显示一致、跨设备互斥或业务完成。
真实创建 + 关联 + Agent 首轮任务的端到端验证需要单独获准的 issue/工作区/费用预算。
安装、发布和定时调用均不由添加这个 skill 自动发生。
