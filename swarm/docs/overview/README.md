# swarm-orca 项目概览图

一页概览，突出设计理念、核心创新与在 AI Coding 方向的定位。本图是介绍材料，
不构成部署、启动 Agent 或任何权限授权；各能力的实现状态以对应设计文档为准。

| 文件 | 用途 |
| --- | --- |
| [swarm-orca-overview.svg](swarm-orca-overview.svg) | 正式版矢量图（1920×1080），可编辑、可直接嵌入文档 |
| [swarm-orca-overview.png](swarm-orca-overview.png) | 由 SVG 以 2 倍分辨率渲染的位图，用于 PPT / 飞书 |
| 本文 Mermaid 源码 | 结构草稿，便于快速改内容后重新排版 |

![swarm-orca 项目概览](swarm-orca-overview.png)

## Mermaid 源码

```mermaid
flowchart LR
    subgraph P["设计理念"]
        direction TB
        P1["事实优先<br/>未知不记 0，完成 ≠ 验收"]
        P2["权限分离<br/>签发者 ≠ 执行者"]
        P3["分层解耦<br/>控制平面 / 领域 / 底座"]
        P4["敢做减法<br/>无可验证收益即退役"]
        P1 --- P2 --- P3 --- P4
    end

    subgraph A["核心架构"]
        direction TB
        T["任务层 ④<br/>独立修改任务为隔离单位 · 多仓专属 worktree"]
        subgraph CP["控制平面（swarm-orca 新增）②③"]
            direction LR
            C["Coordinator<br/>业务决策"] --> D["Driver<br/>同会话续跑"] --> O["Operator<br/>特权执行"]
        end
        DA["领域适配层<br/>角色技能 + 契约检查器 + SHA256 固定引用"]
        R["Orca 底座 ①⑤<br/>Run / 任务 / 派发 / 投递持久化 · 故障落盘"]
        AG["异构 Agent<br/>Codex · Claude Code · OpenCode · Pi · Trae"]
        T --> CP --> DA --> R --> AG
    end

    subgraph L["AI Coding 演进与定位"]
        direction TB
        L4["L4 可治理 Agent 集群 ★ swarm-orca<br/>可信地交付一项工程"]
        L3["L3 多 Agent 并行工作台<br/>并行推进多个任务"]
        L2["L2 单 Agent 终端<br/>自主完成单个任务"]
        L1["L1 代码补全<br/>补全一段代码"]
        L1 --> L2 --> L3 --> L4
    end

    P ~~~ A ~~~ L

    subgraph I["五大创新"]
        direction LR
        I1["① 编排层可恢复<br/>已实现"]
        I2["② 未知结果不盲重提<br/>已实现"]
        I3["③ 启动凭据 Start Grant<br/>已实现 · 强制开关未开"]
        I4["④ 任务级工作区隔离<br/>最小版已交付 · 路由设计中"]
        I5["⑤ 故障自沉淀与自修复<br/>已实现"]
    end
    A ~~~ I

    classDef cp fill:#EDF2FF,stroke:#3B5BDB,stroke-width:3px
    classDef hi fill:#3B5BDB,color:#fff,stroke:#1F3A93
    class CP cp
    class L4 hi
```

## 内容依据

| 图中内容 | 依据 |
| --- | --- |
| 分层、单一控制路径、领域适配接入点 | [入口选择](../entry-paths.md) §3–§4 |
| ① 编排层可恢复、② 未知不盲重提 | 原生 Delivery / consumer generation / mutation receipt；[TUI 续跑](../../coordinator-tui.md) |
| ③ 启动凭据及其状态 | [start grant](../design/start-grant.md) §4.0（`START_GRANT_REQUIRED` 仍为 `false`） |
| ④ 任务级工作区隔离及其状态 | [任务工作区设计](../design/task-workspaces.md)、[稀疏任务工作区开发计划](../design/sparse-task-workspace/development-plan.md) §7 |
| ⑤ 故障自沉淀 | [故障沉淀设计](../design/issue-sedimentation.md)（M1–M8 已实现）、[Release radar](../../release_radar/README.md)、[incident-triage](../../skills/incident-triage/SKILL.md) |
| 敢做减法 | [Supervisor 退役记录](../supervisor.md)、start grant 对旧握手的替代 |
| 工程规模 | 2026-11-20 对本仓库 `main` 的统计：`swarm/` 下 `*.py` 约 53.7k 行（含测试，约 100 个测试文件）；`orca/src/main/runtime/orchestration` 非测试 TS 约 26.4k 行、126 个 `*.test.ts` |

状态口径：“已实现”指源码已合入主干，不等于已部署或已通过实机验收。L2 / L3 对比是基于公开能力的
定性归纳，不是逐项评测结果。

## 重新生成 PNG

修改 SVG 后，用 Chrome 无头模式按 2 倍分辨率渲染：

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu \
  --hide-scrollbars --force-device-scale-factor=2 --window-size=1920,1080 \
  --screenshot="$PWD/swarm-orca-overview.png" "file://$PWD/swarm-orca-overview.svg"
```
