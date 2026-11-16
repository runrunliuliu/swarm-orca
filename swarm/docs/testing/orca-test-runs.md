# Orca 测试怎么跑：本机资源约定

配套文件：[reliability.md](reliability.md)（Swarm 侧验收口径）、[AGENTS.md](../../AGENTS.md)（Tests 章节）。

本文只约定**在开发机上跑 `orca/` 的 vitest 测试时如何不把机器跑挂**，是一次运行方式的约定，
不是某次运行结果，也不放宽 `orca/AGENTS.md` 或验收口径。它不授权安装依赖、重装运行时、
重启服务或长时间占用共享机器。

## 1. 能跑什么、不能跑什么

先判断在哪一层，再决定命令。默认结论是**定向跑**，不是全量跑。

| 目标 | 能否在本机跑 | 备注 |
| --- | --- | --- |
| 单文件 / 单目录单测（`src/main/git`、`src/main/ipc` 等） | 可以，按第 2 节分批 | 依赖已备好的 `node_modules`；单批控制在几百个测试文件内 |
| 全仓单测（`pnpm test`、无路径的 `vitest run`） | 不要在这类机器上跑 | 一次拉起数千文件，见第 4 节事故 |
| 方向性静态检查（`typecheck:*`、`oxlint` 定向文件） | 可以 | 小改动常以此替代大范围 vitest |
| E2E / Playwright / Electron 构建 | 视依赖而定 | 需要 electron 二进制、headless 环境与更多内存；缺就报缺口（第 3 节） |
| 原生集成 / 真实 Agent 闭环 | 不在本文件范围 | 见 [reliability.md](reliability.md) |

判断依赖是否真的可用，而不是假设：

```bash
cd orca
ls -ld node_modules                     # 是否软链、指向哪里、目标是否还存在
ls node_modules/vitest/vitest.mjs        # vitest 入口
ls node_modules/electron/dist/electron   # E2E/构建所需，缺失则 E2E 不可跑
```

`node_modules` 若是指向 `/tmp` 之类的软链，先确认目标目录仍存在；目标被清理时表现为
入口文件缺失，而不是测试失败。这种情形按缺口报告，不要就地 `pnpm install` 或重建软链。

## 2. 安全跑法

三条硬约束，缺一不可：

1. **每次只给几个目录或文件**，不要一次传整个 `src`。
2. **显式加 `--maxWorkers=2`**，不要用默认并行度。
3. **分批**，单批不超过约 250 个测试文件；批次之间串行执行，不并发启动多个 vitest。

单批示例：

```bash
cd orca
node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts \
  --maxWorkers=2 src/main/git
```

相关但不同的目录分开跑，不要合并成一条大命令：

```bash
cd orca
for dir in src/main/git src/main/ipc src/main/runtime; do
  node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts \
    --maxWorkers=2 "$dir"
done
```

先估规模再决定切分（大目录尤其要切）：

```bash
cd orca
find src/main/runtime -name '*.test.ts*' | wc -l
find src/main/runtime -name '*.test.ts*' | sed -n '1,200p'   # 取一批显式文件
```

规模感参考（同一快照内的文件数，不是运行结果）：`src/main` 约 4.6k 个测试文件、
`src/renderer` 约 4.1k、`src/shared` 约 0.9k，其中 `src/main/runtime` 约 980、
`src/main/ipc` 约 470、`src/main/git` 约 150。跑之前先算，不要靠“应该不多”猜。

运行期间守着资源，超过下列任一征兆就停：

- `load average` 明显高于核数（见过 50+）且不回落；
- 网络盘 worktree 上 I/O 卡住、文件读写超时；
- 可用内存快速下降，或 `/tmp` 被大量占用。

失败后缩小范围重跑单个文件，**不要**通过提高并发、加大批次或并行开多个终端来“压过去”。

## 3. 失败与缺口怎么记录

报告要区分三种状态，不允许合并成一句“测试通过/失败”：

| 状态 | 含义 |
| --- | --- |
| 跑过并通过 | 记录了实际命令、目录/文件范围与结果；只覆盖所测范围 |
| 跑过但失败 | 记录命令、失败用例与首个错误；不因重跑偶然通过而覆盖旧结果 |
| 未跑 | 明确写出未跑的范围和原因（超时/资源/未获授权/依赖缺失） |

缺口（dependency gap）单独写，不算“未跑”的借口，也不算失败：

- `electron` 二进制缺失 → E2E、Electron 构建不可跑；**单测仍可跑**，按第 2 节正常执行并报告；
- 依赖树未准备、软链目标失效、网络盘不稳定 → 记 `BLOCKED`，写明解除条件；
- **不得**用安装/升级依赖、重建 `node_modules`、切换运行时来掩盖缺口；需要变更依赖时先报告再等授权。

最小报告样式：

```text
范围：orca/src/main/git（150 个测试文件，1 批）
命令：node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts --maxWorkers=2 src/main/git
结果：跑过并通过（3 个用例全部通过 / 或列出失败用例）
未跑：src/main/runtime（约 980 文件，需再切 5 批）、tests/e2e（electron 二进制缺失）
缺口：无 / electron 缺失（BLOCKED：E2E 与构建，单测不受影响）
```

“测试已添加”和“测试已执行”要分开写；定向通过只声明定向范围，不升级为全量结论。

## 4. 把机器跑挂过的教训

在一台 500GB 内存、约 31k 文件、worktree 位于网络盘的机器上，一次性跑全仓 vitest
（例如同时传 `src/main/git`、`src/main/ipc`、`src/main/runtime`）曾出现：

- `load average` 顶到 50+，I/O 长时间不可用；
- 会话被杀，机器上的 `/tmp` 被清理；
- 由于 `node_modules` 当时是指向 `/tmp` 的软链，清理后依赖树直接失效，后续所有 Node 命令一起不可用。

结论性规则：

1. 全仓 vitest 不是本机的常规操作，定向分批才是默认。
2. 并行度由人显式给（`--maxWorkers=2`），不依赖默认值。
3. 依赖树不要放在易被清理的临时目录；发现是指向 `/tmp` 的软链时，先报告再决定，别在测试里顺手修。
4. 机器资源异常时优先停测试、保留现场（命令、范围、失败首错），不要靠重试或加并发硬顶。
