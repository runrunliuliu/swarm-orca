# 版本指针：主机上哪一份构建是 `orca`

状态：**契约 + 已实现并在一台 headless 主机上完成端到端切换**。实现见
`orca/src/shared/build-pointer.ts`（契约与只读解析）、`orca/src/main/cli/build-pointer.ts`（发布与脚本生成）、
`orca/src/main/orcad/orcad-build-pointer.ts`（orcad 发布）。端到端验证 = 发布 → 重启 orcad → 裸 `orca`
与 PTY 内的 `orca` 都解析到新构建（`--version --json` 报 `source=pointer` 与产物的 `buildId`，
且在 PTY 子进程里实测）。具体主机、命令与输出留在任务归档，不写进本仓库。仍未做的部分见文末。

## 问题（为什么版本号不够）

同一台机器上可以同时存在多份都叫 `orca` 的产物：

| 产物 | 发布者 | 构建时间 | `worktree create --sparse-task-dir` |
| --- | --- | --- | --- |
| Electron 应用（`squashfs-root/resources/bin/orca-ide`） | Electron 主进程 | 2026-10-25 | ❌ |
| `orcad` 产物（`bun-runtime cli/index.cjs`） | 无（PTY 环境变量另写一份 shim） | 2026-11-11 | ✅ |
| 本仓库 dev 构建（`orca/out/bin/orca-dev`） | 开发者 | 每次构建 | ✅ |

- `orca/package.json` 从上游导入起一直是 `1.4.219`，orcad 一直是 `0.1.0`；仓库没有 git tag。
  **版本字符串因此不是构建身份**，只有安装目录名里的构建 sha（`orcad-apex-0.1.0-4046bdb7dbaa`）是。
- 旧实现把"用哪一份"写死在每个消费者各自生成的脚本里：Electron serve 写 `~/.local/bin/orca`
  （`exec /opt/orca/1.4.219/...`），orcad 写 PTY 用的 `linux-orca-cli-shim/orca`
  （`exec <orcad 目录>/...`）。两边各自指向自己，谁都不是"本机当前构建"，而 `~/.local/bin/orca`
  只在 Electron 启动时被重写，所以 headless 升级**永远不会**改变裸 `orca` 指向——实测就是
  `orca --version` 报 `1.4.219`、而运行时是 `0.1.0+4046bdb7dbaa`。

## 契约

### 指针

```
<pointer> = /opt/orca/current          # 可用 ORCA_BUILD_POINTER_PATH 覆盖
```

`<pointer>` 必须是**符号链接**，目标是一份产物根目录（`/opt/orca/<artifact>-<version>-<buildsha>` 或
Electron 的 `/opt/orca/<version>`）。指向同一父目录时写相对链接，否则写绝对路径；两种都可解析。

`<pointer>` 是**唯一**的"本机当前构建"声明。消费者必须从它解析，不允许各自记住自己是谁。

### 产物根目录必须携带的两个文件

| 文件 | 内容 | 谁写 |
| --- | --- | --- |
| `.orca-build.json` | 身份文档（下表） | 发布者（切指针之前） |
| `.orca-cli-argv` | 一行一个 argv 元素，第一行是可执行文件 | 发布者（切指针之前） |

```json
{
  "schemaVersion": 1,
  "artifact": "orcad",
  "version": "0.1.0",
  "buildId": "4046bdb7dbaa",
  "buildTarget": "linux-x64-glibc",
  "installDir": "/opt/orca/orcad-apex-0.1.0-4046bdb7dbaa",
  "cli": { "executable": "/opt/orca/orcad-apex-0.1.0-4046bdb7dbaa/bun-runtime",
           "args": ["/opt/orca/orcad-apex-0.1.0-4046bdb7dbaa/cli/index.cjs"] },
  "publishedAt": "2026-11-12T06:00:00.000Z",
  "publisher": { "kind": "orcad", "pid": 4242, "version": "0.1.0" }
}
```

- `artifact`：`orcad` | `electron-app`。两种产物共用一套指针，但打包/更新方式不同，所以必须可区分。
- `buildId`：构建 sha（7–40 位小写十六进制），**允许为 `null`**——Electron 侧没有可读的构建 sha，
  此时身份由 `installDir` + `publishedAt` 承担，不编造。
- `installDir`：必须是产物根的**真实路径**，且必须等于指针解析后的真实路径。复制出来的目录
  仍声称原 `installDir` 时判为 `install-dir-mismatch`：拷贝不是发布。
- `.orca-cli-argv` 是给 shell 的一等公民：orcad 的 CLI 不是一个可执行文件，而是
  `bun-runtime cli/index.cjs`。让脚本自己 `read` 这个文件，就不需要在 bash 里解析 JSON。

### 解析结果（闭集）

| 状态 | 含义 | 消费者行为 |
| --- | --- | --- |
| `ok` | 指针可解析、身份可读、`installDir` 一致、CLI 存在且可执行 | 执行 `.orca-cli-argv` |
| `missing` | 指针不存在（自包含安装：用户自己下载的 AppImage） | 用**自身**启动器（不是"某个旧目录"）；`ORCA_BUILD_POINTER_REQUIRED=1` 时改为报错 |
| `dangling` | 链接在、目标不在 | **fail-closed**，明确报错，不回落 |
| `invalid` | `pointer-not-a-symlink` / `identity-missing` / `identity-invalid` / `install-dir-mismatch` / `cli-executable-missing` / `cli-not-executable` | **fail-closed**，明确报错，不回落 |

"缺失"与"坏掉"是两件事：前者是自包含安装的正常状态；后者意味着本机声明了一份用不了的构建。
后者永远不回落——否则半截发布会让整机静默继续跑旧构建，这正是原来的问题。

### 发布者（谁写）与刷新时机

| 场景 | 发布者 | 时机 |
| --- | --- | --- |
| headless `orcad` 启动 | `publishOrcadServingBuildPointer`（`src/main/orcad/orcad-build-pointer.ts`） | RPC transport 成功 bind 之后（`orcad-entry.ts`）。失败只 `console.warn`，不影响服务 |
| Electron `--serve` 启动 | `publishOrcaBuildPointer` + `buildElectronServingBuildIdentity`（`src/main/startup/main-process-runtime-launch.ts`） | CLI 安装之后 |
| 安装/升级 | 产物安装脚本（本仓库不提供） | 安装完成后 |

发布顺序是契约的一部分：**先**写两个身份文件，**后**用 `rename` 原子替换符号链接。读者只会看到旧目标
或新目标，不会看到不存在的链接；也不会看到"新链接 + 旧身份"。同一个构建重启时不重写 `publishedAt`，
重复启动返回 `unchanged`。

**部署前提（实测不满足时）**：默认路径 `/opt/orca/current` 要求服务账号对 `/opt/orca` 有写权限；
在本机 `/opt/orca` 是 `root:root 755` 而 orcad 以普通账号运行，发布会被拒并打印
`build pointer not published: EACCES ...`（不静默，也不阻止服务启动）。此时 dispatcher 仍写成“跟随指针 +
回落到本进程 CLI”，裸 `orca` 会落到最近一次以该方式启动的构建。要让指针契约真正生效，上线前必须二选一：
用 root 做一次性 provisioning 给出服务账号可写的指针位置，或用 `ORCA_BUILD_POINTER_PATH` 指到该账号可写的目录
（脚本会把该路径烘进去）。

发布 `orcad` 时同时刷新 `~/.local/bin/orca`（若该文件是本安装器写的、或不存在）：脚本改为跟随指针，
不再写死本次构建的路径。这是"headless 更新后裸 `orca` 跟着变"的关键——旧实现里这个文件只由
Electron 主进程写。

### 消费者（谁读）

| 消费者 | 行为 |
| --- | --- |
| `~/.local/bin/orca`（裸 `orca`） | 指针跟随脚本：`readlink -f` → 读 `.orca-cli-argv` → `exec`；悬空/无身份时退出 1；并把 `ORCA_BUILD_POINTER_PATH` 导出给被 exec 的 CLI，使 `--version --json` 报告的是**同一个**指针 |
| PTY shim（`linux-orca-cli-shim/orca`、orcad 的 `getCliEntryPath` 路径） | 同上，额外注入 `ORCA_USER_DATA_PATH`/`ORCA_CLI_COMMAND` |
| `orca --version --json` | 读指针，输出身份与指针状态（见下） |

裸 `orca` 的脚本由 `installBareOrcaBuildPointerDispatcher` 写，`isOwnedDispatcher`（普通文件 + 第 2 行
marker）保证不覆盖用户自己的 `~/.local/bin/orca`。

## `orca --version --json`

```bash
$ orca --version --json
{
  "schemaVersion": 1,
  "version": "0.1.0",
  "artifact": "orcad",
  "buildId": "4046bdb7dbaa",
  "buildTarget": "linux-x64-glibc",
  "installDir": "/opt/orca/orcad-apex-0.1.0-4046bdb7dbaa",
  "cli": { "executable": ".../bun-runtime", "args": [".../cli/index.cjs"] },
  "source": "pointer",
  "pointer": { "path": "/opt/orca/current", "state": "ok", "reason": null, "required": false },
  "local": { "version": "0.1.0", "installDir": "/opt/orca/orcad-apex-0.1.0-4046bdb7dbaa" }
}
```

- `source`：`pointer` = 报告描述的是指针指向的那份构建；`local-package` = 指针不可用，报告描述的是
  本进程自己的 package 边界。两者不合并、不猜测。
- 退出码：`ok` → 0；`missing` 且未要求指针 → 0（自包含安装）；`missing` 且
  `ORCA_BUILD_POINTER_REQUIRED=1` → 1；`dangling`/`invalid` → 1，且 stderr 给出一行原因。
- 纯 `--version` 输出不变（仍是一行版本字符串），现有版本审计不受影响。

## 排障

```bash
readlink -f /opt/orca/current                  # 指针最终指向哪
cat /opt/orca/current/.orca-build.json         # 那份构建自称是谁
cat /opt/orca/current/.orca-cli-argv           # 裸 orca 实际会 exec 什么
orca --version --json | jq '{source,buildId,pointer}'   # 消费者看到的结论
orca --version                                 # 版本字符串（不是构建身份）
```

| 现象 | 判定 |
| --- | --- |
| `--version --json` 的 `pointer.state=dangling` | 产物目录被删/被移动；重新发布或删掉指针 |
| `state=invalid` + `install-dir-mismatch` | 目录被复制而身份没重写；用发布器重新发布 |
| `state=missing` 且本机本该有指针 | 服务从未成功发布（看 `[orcad] build pointer` / `[serve] build pointer` 日志） |
| 终端里 `orca` 报 `build pointer ... is unusable` | 指针坏；不要删 shim，修指针 |
| `~/.local/bin/orca` 仍 `exec /opt/orca/<旧目录>` | 该文件是旧版安装器写的；下一次 orcad/Electron serve 启动会改写成指针跟随脚本 |

## 未验证 / 未做

- ~~真实主机上的端到端切换~~ **已执行**：发布指针 → 重启 orcad → 裸 `orca --version --json` 报
  `source=pointer` + 新 `buildId`，PTY 内 `orca` 同样解析到新构建，悬空指针仍 fail-closed。
  证据（部署前后命令与输出、回滚引用）在任务归档，不在本仓库。
- Electron 侧发布需要能写产物根目录；`/opt/orca/1.4.219` 属 root，普通用户发布会被拒并打印
  `[serve] build pointer not published: ...`（故意不静默）。Electron 从本 fork 重新打包后才会带
  这套逻辑。
- 安装/升级脚本（在私有部署侧）尚未调用发布器；当前只有两个服务启动路径会发布。
- Windows 不在契约内：裸 `orca` 的 Windows 分发走 `resources/bin/orca.exe`，指针脚本是 bash。
