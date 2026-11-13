# 控制平面发布：把部署输入做成不可变产物

状态：**设计草案，未实现**。本文只描述契约形状与边界，不含可执行脚本、不改任何现有入口、
不迁移既有 Run 的 pins。发布产物、切指针、安装技能都需要各自授权；本文不构成其中任何一项。

配套私有材料：宿主落地（`/opt` 权限、本机路径清单、技能安装缺口）留在私有工作区，
不写进本目录。

## 1. 问题

能力、部署输入、项目材料三类输入现在的归属不一致：

| 输入 | 内容 | 现在在哪 | 应该在哪 |
| --- | --- | --- | --- |
| 能力 | `swarm-orchestration`、`worktree-delivery`、`orca-cli`、`orchestration` | 用户级 `~/.agents/skills`（各 agent 覆盖不一致） | 用户/机器级 |
| 部署输入 | 启动器代码、Coordinator 模型与 runtime、Worker 白名单、CLI 选择、归档/台账政策 | 某个源码 checkout 的某个目录 | 机器级、版本化、不可变 |
| 项目材料 | `AGENTS.md`、领域/角色技能、归档落点 | 目标项目仓库 | 目标项目仓库 |

中间一层被放在“一份可变的开发检出 + 当前工作目录”上，因此任意新项目都会断开：
技能刻意不携带私有策略，公开代码刻意不向父目录搜索私有配置，Orca 的 project setup
只保存 `path` / `worktreeBasePath` 等字段，没有 env 或配置承载位。

结论：需要一个**机器级指针 + 不可变发布产物**，让任意项目在零配置的情况下解析到同一套
部署输入，同时保住“路径即身份、内容不可变、切换可回滚”。

## 2. 产物形状

```text
/opt/swarm/swarm-control-plane-<buildId>/
├── .swarm-build.json      # 身份文件（§3.1）
├── MANIFEST.sha256        # 逐文件摘要（§3.2）
├── code/                  # = swarm-orca/swarm/（保内部相对结构），另含 code/AGENTS.md
├── private/               # = 私有 swarm/ 的政策、acceptance、配置 JSON
├── overlay/               # = 私有根 skills/ 的入口材料
├── workspace/             # = 源码根 AGENTS.md、索引与目录策略
├── NOTICE.md              # = swarm-orca/NOTICE.md（许可证边界，必带）
├── MIGRATION_STATUS.md
└── README.md
/opt/swarm/current -> swarm-control-plane-<buildId>    # 唯一“本机当前控制平面”声明
```

顶层目录可以重命名（脚本与入口只依赖 `code/` **内部**的相对位置）；`code/` 内部层级不得重排。

### 2.1 白名单（实测大小，2026-11-12 观察值）

| 来源 | 大小 | 进产物 | 理由 |
| --- | --- | --- | --- |
| `swarm-orca/swarm/`（排除 `tests/`、`__pycache__/`） | 14M → 约 5M | ✅ `code/` | 启动器、协议、`code/skills/` |
| `swarm/` 的政策与配置（排除 `tests/`、`__pycache__/`、`docs/validation/`、`trials/`） | 6.6M | ✅ `private/` | 模型/runtime/白名单/归档政策 |
| 根 `skills/` | 140K | ✅ `overlay/` | 私有路由入口（如 runtime selection） |
| 根 `AGENTS.md`、`swarm-private-integration.md`、`workspaces.json`、`workspace-directory-policy.md` | 小 | ✅ 产物根 | 策略与索引，供角色读取 |
| `swarm-orca/{AGENTS.md,README.md,MIGRATION_STATUS.md,NOTICE.md}` | 小 | ✅ 产物根 | 许可证与公开边界（NOTICE 必带） |
| `swarm-orca/orca/` | 2.5G | ❌ | CLI 开发检出；`orca-cli`/`orchestration` 是发现桩，正文由选定的二进制用 `orca skills get` 提供 |
| `.git/`（含子模块 git） | 241M | ❌ | 身份改由 `.swarm-build.json` 记录 commit |
| `remote-server/`、`pi-extensions/`、`training-monitor/`、`retrospective/`、根 `docs/` | 约 1.5M | ❌ | 与本产物无关 |
| `.vscode/`、`.codex/`、`.aws/`、`.trae/`、`.agents/` | — | ❌ | 按项目放置的本地/凭据配置，机器级产物不得携带 |
| `__pycache__/`、`tmp/`、`draft_*` | 约 4M | ❌ | 生成物 |

### 2.2 为什么不能“只把 py 和 skills 拎出来”

三条硬约束，来自实际布局：

1. `code/` 顶层约 100 个 `.py` **平铺同级**，互相按裸模块名 import；`supervisor/`、
   `swarm_ledger/`、`release_radar/` 带 `__init__.py`。扁平化会直接 import 失败。
2. 多个模块用 `__file__` 相对定位拼下一步 argv（例如 `coordinator_strict_start.py` 取
   `with_name("coordinator_launch.py")`，`startup_handoff.py` 同理）。兄弟文件必须原地相邻。
3. 相邻数据文件是运行时输入：`coordinator_worker_profiles.py` 读同级
   `worker-model-profiles.json`；`evidence_policy.py` 收集同级文件清单；
   `operator_monitor_deploy.py` 以自身目录为 `SOURCE_ROOT` 部署 monitor。

另外 `code/skills/` 内部 references 使用 `../../` 相对引用（例如
`code/skills/swarm-orchestration/SKILL.md` 指向 `code/README.md`、`code/configuration.md`），
压平或拆散都会断链。

## 3. 身份与摘要

### 3.1 `.swarm-build.json`

```json
{
  "schemaVersion": 1,
  "artifact": "swarm-control-plane",
  "buildId": "<sha12>",
  "source": {
    "orcaSrcCommit": "<40/64 hex>",
    "swarmOrcaCommit": "<40/64 hex>",
    "branch": "<branch>",
    "dirty": false,
    "dirtyPaths": []
  },
  "copyRuleVersion": 1,
  "included": ["..."],
  "excluded": ["..."],
  "host": "<host>",
  "deployUser": "<user>",
  "deployedAt": "<ISO8601>"
}
```

规则：

- `buildId` 由被复制内容的身份派生并进入目录名，因此**路径即身份**。
- `dirty: true` 时发布必须显式 `--allow-dirty`，并在产物上标记“不得作为 Run 的 pin 来源”；
  readiness 读取到该标记即拒绝生成带 pin 的启动计划。
- 不持久化任何一次性的回执字段；`MANIFEST.sha256` 是文件级事实，身份文件是发布级事实。

### 3.2 `MANIFEST.sha256`

逐文件摘要，格式与 `sha256sum` 兼容，路径相对产物根。任何校验方都应能仅凭产物与清单证明
“这份产物没有被就地改过”。

## 4. 发布流程

```text
1. 校验源：读 commit、branch、子模块 commit；工作树非空脏文件时要求 --allow-dirty
2. 复制白名单到 <产物根>.new/（先不触碰 current）
3. 在 <产物根>.new/ 内生成 .swarm-build.json 与 MANIFEST.sha256
4. 自检：清单可复算、入口可导入、指针身份与实际路径一致
5. mv <产物根>.new <产物根>；用 rename 原子替换 current
6. 保留上一份产物目录供回滚
```

边界：

- 发布**不启动**任何 Agent、Run、monitor 或 scheduler，也不修改已有 Run 的 pins。
- 复制失败或自检失败时保留临时目录供诊断，不切换指针、不清理上一份产物。
- 指针切换是可回滚的原子动作，但“切换指针”与“部署/重启服务”是两件事，各自授权。

### 4.1 工具接口

实现：`deploy/publish_control_plane.py`（`python3 -B`，仅标准库）。默认模式是只读的。

| 模式 | 作用 | 必需参数 |
| --- | --- | --- |
| `plan`（默认） | 打印白名单结果、生效的排除项、文件数与内容寻址的 `buildId` | `--source-root` |
| `publish` | 在 `--artifact-root` 下新建产物；拒绝已存在的目标、脏源与无法固定的源 | `--source-root`、`--artifact-root` |
| `verify` | 复算清单并与身份文件比对 | `--artifact` |

| 开关 | 语义 |
| --- | --- |
| `--allow-dirty` | 允许发布含未提交修改的源；产物在身份文件里保留脏路径，只可作本地试验 |
| `--allow-unpinned-source` | 允许 git 无法描述源（非仓库/不可读）时发布；身份记为 `unpinned` |
| `--switch-pointer <symlink>` | 发布成功后用 `os.replace` 原子切换指针；父目录缺失或指针不是符号链接即拒绝 |
| `--json` | 输出机器可读报告 |

拒绝语义与退出码：`0` 成功；`2` 用法错误；`78` 前置或完整性检查失败，stderr 只给一行原因
（`source-dirty`、`source-unpinned`、`artifact-exists`、`destination-collision`、
`install-dir-mismatch`、`manifest-mismatch`、`pointer-not-a-symlink` 等），不尝试修复、不回退默认值。

只读模式不写任何文件；`publish` 只写 `--artifact-root` 下的临时目录与最终产物，不改源树、
不清理旧产物。`verify` 拒绝被搬移过的产物：身份文件里的 `installDir` 必须等于实际路径。

## 5. 指针语义

复用 [`cli-version-pointer.md`](../design/cli-version-pointer.md) 的闭集，不新增第二套解析规则：

| 状态 | 含义 | 消费者行为 |
| --- | --- | --- |
| `ok` | 指针可解析、身份可读、`installDir` 与真实路径一致、清单可复算 | 使用该产物 |
| `missing` | 指针不存在（自包含部署） | 报告“本机未声明控制平面”，要求显式路径 |
| `dangling` | 链接在、目标不在 | fail-closed，不回落 |
| `invalid` | 非符号链接、身份缺失/非法、`installDir` 不一致、清单不符 | fail-closed，不回落 |
| `dev-checkout`（新增） | 指针指向可变的开发检出 | 显式降级：可用于本地试验，禁止作为 pin 来源 |

`dev-checkout` 是唯一为“开发态”保留的状态：它必须在报告里与 `ok` 分开，不能伪装成已发布产物。
判据至少包含：目标不是 `swarm-control-plane-*` 目录名、缺身份文件、或源工作树处于脏状态。

## 6. 消费者契约：只读 readiness

只读入口：`control_plane_readiness.py`，对任意项目输出四块：

1. **控制平面**：指针状态、`buildId`、两个 commit、配置逐文件 hash；
2. **能力安装**：本 agent 类型是否装到 `swarm-orchestration` / `worktree-delivery` /
   `orca-cli` / `orchestration`，以及解析出的真实路径与 frontmatter 名称；
3. **项目材料**：`AGENTS.md`、领域/角色技能、binding 文件是否存在；
4. **缺失项与计划**：缺失清单 + 将要使用的 argv 与环境，`max_workers` 一律标注“待用户确认”。

fail-closed 条件（任一命中则不输出可执行计划）：指针 `dangling`/`invalid`、
身份与清单不符、`dev-checkout` 且请求带 pin、必需配置缺失或 hash 不符。

readiness 不创建 worktree、不建 Run、不启动 Agent、不写任何状态；它不是启动授权。

### 6.1 工具接口

| 参数 | 语义 |
| --- | --- |
| `--project <dir>`（必需） | 报告对象；不搜索父目录，不根据 cwd 猜测 |
| `--control-plane <dir>` | 显式产物目录或开发源根；给定时跳过指针 |
| `--pointer <path>` | 指针路径，默认 `/opt/swarm/current` |
| `--agent <agents\|pi\|claude\|codex\|trae>` | 报告哪个 agent 的技能安装（默认 `agents`） |
| `--skills-dir <dir>` | 覆盖技能目录，用于审计与测试 |
| `--artifacts <dir>` | 产物/证据根必须先存在，否则阻断 |
| `--require-pin` | 要求已发布且可核验的控制平面；`dev-checkout` 即阻断 |
| `--json` | 机器可读报告 |

退出码：`0` 就绪，`2` 用法错误，`78` 阻断（stderr/stdout 只给原因，不自动修复）。
报告不写入任何文件，也不修改被测项目的状态。

## 7. 私有配置与公开基线的隔离

`coordinator_worker_profiles.py` 在 `SWARM_WORKER_PROFILES` 未设置时会回退到**相邻的公开
`worker-model-profiles.json`**。因此只发布代码 + 公开基线不会报错，而会静默使用公开白名单。

发布侧约定：

- 私有配置放进 `private/`，并在身份文件里记录逐文件 hash；
- readiness 必须显式给出私有路径与 hash，优先级高于环境变量，且两者不一致即 fail-closed；
- 不依赖外层 shell `export` 自动传递到新 Agent 或远端。

## 8. 验证与验收

验收必须在**产物副本**上进行，不得用源 checkout 代替：

| 用例 | 期望 |
| --- | --- |
| 正例：任一与源码 checkout 无关的新项目 | 输出完整计划，`max_workers` 标未确认，不启动任何 Agent |
| 负例：删除该项目的 `AGENTS.md` 或角色技能 | 具体列出缺失项并拒绝，不去父目录搜索、不静默降级 |
| 负例：`SWARM_WORKER_PROFILES` 未设且产物无私有白名单 | 拒绝，不回退公开基线 |
| 负例：指针指向旧产物或被就地改过 | `invalid`，hash 不符即停 |
| 负例：指针指向脏开发检出 | `dev-checkout`，拒绝作为 pin 来源 |

## 9. 不做与不承诺

- 不实现写入硬隔离：指针与 cone 都不是授权边界。
- 不自动跨主机传播产物、不自动切换指针、不自动清理旧产物。
- 不代做技能安装（各 agent 的安装矩阵是独立部署动作）。
- 不迁移、不刷新既有 Run 的 pins 与历史配置。
- 不改变公开代码“不向父目录搜索私有配置”的规则；指针是唯一且显式的机器级输入。

## 10. 兼容

- 现有“显式传入绝对路径 + SHA”的交接方式继续有效，本契约不取代它，只提供机器级默认入口。
- 未发布指针时，`missing` 为正常状态；已有 Run 仍按原 pins 读取。
- 产物目录命名与身份字段可扩展，但 `schemaVersion` 之外的未知形态一律读作不可用，不猜测。
