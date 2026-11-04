# 日志与证据容量

本次维护移除因会话历史增长而拒绝读取的固定字节数、记录大小和累计页数门槛。
适用范围为本仓库的 Swarm 会话核验、证据读取、计量及 retrospective 源日志读取，
不是取消任务授权、资源预算或所有产品传输保护。

## 已移除的实现门槛

| 读取链路 | 原限制 | 当前行为 |
| --- | --- | --- |
| `trae_coordinator.py` | 会话日志 16 MiB；启动流 32 页 | 逐条扫描初始 EOF；启动流读至首次查询的末尾游标 |
| `trae_exec_capture.py` | 单条 JSONL 16 MiB | 单条记录完整解析，原始捕获仍完整保存 |
| `coordinator_driver.py` | 单文件及 checkpoint 输出 16 MiB | 完整读取并继续执行 pin、schema 和授权校验 |
| `native_preflight.py` | 输入 4 MiB、命令输出 2 MiB；只检查末尾 4 MiB 的会话设置 | 不设这些字节门槛；扫描初始 EOF 中最新完整设置；保留执行时限 |
| `progress_watch.py` | 输入／查询 8 MiB；部分配置／回执 16–64 KiB；Worker 清单 100 页 | 完整读取／分页；继续核对身份、total、重复记录与游标进展 |
| `swarm_ledger/runtime_binding.py` | 状态 16 MiB、日志 128 MiB、metadata 64 KiB | 读取初始 EOF 完整前缀，核对绑定和完整性 |
| `swarm_ledger/trae_jsonl.py` | 日志及捕获前缀 128 MiB | 不设总字节门槛，仍校验前缀锚点与计量语义 |
| `swarm_ledger/trae.py` | 快照／proxy 总响应 32 MiB | 完整读取，保留 RPC 白名单、脱敏及读取超时 |
| `swarm_ledger/binding_host.py` | 配置／metadata 64 KiB；必须配置不超过 256 MiB 的日志上限 | 默认无日志大小上限；显式正整数 `max_log_bytes` 仍生效且无实现上限 |
| Supervisor | receipt 16 MiB、证据产物 10,000,000 字节、信任配置 2,000,000 字节、Worker 清单 100 页 | 完整读取／分页；证据产物分块哈希，保留校验 |
| `coordinator_prepare.py/js` | 生成包 64 KiB、操作证据 100,000 字符 | 移除这两个容量拒绝条件；保留探针数量、schema 与工具验证 |
| `../retrospective/retro.py` | 源日志 64 MiB、metadata 1 MiB | 逐行读取初始 EOF，不因单个源文件历史增长而拒绝 |

MiB 为 1,048,576 字节。实现中的分块大小和 API 单页大小不是总历史上限。

## 快照与完整性

Coordinator 核验扫描开始时确定文件大小。之后新增的字节留给下一次观察，
末尾不完整 JSONL 不作为配置证据，但仍计入已观察前缀的 SHA256。
扫描仅保留 metadata 与最新完整 `turn_context`，再分块复核相同前缀哈希及路径、
device/inode，拒绝观测期间的截断、改写或替换。完整记录损坏、会话或设置不符
仍失败，不能通过跳过记录、裁剪历史、修改 freshness 或更换会话通过门禁。

通用流式读取在 `log_io.py`；它与调用方必须同版交付，并纳入文件探针 scope 的
源码哈希。旧源码／配置 pin 或探针 scope 不能冒充更新后已核验的证据。

不设固定字节门槛不意味着资源无限：逐行读取的内存随最大单条记录增长；部分 JSON
快照、RPC 响应与计量路径仍需在内存中保存完整数据。超大输入仍可能遇到内存、磁盘、
操作系统、原生 API 或既有执行时限，发生时应报告真实错误，不伪称完整覆盖。

## 保留的边界

- 身份／所有者／路径权限、符号链接策略、源码和证据 pin、schema、授权来源、
  新鲜度、超时、重试、Worker 并发和费用预算均不因本次容量变更放宽。
- 宿主配置中已有的显式 `max_log_bytes` 是操作者配置的资源政策，继续遵守；
  缺省或 `null` 表示无固定大小上限。示例已改为 `null`，不自动改写正在使用的配置。
- 绑定 socket 的 64 KiB 协议帧、`/proc` 字段边界、捕获器身份事件／PTY 转发边界
  继续保留。它们不承载完整历史日志；不得以“放开日志”为由扩大协议或身份输入。
- retrospective 的单轮 30 个候选源文件、最多 2 个会话片段、每会话 8×8000 字符
  及 20 分钟目标是工作量预算，保持不变，不宣称全历史复盘。
- `orca/` 产品源码中的 UI／传输边界本次未修改：AI vault 的 10 MiB
  单记录预算会跳过超大记录并提示；native chat 的 2 MiB 单记录边界也可能导致记录
  省略。Worker transcript 的 8 MiB 读取分页与 512 KiB wire payload、消息／块数
  和预览字符限制用于分页或展示，不应作为完整审计来源，也不是此次 Python 会话
  核验器的日志总大小门槛。调整它们需要单独处理产品协议、客户端及远端兼容性。

## 回归与生效范围

离线合成用例覆盖：55 MiB Coordinator 日志、超过 128 MiB 的计量日志、宿主默认
读取超过 256 MiB 的日志、超过 16 MiB 的单条输出、超过 32 MiB 的 proxy 响应、
超过 32／100 页的读取，以及位于尾部 4 MiB 之外的有效会话设置。
同时覆盖前缀追加／截断／改写／替换、pin 不符、身份不符、损坏记录和游标无进展。

验证命令分别在本目录和 `../retrospective` 执行：

```sh
python -m unittest discover -s tests
node --check coordinator_prepare.js
git diff --check
```

```sh
python -m unittest test_retro
```

2026-10-21 本地验证：Swarm 675 项、retrospective 11 项测试全部通过；
JavaScript 语法检查、Python compileall 及两个 Git 工作树的 diff whitespace 检查通过。

本次仅修改本地源码、测试和文档；没有分发、部署、重启服务、启动／恢复 Coordinator
或 Run，也未修改 fin_verl。合成日志通过不等于用户原始约 55 MB 会话已完成实际核验；
实际采用修复时须使用同版源码并按原授权流程重新核验，不能复用旧成功回执。
