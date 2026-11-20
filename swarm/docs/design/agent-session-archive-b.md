# agent session 归档（B）：本地写 + 异步归档到共享存储的第一阶段设计

状态：**B 已定为第一阶段方案**（issue #34，2026-11-19 决策）。本文是该方案**第一阶段的唯一设计记录**，
覆盖数据模型、写入语义、读取语义、6 项待拍板、验收矩阵与分阶段计划。

本文**不构成实现、不构成部署、不构成迁移**，也不授权对任何既有 session、Run、工作区或历史数据执行搬运、
清理或删除。本文定义的一切能力**当前均未实现**：仓库里不存在 collector、上传队列、共享 manifest 读写路径
或跨 host 读回代码（逐项状态见 [§1.4](#14-本文所定义的每一项能力的实现状态)）。

本文经过**八轮完整审查（r2–r9）**，另加**三轮增量确认（r10–r12）**。逐轮结论为：
r2 = 2 BLOCKER / 10 MAJOR / 2 MINOR；r3 = 1 BLOCKER / 6 MAJOR / 1 MINOR / 1 NIT；
r4 = 1 BLOCKER / 3 MAJOR；r5 = 1 BLOCKER / 2 MAJOR / 1 MINOR；r6 = BLOCKER 0 / 2 MAJOR / 1 MINOR；
r7 = BLOCKER 0 / 2 MAJOR / 0 MINOR；r8 = ACCEPT_WITH_FIXES，BLOCKER 0 / MAJOR 0 / 2 MINOR；
r9 = ACCEPT，BLOCKER 0 / MAJOR 0 / MINOR 0（另记非阻断 NIT 2，已在 §11.7.1 修正）；
r10 = ACCEPT，BLOCKER 0 / MAJOR 0 / MINOR 0（另记非阻断 NIT 1，对象 sha256 `83c10ec5…`、2087 行）；
r11 = ACCEPT，BLOCKER 0 / MAJOR 0 / MINOR 0（另记非阻断 NIT 1，对象 sha256 `11863f2d…`、2105 行）；
**r12 = ACCEPT，BLOCKER 0 / MAJOR 0 / MINOR 0 / NIT 0（对象 sha256 `b5214701…`、2106 行）**。
三轮都只是增量确认，逐条对照见 §11.9。BLOCKER 自 r6 起为 0、MAJOR 自 r8 起为 0；
r8 之后各轮的剩余项都只是**旧示例、验收措辞与状态导航**的定点清理，不涉及判定表本身。**r5 之后第一阶段的范围收窄为"每 session 一个写者"**（§5.4.2），
因为连续三轮的剩余缺陷都集中在"同一 session 两个写者如何裁决"，而那不是第一阶段要解决的问题。
逐条处置与核准状态见 [§11](#11-审查处置记录)。**核准状态只在三处写，各自只写一遍**：
最新是 **§11.9（r10–r12 增量确认，三轮均 ACCEPT 0/0/0）**，上一轮是 **§11.7.1（r9 的 ACCEPT 与两处 NIT）**，
再往前是 **§11.8（截至 r8 的历史核准状态）**；§11.1–§11.7 是各轮的改动记录，只说明我改了什么，
**不是核准出处**。**交付判定以 §11.9 所述增量确认链的最后一次为准**（r10–r12 是同一文档的历史增量，不是交付版本；该次确认的对象摘要与结论记录在对应审查报告与归档 `INDEX.md`，本文不内嵌当前版本摘要，理由见 §11.9）。

---

## 1. 状态头

### 1.1 与 issue #34 的对应关系

| 项 | 内容 |
| --- | --- |
| issue | `runrunliuliu/swarm-orca#34` — **title**：`design: agent session 先按「本地写 + 异步归档到共享存储」（B）落地` |
| 本文的角色 | 把 issue 的「B 的形态」从方向落成**可照着实现的契约**，并回答 6 项"仍待拍板" |
| 6 项待拍板 | §7（存储基质/cwd 重写、ACL 与加密分层、保留期与删除跟随、schema 与 collector 形态、resume 与降级、是否只归档已结束会话） |
| 验收（B） | §8 把 issue 的 6 条验收 + 4 条负例映射成可判定检查，并标明**可离线 / 需双机** |
| 第一阶段范围 | §2.2（触发点、数据、写入、失败、读取、删除、迁移七行，逐行对应 issue 的范围表） |
| 明确不做 | §2.3 与 §6.9（provider 目录直接放 NAS、SQLite 放 NFS、每台 Orca 起共享服务、自动迁移历史 session） |

issue 的 B 形态图（本地写 → orcad 后台 collector → 共享 `blobs/` + `manifests/` → Orca tab/CLI 读回）
在本设计中保留不变；本文把每一段箭头换成有状态、可判定、可负例化的契约。

### 1.2 一句话结论

> **共享侧只放不可变 blob 和不可变世代的 JSON manifest；世代用 successor/predecessor 串成一条链，
> 链上同一代只允许一个文件，出现分叉就 fail closed；第一阶段不启用跨主机接管；
> 读不到就报 `unavailable`，绝不报成"空"。**

这五句话决定了后面 90% 的设计，其余都是它的展开。

### 1.3 本文的八条硬约束（可写成断言）

1. **manifest 不写共享侧绝对路径。** 因此 issue 第 1 项后半问"挂载点变化时 `cwd` 如何重写"不是被推迟，
   是被**取消**：没有可重写的字段（§4.3、§7.1）。
2. **manifest 世代不可变，链由 `predecessor` 显式串起，head 只认"唯一 tip"。**
   出现两条 tip（同一前驱被两个世代声明），或前驱指针解析不了，一律 `chain-fork` / `chain-broken` **fail closed**，
   绝不静默挑一个（§4.1、§5.4）。
3. **第一阶段在纯 POSIX 共享存储上不启用跨主机接管（no takeover）。**
   租约过期只产生"停滞"信号，不授权他人接管；任何时刻同一 session 只有一个写者。
   跨 fence 的线性化提交能力**本设计不声称、不实现**（§1.5、§5.5）。
4. **blob 与 manifest 同域放置。** 一个授权域（一个 issue/PR）一个子树，`sha256` 只在域内去重；
   跨域引用被拒绝（§4.1、§7.2）。
5. **一个词表，不许造同义词。** 读不到的原因必须落进 §6.3 的 **17 个读侧码**，不许落进空数组、`0`、`null` 正文。
6. **四种空态分开**：本机无记录 / 归档未完成 / 有归档但此刻不可达 / 跨主机无法判定（§6.5）。
   合并任意两个，就是把"失去联系"说成"不存在"。
7. **字节在变成不可取得之前必须已被保护。** 保护引用在**首次产生可归档字节时**就建立，
   不等到归档意图（§5.9）。
8. **采集期不做脱敏。** 采集期改字节就是改 sha256，"host B 读回 sha256 与本地一致"这条验收立即不成立（§7.2）。

### 1.4 本文所定义的每一项能力的实现状态

| 能力 | 状态 | 依据 |
| --- | --- | --- |
| orcad 内嵌 collector（采集/计算 sha256/入队/上传） | **未实现** | 仓库中无此模块；orcad 现有唯一自启定时任务是 incidents 证据归档 drain（`orca/src/main/orcad/orcad-entry.ts:365-371`） |
| 本地待上传队列（持久化、退避、确认） | **未实现** | 无对应文件；形状参照 `orca/src/main/artifacts/artifact-create-intent-store.ts:74-89`、`:221-224`，但那是产物创建意图，不是归档队列 |
| 共享 `blobs/` + `manifests/` 读写、世代链、fork 检测 | **未实现** | 无对应模块；原子发布只作为**形状**复用了 `swarm/coordinator_io.py:264-276` 的本地语义 |
| 跨主机接管（lease takeover） | **未实现，且第一阶段不做** | §5.5；需要存储侧条件写能力，见 §1.5 |
| 单写者判定与"第二台主机被拒绝" | **未实现** | §5.4.2 W-1/W-2、§5.5.1；当前无任何归档代码 |
| 跨主机读回与本地 cache | **未实现** | 无对应模块；状态词表参照 `orca/src/shared/ai-vault-search-contract.ts:83-94`、`:124-129` |
| 跨 host resume（L0–L3） | **未实现** | 本机 resume 命令构造已存在（`orca/src/shared/ai-vault-resume-command.ts:123`），跨 host 无任何先例 |
| 会话打开即建保护引用 | **未实现** | 现有删除路径无任何归档闸门（§3.5） |
| 共享侧删除 / 保留期执行 | **未实现，且本期不做** | issue："共享侧不自动删除；保留期是单独决策" |
| 存储能力探针（`verify-archive-fs`） | **未实现** | §9 S1 的第一个交付物 |
| 验收 A1–C2（§8） | **未执行** | 矩阵全部条目都是"实现后才能跑"，本文只给判据 |

### 1.5 显式不声称（本轮新增，必须与正文一起读）

| 不声称 | 为什么 | 需要什么才能声称 |
| --- | --- | --- |
| **多写者**（同一 session 由两台主机交替追加） | 第一阶段把写者数收窄为 1（§5.4.2 W-1/W-2）：第二台主机只被拒绝，不追加。这不是"暂时没实现"，而是**本设计选定的范围** | 不需要——除非要支持迁移后由新主机续写，那才需要条件写 |
| **跨写者的线性化提交**（"新写者接管后，旧写者的已确认尝试仍然有效"） | 纯文件协议只有"创建不存在的名字"这一个原子原语，写入时刻无法知道"我是不是唯一的后继" | 存储侧条件写：对象存储条件 PUT / `If-None-Match`、DB 行锁、带 version 的 CAS（§5.12） |
| **自动故障接管**（另一台 host 在租约过期后继续归档同一 session） | 时钟不可信；"过期"不是"持有者已死"的正面证据 | 由**持有者所在 host** 出具的死亡/释放证据（§5.12 草案），或上述条件写能力 |
| **claim 提供互斥** | 第一阶段 claim/租约只做去重，最坏结果是重复劳动或一次拒绝服务（§5.4.2 逐条证明） | 可证明无 ABA 的领取/释放协议 + 条件写（§5.12 的 D-1/D-2/D-3） |
| **共享侧作为不可篡改审计存储** | 没有签名链与可信时间戳 | 签名 / 时间戳服务 |
| 任何"已在真机验证"的存储语义（NAS 上的 `link`/`fsync(dir)`/`flock`/`O_EXCL`） | 本轮未实测 | §9 S1 的能力探针结果 |

**这条限制的实际含义**：第一阶段能保证的是"**每 session 一个写者、一条链、已提交的世代不会被别人顶掉**"。
它不保证"多写者接管后不丢已确认尝试"，因为那不靠协议就做不到；所以第一阶段**不允许第二个写者**，
而不是用弱协议假装互斥成立。

---

## 2. 问题与范围

### 2.1 要解决的核心问题

已完成任务的运行轨迹今天只落在**执行主机本地的用户目录**，带来两个不可绕过的后果：

1. **跨主机不可见**：同一个 issue 的轨迹只在那台执行主机上。换 host、paired client、容器重建之后，
   页面无法读回"当时究竟运行了什么"。
2. **删除即丢**：工作区删除后 cwd/branch 一起消失。现有的任务账本只能证明"它跑过"，
   不能读回 transcript（见 §3.4 的 `taskRunHistory` 字段全集）。

B 的取舍是：**provider 继续写本地，归档是异步的历史动作**，因此 NAS 抖动不会卡住 agent，
也不需要任何一方新增长期常驻服务。

### 2.2 第一阶段范围（逐行对应 issue 的范围表）

| 项 | 决定 | 本文落点 |
| --- | --- | --- |
| 触发 | 归档工作区、删除工作区、用户显式"归档历史"；**不做周期性全量同步** | §5.1 |
| 数据 | 原始 transcript、终端 scrollback（可得时）、manifest（身份、issue、时间、token、sha256、resume 信息） | §4.3–§4.9 |
| 写入 | 内容寻址 + 请求级幂等；**先本地入队 → 再 blob → 校验后发布不可变世代**；单写者、不接管 | §5.2–§5.7 |
| 失败 | 本地队列持久化 + 重试；**上传未确认前不删本地，不 GC 对应 scrollback** | §5.6–§5.11 |
| 读取 | 先读本地；本地没有时读共享 manifest + blob；离线/不可达报 `unavailable`，不显示空内容或假 0 | §6 |
| 删除 | 共享侧不自动删除；保留期是单独决策 | §7.3 |
| 迁移 | 只对显式动作生效；不自动搬已有 session、不迁移既有 Run | §9、§10 |

### 2.3 明确不做（第一阶段）

| 不做 | 理由（一句话） |
| --- | --- |
| 把 provider 目录直接 mount 到 NAS | provider CLI 不保证支持重定向；NFS 的追加写、锁、`fsync`、抖动语义与本地盘不同，且会把并发写与隐私问题放大 |
| 把 SQLite（`profile-state`、`session-search`）放到 NFS | 这个索引的正确性建立在单写者 + `st_mtime`/`st_ino` + 精确字节 offset 之上（§3.3） |
| 在每台 Orca 后台起共享服务 | C 若做，服务必须独立于任何一台 Orca 的生命周期；这一期连共享服务都不需要 |
| 自动迁移已有 session；承诺"已删除的老工作树补回 trace" | 迁移是显式动作；历史缺口应被如实显示，而不是被批量补写掩盖 |
| 周期性全量同步 | 触发点只有三个显式动作；周期同步会把"采集"变成"实时写路径的邻居" |
| **跨主机自动接管归档（takeover）** | 纯文件协议无法给出跨写者的线性化提交（§1.5）；用弱协议假装成立会静默丢已确认尝试 |
| **同一 session 由第二台主机追加** | 第一阶段收窄为单写者（§5.4.2 W-1/W-2）：第二台主机只返回 `session-claimed-elsewhere`/`already-archived`，不发布。迁移后由新主机续写属于 §5.12 的后续切片 |
| 远端 attach（写回一个活会话） | 归档会话按定义没有活进程；attach 会悄悄变成 fork/restore，是另一个动词（§6.8） |
| 采集期脱敏 / PII 改写 | 会改 sha256，且脱敏后的字节不再是原文（§7.2） |
| 声称"不可篡改审计存储" | 本设计没有签名链与可信时间戳，不提供该性质 |
| 在共享侧用 `0700/0600` 表达授权 | 那组模式只表达"这一台机器的这一个用户"；跨主机共享必须用**域 + 组 ACL**（§7.2） |

---

## 3. 现状依据

本节只写**读代码能证明的事实**，并给出 `path:line`。凡属推断，都标注"分析"。
约定：引用路径相对仓库根；`<user-data>` 指 Orca 本机数据目录，`<data-root>` 指该 host 的 userData。

### 3.1 provider 原始 transcript

**Orca 不写 provider 的 transcript。** 真正 append 的是各 provider CLI 自己；Orca 侧只有三件事：
按表驱动发现根与扩展名（`orca/src/main/ai-vault/session-scanner-agent-sources.ts:105-118`）、
按 id 或 hook 上报路径解析文件（`orca/src/main/native-chat/session-file-resolver.ts:113-129`）、
以及在用户明确删除时把文件移入回收站（`orca/src/main/ai-vault/session-delete.ts:105-112`）。

| provider | 默认根 / 覆盖方式 | 引用 |
| --- | --- | --- |
| Claude | 默认根 `~/.claude/projects` | `orca/src/main/ai-vault/session-scanner-roots.ts:8` |
| Claude（目录名编码） | 一个非字母数字字符 → 一个 `-`，**不折叠连续**（`/.claude` → `--claude`），并同时给出 NFC 拼写 | `orca/src/main/ai-vault/claude-project-dir-encoding.ts:14-21` |
| Claude（作用域判定） | 必须用 `===` 或 `<prefix>-` 边界，否则 `…/orca` 会认领 `…/orca-secret` | `orca/src/main/ai-vault/claude-project-dir-encoding.ts:23-34` |
| Codex | `~/.codex` → `${CODEX_HOME}/sessions`；读取侧优先 Orca 托管的 runtime home | `orca/src/main/ai-vault/session-scanner-agent-sources.ts:26-29`；`orca/src/main/native-chat/session-file-resolver.ts:44-51` |
| Pi | `PI_CODING_AGENT_DIR` 或 `~/.pi/agent/sessions`；Orca **不覆盖**该变量 | `orca/src/main/ai-vault/session-scanner-agent-sources.ts:44-47`；`orca/src/main/ipc/pty/host-env/assembly.ts:198` |
| Pi（WSL） | `['.pi','agent','sessions']` 拼到各 distro home 下 | `orca/src/main/ai-vault/session-scanner-agent-sources.ts:216-222` |
| OMP / Prime Agent | 显式根 / `OMP_CODING_AGENT_DIR` / profile 目录 / `PI_CONFIG_DIR` | `orca/src/main/ai-vault/omp-session-root.ts:37-60`；`orca/src/main/ai-vault/session-scanner-agent-sources.ts:225-238` |

一个必须知道的区别：结构化 transcript 解析只支持 `claude | codex | grok | omp`，**不含 `pi`**
（`orca/src/shared/native-chat-agent-support.ts:3`）；而扫描表里 `pi` 与 `omp` 是两条独立条目。
collector 若按 provider 分派，判据必须取自扫描表，不能取自 native-chat 的支持列表。

**"append-only"在本仓库是一个被防御性验证的假设，不是 Orca 制造的保证。** 可引用的读侧契约：

- Pi transcript 是 append-only JSONL，根记录带 `id`/`cwd`/`version`，逐条 `id`/`parentId` 链；
  每一行必须以 `\n` 结尾，否则判 `pi_session_partial_append`；读完后再 `seek(0)` 重读并比对摘要，
  中途变化判 `pi_session_changed_during_read`（`swarm/pi_transcript.py:44-57` 是读取循环，
  `:58-60` 才是二次摘要与判定）——**两处引用要分开看，不能把二次摘要归到读取循环上**。
- 读取返回的前缀身份是**成对的** `{"bytes", "sha256"}`（`swarm/pi_transcript.py:79`）——不是单个摘要。
- 有限前缀读取有现成工具：`prefix_digest` 按 1 MiB 分块、内存与文件大小无关
  （`swarm/log_io.py:24-36`）。
- Codex 侧的续读状态显式记录"不能拿文件 size 当已解析位置"（`orca/src/main/codex-usage/types.ts:17-32`）。

**分析**：因此任何 collector 都不得"按 size 增量续读"。第一期按 §5.11 的"只归档已结束会话"回避这个问题；
若将来做增量，必须复制上面这套三件套（offset 落换行边界、前缀摘要、文件身份），否则 provider 的
fork/resume/rollout 重建会让它静默读错内容。

### 3.2 终端 scrollback / 历史：同一个根下两种不同的东西

issue 背景表写"按 worktree 哈希分目录"，这**只对 shell history 成立**。PTY scrollback/checkpoint
是按 **session id**（百分号编码）分目录的，两者共用一个根。这是读代码最容易踩的坑，先修正：

| 对象 | 目录名 | 引用 |
| --- | --- | --- |
| 共用根 | `<user-data>/terminal-history`（WSL 另根 `<user-data>/terminal-history-wsl/<distro>`） | `orca/src/main/terminal-history-paths.ts:12-14` |
| shell history | `<root>/<hashWorktreeId(worktreeId)>`，哈希 = sha256 前 16 hex | `orca/src/main/terminal-history-id.ts:3-5`；`orca/src/main/terminal-history.ts:70-80` |
| PTY scrollback / checkpoint | `<root>/<encodeURIComponent(sessionId)>`（session id 含 `:` `/`，必须编码） | `orca/src/main/daemon/history-paths.ts:1-7`；`:6` 就是编码本身 |
| session id 形状 | `${worktreeId}@@<8 位 uuid>` | `orca/src/main/daemon/pty-session-id.ts:21-26` |
| 待删墓碑 | `<root>/.pending-delete` | `orca/src/main/terminal-history-paths.ts:8` |

一个 daemon session 树固定四个文件名 `checkpoint.json` / `output.log` / `meta.json` / `scrollback.bin`
（legacy）：`orca/src/main/daemon/terminal-history-session-files.ts:6-11`。写入时机：PTY 输出追加
`output.log`（`orca/src/main/daemon/daemon-pty-checkpoint-persistence.ts:69-72`）、dirty 且 ≥5s 整屏快照进
`checkpoint.json`、`output.log` 将超 5 MiB 强制一次 checkpoint。`meta.json` 只有
`cwd/cols/rows/startedAt/endedAt/exitCode`（`orca/src/main/daemon/terminal-history-metadata.ts:8-15`）。
正常关闭会话时 `closeSession` 回填 `endedAt`/`exitCode`（`orca/src/main/daemon/history-manager.ts:257-272`）。

**两种同名 `meta.json`、不同 schema**：shell history 的 meta 是
`worktreeId/createdAt/fishSession/fishHistoryDir`（`orca/src/main/terminal-history.ts:120-127`）。
这就是 §3.5 里 GC 行为差异的根因，collector 不能只按文件名取字段。

权限：本地目录 `0700`、文件 `0600`，理由写在 `orca/src/main/daemon/daemon-private-file-modes.ts:1-4`
（`checkpoint.json` 含快照与 scrollback、daemon 还存 auth token，不得落在进程 umask 下）。
**这组模式是本机单用户先例，不能直接搬到共享侧**（见 §7.2）。

### 3.3 session-search 索引（本机 SQLite）

- 位置 `<data-root>/ai-vault/session-search.sqlite`，与 scanner 的 parse cache 同目录；
  注释明确 **"One file per host, never shared"**——第二个写者写同一文件就是重建竞争
  （`orca/src/main/ai-vault-search/session-search-database-path.ts:5-12`）。
- schema 是「cache 而非源」：`files` 表带 `dev`/`ino`/`byte_offset`/`mtime_ms`/`state`/`fail_count`
  （`orca/src/main/ai-vault-search/session-search-schema.ts:54-79`）；版本不符就打不开就丢库重建。
- 内容是 transcript 原文、**不做脱敏**，注释说明理由是 transcript 本身已在用户 home 下明文
  （`orca/src/main/ai-vault-search/session-search-schema.ts:8-11`）。
- 清空 = 关连接 → 删库（含 `-wal`/`-shm`/`-journal`）→ 若仍启用则重建
  （`orca/src/main/ai-vault-search/session-search-instance.ts:74-76`）。
- 保留期只有一个 `historyDays` 可空设置（`orca/src/main/ai-vault-search/session-search-retention-policy.ts:6-12`）。

**为什么它不能放共享存储（分析）**：单写者约束、对 `st_mtime`/`st_ino` 的依赖、以及网络挂载上
`stat`/`open` 不可中断，三条同时成立。这三条是本文把它排除在 `<archive-root>` 之外的依据；
仓库里没有一句"不支持 NFS"的明文策略，所以这是设计判断，不是代码声明。

### 3.4 usage 缓存与 task/worktree 身份映射

| 数据 | 位置 | 生命周期要点 | 引用 |
| --- | --- | --- | --- | --- | --- | --- |
| Claude usage | `<user-data>/orca-claude-usage.json` | 由渲染进程经 IPC 触发刷新；5 分钟内且 fingerprint 未变则复用快照 | `orca/src/main/claude-usage/store.ts:63-67` |
| Codex usage | `<user-data>/orca-codex-usage.json` | 同构，另有 `parsedBytes`/`boundaryDigest` 续读状态 | `orca/src/main/codex-usage/store.ts:70-72` |
| 归因键 | **cwd**，不是 branch；命中 worktree 则 `worktree:<id>`，否则 `cwd:<normalized>` | branch 只被记录、不参与归属 | `orca/src/main/claude-usage/worktree-attribution.ts:27-77` |
| task 映射 | `profile-state` 的顶层 JSON domain `taskRunHistory` | 字段全集（`repoId/itemType/number/worktreeId/path/branch?/state/firstSeenAt/updatedAt/*At`）从 `:24-40` 开始 | `orca/src/shared/task-run-history.ts:24-40` |
| 映射写入 | `recordTaskRunLinks` 唯一入口；删除只改 `state='deleted'`、不删行 | 只裁剪 `deleted` 行（上限 1500）；活跃行不被裁剪 | `orca/src/main/persistence/loading-store/task-run-history-persistence.ts:24-67`；`orca/src/shared/task-run-history.ts:60-65` |
| 持久化 | `scheduleSave(scheduling, ['taskRunHistory'])` | 只写这一条 domain | `orca/src/main/persistence/loading-store/task-run-history-persistence.ts:92-99` |

`taskRunHistory` 的设计意图写得很直白：只记录"删掉 worktree 就会一起消失的那点东西"，
且明确**不存运行时状态或用户意图**（`orca/src/shared/task-run-history.ts:3-19`）。
它的 `path` 在 worktree 被删除后仍能解析成一个曾经的路径（`orca/src/shared/task-run-history.ts:80-82`）——
这正是"工作区删了还能按 worktree 找回轨迹"所依赖的性质，也是本设计**只借用它的 `worktreeId`、不给它加字段**的原因。

### 3.5 删除 / 归档工作区的 GC 路径

| 对象 | 触发 | 函数 | 可恢复 |
| --- | --- | --- | --- |
| shell history（`<root>/<worktreeHash>/`） | worktree 删除 | `deleteWorktreeHistoryDir(worktreeId)`：`orca/src/main/terminal-history-deletion.ts:317-340` | 否（`rm`） |
| 同上，孤儿目录 | 启动后约 10s 一次 GC | `runHistoryGc` → `gcScanEntry`：`orca/src/main/terminal-history-gc.ts:57-95` | 否 |
| PTY scrollback/checkpoint | 显式关闭会话 / worktree 拆除 | `HistoryManager.removeSession`：`orca/src/main/daemon/history-manager.ts:274-283` → `removeTerminalHistorySessionTrees`：`orca/src/main/daemon/terminal-history-session-tombstone.ts:90-101` | 否 |
| renderer 侧 scrollback 快照 | 会话引用差集变化（**不等归档**） | `deleteRemovedTerminalScrollbackSnapshots`：`orca/src/main/persistence/loading-store/terminal-session-cleanup.ts:27-38`，`:35-38` 就是"ref 消失即删" | 否 |
| provider transcript | 仅用户在 AI Vault 里显式删除 | `shell.trashItem`：`orca/src/main/ai-vault/session-delete.ts:105-112` | **是（OS 回收站）** |

五个事实决定了 §5.9 的"保护引用"与 §5.10 的"不 GC 判据"：

1. **删 worktree 不会顺带删除该 worktree 下所有会话的 scrollback**：`deleteWorktreeHistoryDir` 删的是
   `<root>/<hashWorktreeId>`（`orca/src/main/terminal-history-deletion.ts:318-321`），而 scrollback 目录名是
   `encodeURIComponent("<worktreeId>@@xxxxxxxx")`。两者名字不同。
2. **GC 不碰 scrollback 目录**：`gcScanEntry` 只读 `meta.json` 的 `worktreeId`，没有就 `return`
   （`orca/src/main/terminal-history-gc.ts:71-81`），而 scrollback 的 meta 没有该字段（§3.2）。
3. **GC 在活跃集合为空时拒绝执行**（`orca/src/main/terminal-history-gc.ts:159-162`）："空集合看起来与
   '用户真的没有 worktree' 无法区分，所以拒绝不花钱"。
4. **删除是墓碑优先**：先 `renameSync(dir, tombstone)` 进 `.pending-delete`
   （`orca/src/main/terminal-history-deletion.ts:137`、`:158`），下一轮先清墓碑再扫活跃集合；
   5 分钟内新建的目录跳过（TOCTOU，`orca/src/main/terminal-history-gc.ts:24`、`:83-89`）。
5. **renderer 快照的删除与归档完全无关**：它在每次 workspace session 状态发布时按 ref 差集删除
   （`orca/src/main/persistence/loading-store/terminal-session-cleanup.ts:35-38`，调用点
   `orca/src/main/persistence/loading-store/workspace-session-snapshot-publication.ts:104`）。
   这条路径比 worktree 删除更早、更频繁，是 §5.9 "保护引用必须在会话打开时就建立"的直接原因。

worktree 破坏性拆除只调 `deleteWorktreeHistoryDir(worktreeId)`
（`orca/src/main/ipc/worktrees/removal/worktree-removal-ownership.ts:96`），**不删 provider transcript**：
那条路径里没有 AI Vault delete 调用。因此"删除工作区后 trace 还在共享存储"这件事，
必须由本设计新增的归档动作提供，不能指望现有删除路径留下任何东西。

---

## 4. 数据模型

本节是 §5/§6 的共同基础。四个对象的定位先说清：

- **`blobs/<sha256>` 是不可变字节**，内容寻址，**只在授权域内**去重，永不覆盖。
- **`manifests/<sessionKeyDigest>/g<NNNNNN>.json` 是不可变世代**，一个 session 一份**目录**、
  多次归档写多个世代文件；它们用 `predecessor` 串成一条链，**head 只认唯一 tip**（§5.4）。
- **`fences/` 与 `leases/` 是协调物**，不是档案；读侧不把它们当内容。
- **分叉证据只落本机**（`<local-state>/archive-fork-evidence/`），共享侧不写；理由见 §5.6.4。

### 4.1 共享存储布局

```text
<archive-root>/
├── <repoId>/<itemType>/<number>/                     # 授权域：一个 issue / 一个 PR 一个域
│   ├── blobs/<sha256[0:2]>/<sha256>                  # 不可变；本域内内容寻址去重
│   ├── manifests/<sessionKeyDigest>/
│   │   ├── g<000001>.json                            # 不可变世代（link/O_EXCL 发布，永不 replace）
│   │   └── g<000002>.json
│   ├── aliases/<sessionKeyDigest>.json               # 跨 issue 关联（只读指向 home 域）
│   ├── fences/<sessionKeyDigest>/
│   │   ├── <000001>                                  # 空文件：该 fence 曾被领取
│   │   └── <000001>.released                         # 空文件：**持有者所在 host** 出具的释放证据
│   ├── leases/<sessionKeyDigest>.lease               # 租约（含 holder 与 fence）
└── _unlinked/                                        # 无 issue 绑定的会话：**独立授权域**（见 §7.2）
    └── （同上七个子目录）
```

| 项 | 决定 | 理由 |
| --- | --- | --- |
| 授权域 = 路径前三段 | `<repoId>/<itemType>/<number>`，或 `_unlinked` | 授权粒度必须与**目录边界**一致，否则 ACL 无处落地（B2） |
| `blobs` 文件名 | 完整小写 hex `sha256`，64 字符，无后缀 | 摘要自证；同名不同字节即事故 |
| `blobs` 分片 | 域内一级 `<sha256[0:2]>`，共 256 个分片目录 | 单域 blob 量级远小于全局；一级足够，且避免制造数万近空目录 |
| blob 去重范围 | **仅域内** | 跨域复用会把一个域的字节暴露给另一个域的读者。存储放大是**明示代价**，换取授权边界 |
| `manifests` 目录 | 每 session 一个目录，内含不可变世代文件 | 世代文件保留 ⇒ 前驱摘要可复算；不可变 ⇒ 任何写者都无法覆盖既有世代 |
| 世代文件名 | `g<NNNNNN>.json`（只含世代号；**fence 不进文件名**） | **一个世代恰好一个名字**，两个写者算同一代数就会撞名；这是第一阶段"不丢已提交 attempt"的结构基础（§5.4.2） |
| `fences` | 一个空文件 = 一个曾被领取的 fence；`<n>.released` = 持有者出具的释放证据 | 领取是一次 O_EXCL；释放是**持有者所在 host 的显式动作**，不是超时推断 |
| 临时名 | `.<目标名>.<pid>.<随机>`，与目标同目录 | 同目录才可能原子 `link`；模式由本契约冻结（§5.4） |
| 共享侧权限 | 域目录 `2770`（setgid，继承组）+ 文件 `0640` | 跨主机共享必须是"域 + 组"，`0700/0600` 只表达单机单用户（§3.2、§7.2） |
| 本地侧权限 | `<local-state>`/`<local-cache>` 保持 `0700`、`0600` | 本机私有，沿用 `orca/src/main/daemon/daemon-private-file-modes.ts:1-4` 的取向 |

**`<number>`、`<repoId>` 必须做白名单校验**（`^[A-Za-z0-9_-]{1,64}$`）：它们是仅有的进入路径段的
用户输入，`../` 或绝对路径会让 manifest 落到 `blobs/` 里。

**清单里没有"共享侧相对路径"字段。** 读侧用 `blob_path(domain, sha256)` 推导位置；
推导规则是纯函数，因此分片策略演进只需改一次代码并加一条旧布局回退（域内扁平 `blobs/<sha256>`），
**不需要迁移任何历史数据**。这是 §4 的第一条取舍。

**为什么第一阶段把 fence 从文件名里拿掉**（这条与本轮 B1 直接相关，务必读清）：

- `generation` 是**链上的位置**：全局单调。它同时是**唯一名字**——一个世代恰好一个文件名。
- `fence` 退化为**属性**：只写进 manifest 的 `producer.holderId`/`fence` 与 `predecessor.fence`，
  用来回答"这一代是哪次领取写的"，**不参与命名、不参与裁决**。
- 上一版把 fence 塞进文件名，理由是"让两个写者留下两个可检测的文件而不是互相覆盖"。
  这个理由本身没错，但它有代价：**同一代有了两个可用名字，两个写者就真的可以各写一份**。
  一旦发生，读侧只能看见两条 tip，整个 session 从可读变成 `chain-fork`——attempt 没丢，但会话读不出来了。
- 拿掉之后，**同一代只有一个名字**，于是"两个写者算同一代"必然撞名（`EEXIST`），
  而不是各自成功。这才让"最坏结果是重复上传或一次拒绝服务、不会丢已提交 attempt"（§5.4.2）
  成为**结构事实**而不是愿望。
- 分叉因此只剩一个人为来源。但要说清**当前会发生什么**：若有人为复制/篡改，它会**先被候选错误门
  或 d1 判 `chain-broken`**（前驱 generation 不连续、或指向不存在的文件），而不是走到 d2。
  **`d2`（`chain-fork`）只作为后续多写者切片与排障的保留诊断码，本期不可达**（推导见 §5.4.4）。

**为什么不像日期分片**（`YYYY/MM/DD/`，仓库里有先例：`orca/src/main/ai-vault/session-scanner-muse-paths.ts:5-6`）：
那服务的是"按时间浏览"。本设计的验收查询是"按 issue/worktree 读回"，按域分段才是那个查询的形状。

### 4.2 blob 引用契约

| 字段 | 类型 | 必填 | 含义 | 默认 |
| --- | --- | --- | --- | --- |
| `kind` | `transcript \| scrollback` | 必填 | 该 blob 是什么 | 无 |
| `origin` | `provider_dir \| daemon_checkpoint \| renderer_snapshot` | 必填 | 字节从哪一类来源取得（§5.8） | 无 |
| `sha256` | `^[a-f0-9]{64}$` | 必填 | 内容摘要；同时是文件名与分片来源 | 无 |
| `bytes` | int **≥ 0** | 必填 | 字节数，**必须等于 `lstat` 得到的实际长度** | 无 |
| `truncated` | bool | 必填 | 是否只采了前缀（进行中的文件） | `false` |
| `prefixBytes` | int \| null | 条件 | `truncated=true` 时的截取位置 | `null` |
| `localPath` | 绝对路径 \| null | 选填 | 采集时本机源路径，**仅作诊断** | `null` |

**`bytes` 允许 0。** 空文件是合法内容，空字节串的 sha256 由实现直接计算（不写成常量），
`bytes: 0` 表示"归档了一份确实为空的字节串"，`blob-missing` 表示"内容不在"。两者不可互换（§6.6 C1）。

`bytes` 不是冗余：它是"半截上传"的唯一廉价判据。只存摘要时，被截断的 blob 要读完才发现；
存了 `bytes`，一次 `lstat` 就能判 `blob-truncated`。**成对出现**的手法在本仓库有先例：
`swarm/pi_transcript.py:79` 与 `swarm/swarm_ledger/trae_jsonl.py:20-23` 都是 `{bytes, sha256}` 强绑定。

`origin` 不是分类癖好：`daemon_checkpoint` 与 `renderer_snapshot` 的删除路径完全不同
（§3.5 事实 4 与事实 5），保护引用必须能区分它们。

`localPath` 允许存在但**不得参与任何跨主机判定**：它是某台机器的路径，不是数据。
**它不作为引用**：`sources[]` 的引用语义只由本域内 `sha256` 承担，所以"引用是否合法"是纯结构判定
（R9），与 blob 是否存在无关（是否存在是读时观察，见 §6.3 / §4.10 R9）。

### 4.3 manifest 顶层字段表

类型记法为 JSON 类型。**`null` 是显式值，与"字段缺失"不等价**（§4.10 R5）。

| 字段 | 类型 | 必填 | 含义 | 默认 |
| --- | --- | --- | --- | --- |
| `schemaVersion` | int | 必填 | 文档版本；本期冻结为 `1` | 无 |
| `kind` | 常量 `"agent_session_archive"` | 必填 | 与版本双重校验 | 无 |
| `archivalGroup` | `{repoId, itemType:'issue'\|'pr', number}` \| null | 必填 | 归档域；非 `null` 时必须与所在目录三段一致；`null` ⇔ 位于 `_unlinked/` | 无 |
| `sessionKey` | object | 必填 | 身份元组，见 §4.4 | 无 |
| `sessionKeyDigest` | `^[a-f0-9]{64}$` | 必填 | `sha256(canonicalBytes(sessionKey))`，必须等于目录名 | 无 |
| `sessionIdKind` | `uuid \| opaque` | 必填 | `sessionId` 的校验强度；**属性，不参与哈希** | `opaque` |
| `fence` | int ≥ 1 | 必填 | 本世代的 writes 者身份（租约的 fence） | 无 |
| `generation` | int ≥ 1 | 必填 | **链上位置**：全局单调、跨 fence 连续 | 无 |
| `predecessor` | `{fence, generation, manifestSha256}` \| null | 必填 | 上一世代的三元组；`generation==1` 时必须为 `null`，否则必须非 `null` | 无 |
| `createdAt` | ISO8601（显式时区） | 必填 | 本 session 首次归档时间 | 无 |
| `updatedAt` | ISO8601 | 必填 | 本世代写入时间；`>= createdAt` | 无 |
| `completeness` | `partial \| complete` | 必填 | 数据完整性轴，**只由 sources/gaps 决定**（§4.9） | `"partial"` |
| `lifecycle` | `open \| sealed` | 必填 | 生命周期轴，**只由结束证据决定**（§4.9） | `"open"` |
| `attempts` | array\<object\> | 必填，长度 ≥ 1 | 每次归档一行；**只追加**（§4.11） | 无 |
| `gaps` | array\<object\> | 必填，可为空 | 已知缺失事实，见 §4.8 | `[]` |
| `tokens` | object \| null | 必填 | token 计数，见 §4.6；`null` = 未知，**不是 0** | `null` |
| `resume` | object \| null | 必填 | resume 所需信息，见 §4.7；`null` = 不支持或未知 | `null` |
| `producer` | object | 必填 | `{tool, version, hostId, holderId}`：这一世代是谁写的 | 无 |
| `redaction` | object \| null | 选填 | `{applied: bool, method: string}`；`null` = 未做任何脱敏 | `null` |

四处相对上一版的关键改动（都来自本轮审查）：

- **`previousGeneration` + `previousManifestSha256` 合并为 `predecessor` 三元组。**
  上一版把这些信息拆在两个字段里，读者要自己拼；而且没规定"新 fence 的 g1 该指谁"——因为上一版让
  `generation` 在每个 fence 内从 1 重来，于是"首次出现"和"接管后首代"都要么空前驱、要么指旧 head，
  两条规则互相矛盾。**现在 `generation` 全局单调、跨 fence 连续，这个矛盾不存在**：
  `generation == 1` 的历史上只有一个文件（session 的创世世代），其 `predecessor` 为 `null`（§4.10 R8）。
- **删除自哈希字段。** 上一版有 `manifestSha256`，但一个文件无法包含自己的摘要。
  本代的摘要由读者对文件字节计算，记在**本地提交收据**里；链只靠 `predecessor.manifestSha256`
  指向**上一代不可变文件**（永远可复算）。
- **`state` 拆成两轴，且各自只有一个输入**（§4.9）。
- **去掉"fence 大者胜"的语义，并把 fence 移出文件名**：fence 不再参与命名、也不参与 head 裁决，
  只作为 `producer`/`predecessor` 里的归因属性（§4.1、§5.4.2）。

`producer.hostId` 与 `attempts[].host.hostId` 不冗余：前者回答"谁写了这一代"，后者回答"会话跑在哪台机器"。

### 4.4 `sessionKey`：身份元组（**只有两项**）与 canonical 字节规范

| 字段 | 类型 | 必填 | 含义 | 为什么在这个位置 |
| --- | --- | --- | --- | --- |
| `provider` | `^[a-z0-9-]{1,32}$` | 必填 | `pi`/`trae`/`claude`/`codex`/… | provider 决定 `sessionId` 命名空间、resume 语法、token 契约 |
| `sessionId` | string，长度 1..1024 | 必填 | provider 原生 session/thread 标识 | 唯一真正需要跨主机对齐的标识 |

**canonical 字节规范（冻结，不可协商）：**

```text
canonicalBytes(v) = UTF-8 编码的 JSON 文本，满足：
  · 对象键按 Unicode 码位升序排列
  · 分隔符只有 "," 与 ":"（无空格）
  · 不含 NaN / Infinity（出现即拒绝）
  · 不写结尾换行
sessionKeyDigest = sha256hex(canonicalBytes(sessionKey))     # 小写 hex，64 字符
```

这条规范不是我发明的，仓库里已是同一实现：`swarm/coordinator_io.py:28-30` 的 `canonical()` 用
`sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False`，`digest()` 在 `:33-34`。
实现必须**直接复用**这两个函数，不要各自重写——两个实现只要有 1 字节差异，
跨主机算出的 `sessionKeyDigest` 就不同，session 会变成两份。

**`sessionIdKind` 不在 `sessionKey` 里**：它是顶层属性，**校验强度是采集事实，不是身份的一部分**。
身份只有 `(provider, sessionId)` 两项。

`sessionId` 长度上限取 1024，与仓库既有 `text_id` 一致（`swarm/swarm_ledger/ledger.py:40-41`）。
**不要用一条全局正则校验 `sessionId`**：Pi 是 UUID（`swarm/pi_transcript.py:31-34` 用
`UUID_PATTERN.fullmatch`），Trae 是 thread id（不是 UUID）。校验强度由 provider 适配器按
`sessionIdKind` 承担，而不是在 manifest 校验器里一刀切。

### 4.5 `attempts[]` 元素

| 字段 | 类型 | 必填 | 含义 | 默认 |
| --- | --- | --- | --- | --- |
| `attempt` | int ≥ 1 | 必填 | 尝试序号；**在持有租约、读完 tip 之后分配**，连续递增 | 无 |
| `requestId` | hex64 | 必填 | 本次归档请求的稳定标识，见 §5.7；**同一写者的幂等依据** | 无 |
| `submittedSeq` | int ≥ 1 | 必填 | 该 session 在本机的请求提交序号，用于队列串行化 | 无 |
| `sourceHostId` | string | 必填 | **产出这份字节的 host**；与 `host.hostId` 相同时仍显式写出 | 无 |
| `archivedAt` | ISO8601 | 必填 | 本次采集时间 | 无 |
| `host` | `{kind, hostId}` | 必填 | 执行主机；`kind` 例如 `local`/`ssh`/`container` | 无 |
| `agent` | string | 必填 | `coordinator`/`worker`/`operator`（本仓库的角色词表） | 无 |
| `model` / `effort` | string \| null | 必填 | 生效模型 / 生效 effort；`null` = 未知 | `null` |
| `repoId` / `worktreeId` | string \| null | 必填 | 仓库与**原生 worktree 标识**（不是路径） | `null` |
| `issueRef` | `{repoId,itemType,number}` \| null | 必填 | 采集时该会话观察到的 issue/PR 绑定 | `null` |
| `cwd` | 绝对路径 \| null | 必填 | 采集时刻的 cwd **原值**，只记录不重写 | `null` |
| `startedAt` / `endedAt` | ISO8601 \| null | 必填 | 会话起止；`lifecycle="sealed"` 时最新 attempt 的 `endedAt` 不得为 `null` | `null` |
| `endEvidence` | `{kind, observable, observedAt}` \| null | 必填 | 判定"已结束"的正面证据，见 §5.11 | `null` |
| `lineage` | `primary \| fork` | 必填 | 本次采集与既有世代的关系，见 §4.13 | `primary` |
| `terminalHandle` | string \| null | 选填 | 本机终端句柄；**只在 `host` 相同的机器上有意义** | `null` |
| `sources` | array\<object\> | 必填，长度 ≥ 1 | 本次尝试的 blob 引用，见 §4.2 | 无 |
| `sealed` | bool | 必填 | 该 attempt 是否终局 | `false` |
| `sealedAt` | ISO8601 \| null | 必填 | 终局时间；`sealed=false` 时为 `null` | `null` |

`sourceHostId` 是本轮 M5 引入、r6/r7 重新定性的字段：同一份字节**可能由两台 host 各自采集**
（例如同一 session 在迁移前被 A 采过一次、迁移后 B 又采了一次）。但**第一阶段不会因此产生两行 attempt**：
非 owner 在 §5.6.3 的 `R5`/`OW` 处被拒（§5.4.2 W-2），只返回 `already-archived` 或
`session-claimed-elsewhere`。它的真正作用在 §5.7 的 `requestId` 定义里——**区分"同一写者的重试"
与"另一个写者的重复采集"**，前者幂等、后者被拒。

`worktreeId` 存原生标识而不存目录名：目录名是派生量（`orca/src/main/terminal-history-id.ts:3-5`
把 worktreeId 哈希成 16 hex）。把派生量写进档案，等于把派生逻辑的每一次改动都变成一次档案解释问题。

`attempts[].issueRef` 与顶层 `archivalGroup` 允许不同（例如事后归入任务）。**差异必须写进 `gaps[]`**，
不允许静默。

### 4.6 `tokens` 对象

| 字段 | 类型 | 必填 | 含义 |
| --- | --- | --- | --- |
| `inputTokens` / `outputTokens` | int ≥ 0 \| null | 必填 | `null` = 未知 |
| `cacheReadTokens` / `cacheWriteTokens` | int ≥ 0 \| null | 必填 | `null` = 未知 |
| `reasoningTokens` | int ≥ 0 \| null | 必填 | `null` = 未知 |
| `totalTokens` | int ≥ 0 \| null | 必填 | **派生量**：`input+output`，任一端为 `null` 则必须为 `null` |
| `complete` | bool | 必填 | 计数是否覆盖全会话 |
| `source` | string | 条件必填 | 任一计数非 `null` 时必填，说明计数来源 |
| `contract` | string \| null | 选填 | 生产方契约标识；同一 `source` 不同 `contract` 不可直接相加 |

这些不是本文发明的规则，仓库里已经写成代码：

- `swarm/swarm_ledger/ledger.py:50-66` 的 `token_counts()`：允许 `None`、拒负数、校验
  `cache_read+cache_write <= input`、`reasoning <= output`，并把 `total_tokens` 强制为 `input+output`
  （任一为 `None` 则 `None`）——**`total_tokens` 从不独立采集**。
- `swarm/swarm_ledger/raw_usage.py:42-48` 的 `totals()`：任一分量未知时整体返回 `None`，
  同时另给 `known_counts` 部分和。这就是"unknown 永不记成 0"的可实施形式。

**`tokens: null` 与 `tokens: {inputTokens: 0, …}` 是两种完全不同的事实。** 读侧必须分别显示
`unknown` 与 `0`；这也是 §6.6 C3 的来源。

### 4.7 `resume` 对象

| 字段 | 类型 | 必填 | 含义 | 为什么需要 |
| --- | --- | --- | --- | --- |
| `supported` | bool | 必填 | provider 是否支持从该 session 恢复 | 有的 runtime 明确不支持（见下） |
| `provider` | string | `supported=true` 时必填 | 必须等于 `sessionKey.provider` | 防串用别的 provider 的参数 |
| `sessionId` | string | `supported=true` 时必填 | 必须等于 `sessionKey.sessionId` | 同上 |
| `cwdAtCapture` | 绝对路径 \| null | `supported=true` 时必填 | 恢复时应当进入的目录 | provider 按 cwd 定位会话（§6.8） |
| `providerVersion` | string \| null | 必填 | 采集时 provider 版本；`null` = 未知 | 版本不同则 resume 语义可能变 |
| `resumeArgs` | array\<string\> \| null | 选填 | 恢复参数模板；`null` = 不知道参数 | 让恢复方不必各自猜 |
| `requiresLocalBlob` | bool | 必填 | 跨主机恢复前是否必须先把 blob 拉回本地 | issue 第 5 项的落点 |

必须能表达"不支持"：`swarm/coordinator_launch.py:101-102` 要求 Pi Coordinator 用全新 bootstrap 目录
（no Run resume），`swarm/coordinator_driver.py:101` 有 `strict_shell_resume_unsupported`。
只有一个 `resumePath` 字符串的方案无法表达这个状态，只能编一个假值。

`resumeArgs` 允许 `null` 而不是 `[]`：空数组是"有参数且为空"，`null` 是"不知道"。与 §4.6 的 `0` vs `null` 同源。

### 4.8 `gaps[]` 元素：稳定 ID + 解决事件

| 字段 | 类型 | 必填 | 含义 |
| --- | --- | --- | --- |
| `gapId` | hex64 | 必填 | `sha256hex(canonicalBytes({code, detectedIn: generation, attempt}))`；同一事实跨世代不变 |
| `code` | 短码 | 必填 | 例如 `scrollback_unavailable`、`scrollback_evicted_before_archive`、`transcript_partial_append`、`provider_dir_unreadable`、`issue_ref_mismatch`、`lineage_divergence`、`blob_expired` |
| `severity` | `info \| warning \| blocking` | 必填 | `blocking` 会把 `completeness` 压到 `partial`（§4.9） |
| `detectedAt` | ISO8601 | 必填 | 检测时间 |
| `detail` | string | 选填 | 一行说明；**不得含文件内容、凭据** |
| `resolvedAt` | ISO8601 \| null | 必填 | 该 gap 被判定为不再成立的世代时间；`null` = 仍未解决 |
| `resolvedBy` | `next_generation \| superseded` \| null | 必填 | 解决方式；`null` 时 `resolvedAt` 必须为 `null` |

**gap 永不删除，只能被"解决"。**

```text
有效未解决 gap 集合 = { g ∈ gaps | g.resolvedAt == null }
completeness = "complete" ⟺ 有效未解决 gap 集合中不存在 severity == "blocking"
```

解决动作是一次**新的世代**：该 gap 行带上 `resolvedAt`/`resolvedBy`（这是 §4.11 允许的唯一
gap 行更新），或被整体标记 `superseded`。`[]`（已检查且无缺口）与字段缺失（`schema-invalid`）必须分开。

同一纪律在仓库里已是既有写法，但**引用要写准**：`swarm/evidence_archive.py:76`（`source_missing`）
与 `:81-82`（`historical_pin_mismatch_not_copied`）是 `archive()` **生产** gap 的位置；
`verify()` 本身不产生 gap，它只是把既有 `gaps` 的数量报出来（`swarm/evidence_archive.py:36` 的
`gap_count=len(manifest["gaps"])`），并在 `:22-37` 里做清单与逐文件摘要的复核。

### 4.9 两条轴：`completeness` 与 `lifecycle`（各自只有一个输入）

| 轴 | 取值 | 判定（**唯一输入**） |
| --- | --- | --- |
| `completeness` | `complete` | 全部 `sources[]` 满足 B0∧B1∧B2，且有效未解决 gap 集合中无 `blocking` |
| | `partial` | 否则 |
| `lifecycle` | `sealed` | 最新 attempt 的 `endedAt != null` **且** 其 `endEvidence != null` |
| | `open` | 否则 |

**完整性只由 sources/gaps 决定，结束证据只影响 lifecycle。** 上一版在"只在等 terminal 确认"时
直接判 `partial`，等于让一个生命周期事实去污染完整性判定——本轮 MINOR 指出后已去掉：
那种情形现在是 `complete + open`（**数据已齐、会话可能还没正式结束**），这是合法且必须可表达的。

**允许的状态转移**（其余一律 `manifest-regression`）：

| 从 | 到 | 说明 |
| --- | --- | --- |
| `partial` | `complete` | 补齐缺失 blob / 解决全部 blocking gap |
| `complete` | `partial` | **不允许**（回退） |
| `open` | `sealed` | 结束证据到齐 |
| `sealed` | `open` | **不允许**（回退） |

两轴正交带来 3 个合法组合（`partial+open`、`partial+sealed`、`complete+open`）与 1 个终态
（`complete+sealed`）。`partial+sealed` 是真实且必须可表达的：**会话已结束，但 scrollback 拿不到**。

### 4.10 版本与向后兼容规则

本期冻结 `schemaVersion: 1`。规则分读写两组，每条都可判定，且**失败类型分开**。

**读侧**

| 规则 | 谓词 | 违反时 |
| --- | --- | --- |
| R1 版本 | **`schemaVersion == 1`（严格等于 1）**。`0`、负数、`> 1`、非 `int`、`"1"` 这类字符串数字**全部**判不支持；**没有"向后兼容旧版本"这回事** | `version-unsupported` |
| R2 种类 | `kind == "agent_session_archive"` | `schema-invalid` |
| R3 未知字段 | **仅在 R1 通过后**适用：允许存在，忽略且不据此推断；读侧不回写，写侧拒绝改写（W3） | 不报错 |
| R4 必填缺失 | §4.3–§4.8 中"必填"缺失 → 拒绝。**不得用默认值补全** | `schema-invalid`（`missing:<字段>`） |
| R5 显式 null | `null` 是合法值，不得与缺失合并处理 | 依字段 |
| R6 身份自洽 | `sessionKeyDigest == sha256hex(canonicalBytes(sessionKey))` 且等于目录名 | `schema-invalid`（`identity-mismatch`） |
| R7 归档域一致 | `archivalGroup` 与所在目录三段一致（`null` ⇔ `_unlinked/`） | `schema-invalid`（`filing-mismatch`） |
| R8 前驱 | `generation==1` ⇔ `predecessor==null`；否则 `predecessor.manifestSha256` 必须等于**所指世代文件字节**的 sha256，且 `predecessor.generation == generation-1` | `chain-broken` |
| R9 引用结构合法 | 每个 `sources[]` 必须**结构上**是本域内的（`sha256` 64 hex、`bytes` ≥ 0、无路径/域字段）；**blob 是否存在不在此判定** | `schema-invalid`（`bad-blob-ref`） |
| R10 别名 | `aliases/<digest>.json` 的 `aliasOf` 必须指向真实存在的域，且**别名不得指向别名** | `alias-cycle` |

R9 是本轮 M7 的修正点：上一版把"blob 不存在"也算进 R9，于是 schema 校验阶段就退出了，
`blob-missing` 这条负例（B4）永远不可达。**路径合法性是结构问题，存在性是读时观察**，两者必须分开。

**写侧**

| 规则 | 要求 |
| --- | --- |
| W1 新增字段 | 必须**可选**且有文档化默认值；不得复用已有名字；不得改变已有字段类型或可空性 |
| W2 新增必填字段 | 必须升 `schemaVersion`，且保证旧读侧仍能读旧版本文件 |
| W3 未知顶层字段 | 读到含未知顶层字段的 manifest → **拒绝改写**（`unknown-fields`），交更新的写者 |
| W4 不重排 | 重写时 `attempts[]`/`gaps[]` 顺序与 `canonicalBytes` 键序都不变 |
| W5 不降级 | `generation` 严格 +1；`fence` 非减（同一写者内不变）；两轴只按 §4.9 单向推进 |

W3 是本设计对仓库既有风格的一处**有意偏离**：本仓库的单机契约普遍用"键集合严格相等"
（`swarm/coordinator_io.py:212-215`）。那种写法适合"一个版本、一个写者"；manifest 是**多版本写者**
共用的契约，严格相等会让旧写者静默丢掉新字段后继续写，把"只追加"变成"回退"。
所以：**读时宽容、写时按版本 fail closed**。

### 4.11 不可变 vs 可追加的边界

| 对象 | 边界 |
| --- | --- |
| `blobs/*` 字节 | **完全不可变**：同名不同字节是事故，绝不"更新" |
| **每个 manifest 世代文件** | **完全不可变**：发布后连自己的写入者也不再改它 |
| `sessionKey`（两项）、`sessionIdKind`、`schemaVersion`、`kind`、`createdAt`、`archivalGroup`、`generation`、`predecessor` | **完全不可变** |
| `attempts[i]` 的 `attempt`/`requestId`/`sourceHostId`/`archivedAt`/`host`/`agent`/`cwd`/`lineage`/`sources[].sha256`/`sources[].bytes` | **终局后不可变** |
| `attempts[i]` 的 `sealed`/`sealedAt`/`endEvidence` | **单向推进一次**（且只允许在该 attempt 仍是最新时） |
| `attempts[]` | **可追加**：新尝试 = 新行；**不得改写既有行** |
| `gaps[]` | **可追加 + 可解决**：旧 gap 不得删除；只允许填 `resolvedAt`/`resolvedBy` |
| `fence` / `updatedAt` / `completeness` / `lifecycle` | **单调或单向**，且只能通过"新增世代文件"实现 |

**"改写"在物理上不可能发生**：新世代是一个新文件，旧世代文件原地不动。
"追加而不改写"的谓词形状不必新造，仓库里已有同构实现：`swarm/swarm_ledger/ledger.py:315-336`
对同一窗口的重复导入做 upsert，并逐条拒绝回退——`finalized usage cannot change`（:315）、
`usage window regressed`（:317）、`usage subtotal regressed`（:319-320）、
`raw request history regressed or changed`（:332）、`turn history regressed`（:336）。
实现时应照搬这套形状：**先取唯一 tip，逐条断言"旧的是新的前缀/子集"，再写新世代。**

### 4.12 会话身份键集合：为什么必填 / 可省略

| 键 | 归属 | 必填性 | 若可省略，为什么 |
| --- | --- | --- | --- |
| `provider` | `sessionKey` | 必填 | 决定 id 命名空间、resume 语法、token 契约 |
| `sessionId` | `sessionKey` | 必填 | 跨主机唯一的对齐键 |
| `sessionIdKind` | 顶层属性 | 必填 | 校验强度是采集事实；**不进哈希** |
| `host` | `attempts[]` | 必填 | 归属与可达性判断都靠它；仓库明确禁止推断它（`swarm/swarm_ledger/trae_jsonl.py:38-40` 的 "No inferred host"） |
| `sourceHostId` | `attempts[]` | 必填 | "这份字节是谁产出的"——跨主机同字节场景的唯一区分依据（§5.7） |
| `agent` | `attempts[]` | 必填 | coordinator/worker/operator 的权限与记账不同 |
| `model` / `effort` | `attempts[]` | 必填**键**、值可为 `null` | `null`=未知；省略键会让读侧无法区分"未知"与"旧 schema" |
| `repoId` / `worktreeId` / `issueRef` | `attempts[]` | 必填键、值可为 `null` | 临时会话确实不在仓库/工作区/issue 下；`null` 是事实，缺失是损坏 |
| `cwd` | `attempts[]` | 必填键、值可为 `null` | 只存采集时原值：它在不同 host 上不可比，不能用来寻址（§4.13） |
| `startedAt` / `endedAt` | `attempts[]` | 必填键、值可为 `null` | provider 不一定给开始时间；进行中的会话确实没有结束时间 |
| `tokens` | 顶层 | 必填，可为 `null` | `null` ≠ 0（§4.6） |
| `sha256` + `bytes` | `sources[]` | 必填 | 内容寻址的全部依据；`bytes` 是半截上传的廉价判据，且允许为 0 |
| `terminalHandle` | `attempts[]` | **可省略** | 纯本机标识，跨主机无意义 |
| `localPath` | `sources[]` | **可省略** | 绝对路径在别的主机上不是数据 |
| `providerVersion` | `resume` | 必填键、值可为 `null` | 不填 `"unknown"`——那是把未知记成已知值 |
| `redaction` 整个对象 | 顶层 | **可省略** | `null` = 未脱敏；与"做了脱敏但没记方法"必须可区分 |

一条通用规则：**"必填但可为 null"不是啰嗦，它是让 `unknown` 成为可表达状态的唯一手段。**

### 4.13 身份键 vs 寻址键，以及跨 issue / 跨 host / 分叉的处置

| 集合 | 内容 | 用途 | 谁不能进来 |
| --- | --- | --- | --- |
| **身份键** | `(provider, sessionId)` | 决定 manifest 目录名；决定"两份 manifest 是不是同一个会话" | `host`、`worktreeId`、`cwd`、`issue`、时间 |
| **寻址 / 查询键** | `(archivalGroup, worktreeId, sessionId)` | 用户入口与列目录 | `cwd`（不同 host 不可比）；`host` 只作**来源标签** |

三种容易含糊的情形，各自给一条规则：

| 情形 | 规则 | 判据 |
| --- | --- | --- |
| **同一 session 后来归入另一个 issue** | 身份不变、`archivalGroup` 不变（**home 域不可变**）；另一个域只写 `aliases/<digest>.json`，内容 `{aliasVersion, sessionKeyDigest, aliasOf: <home 三段>}` | 读侧在该域找不到 home manifest 时跟随别名**一跳**；别名指向别名 → `alias-cycle` |
| **同一 `(provider, sessionId)` 在两台 host 各采一次（内容相同）** | **只有 owner 产生 attempt**；非 owner **只返回 `already-archived` + head 摘要**，不写任何共享字节 | 第一阶段**不登记第二份来源**：`manifest` 不可变，写它需要 owner 身份；要支持独立来源对象就得新增对象与新的授权面（收益不抵本期范围），所以**取消**非 owner 登记（§5.5.1）。第二份字节的价值由"内容寻址"本身承担：同一摘要就是同一份内容 |
| **同一 `(provider, sessionId)` 但内容明显不连续**（id 被复用） | 新 attempt 标 `lineage="fork"` 并记 `gaps: lineage_divergence`（`severity=warning`） | 新 transcript 的首条记录在旧前缀里出现过且旧前缀是新文件的前缀 → `primary`；否则 `fork` |

**分叉（chain fork）与本表的区别**：上表第一、三行是同一条链上的合法追加（第二行不产生任何共享写入）；
`chain-fork` 指的是**链本身出现两条 tip**（见 §5.4.4 d2），那不是数据情形而是协议故障，一律 fail closed。

---

## 5. 写入语义

本节全部是**待实现的契约**：仓库里没有 collector、队列或共享写入路径（§1.4）。
凡是写成"应当/必须先/不得"的动作，都是对实现的约束，不是对现状的描述。

### 5.1 采集触发点

| 触发 | 时机 | 采集什么 | 本期做 |
| --- | --- | --- | --- |
| 归档工作区（`worktree archive`） | **动作之前**（先建请求与保护） | 该 worktree 下已结束会话的 transcript + 可得 scrollback | 是 |
| 删除工作区（`worktree rm`） | **删除前置条件**（未确认前不删，§5.10） | 同上，且必须在上传确认后才允许物理删除 | 是 |
| 用户显式"归档历史" | 显式命令 | 指定 issue/worktree 的历史会话 | 是 |
| **会话打开（非归档触发，仅建保护）** | 首次产生可归档字节时 | 不采集，只建保护引用（§5.9 P0） | 是 |
| 周期性全量同步 | 定时器 | — | **否**（§2.3） |

"动作之前"这四个字是本轮 M8 的修正：上一版把归档写成"归档动作完成后"，那样字节在采集前就可能
已被删除。现在**触发点在破坏性动作之前**，与既有 archive hook 的方向一致
（`orca/src/shared/worktree/archive-hook-removal-gate.ts:1-17`：失败从"记日志继续"改成删除前置条件；
其判定词汇 `exited | unverifiable`，两者都阻断删除，见同文件 `:24-33`）。
本设计沿用这条：`archive-pending` / `read-only` / `unavailable` / `archive-status-unknown`
**都阻断删除**，只有 §5.10 的 `archiveConfirmed` 为真才放行。

### 5.2 步骤序列（可照着实现）

**顺序的第一原则：本机先持久化，共享侧后协商。** 上一版先取租约再入队，断网时连"想要归档"这件事都
记不下来；第二轮审查又指出"保护晚于字节消失"——所以现在保护是第一件事。

前置：调用方已确定 `sessionKey`、`archivalGroup`、待归档的本地文件清单。

```text
S0  保护引用先于一切（§5.9）：若无保护引用则创建之。若该 session 的保护在会话打开时就已建立，
    这里只做续期。**任何读取源字节的动作都在保护生效之后。**
S1  本机快照：以「有限前缀 + 稳定身份」读本地源文件（§5.3），得到
    (bytes, sha256, truncated, prefixBytes, origin) 与「读期间未被改动」的证据。
S2  本机持久入队：写 <local-state>/archive-queue/<requestId[0:2]>/<requestId>.json
    （state=pending，requestId 由 §5.7 计算；此时 fence/attempt/generation 皆 null）。
    **这一步必须能在完全离线的机器上成功。** 落盘后写盘位置见 §5.6.1。
S3  读链并判定 `TS`（§5.4.4 的 A→B→C→D）：得 `GENESIS`、`UNIQUE`、候选错误码、
    `chain-broken`、或 `chain-fork`；除前两者外一律终止本次（fail closed）。
S4  写者判定（§5.5.1，**正确性由它承担**）：
    · `TS==GENESIS` → 可以尝试创世（互斥由固定名 `g000001.json` 提供，不由租约）；
    · `TS==UNIQUE` 且 `head.attempts[-1].sourceHostId == 本机` → 我是合法写者，继续 S5；
    · `TS==UNIQUE` 且 owner 不是本机 → **不追加、不发布、不写任何共享字节**，返回
      `session-claimed-elsewhere`（附 head 摘要与 owner）或 `already-archived`（内容与 head 相同），结束本次。
      第一阶段**不登记第二份来源**（`manifest` 不可变，非 owner 无权写它；见 §5.5.1）。
    （claim/租约只作为最优努力去重，见 §5.5.2：拿不到就 `lease-busy` 退出，但它不决定我能否写。）
    写者判定通过后，S7 的 `generation = tip.generation + 1` 才有意义。
S5  上传 blob（§4.2 的每一个 `sources[]`，按**全部 sources 聚合**判定，不做单件跳步）：
    a) 逐件：已存在且长度相符则跳 d；长度不符 → `blob-truncated`；不存在 → b；
    b) 同目录写临时名 → fsync(file) → `os.link(临时名, 目标名)`（O_EXCL）→ fsync(dir) → unlink(临时名)；
    c) link 返回 ENOTSUP/EPERM/EXDEV → `blob-publish-unsupported`，fail closed；
    d) 回读重算摘要，必须等于文件名且长度等于 `bytes`；
    e) **每传完一件就落盘** `state=blob_published`（§5.6.1），不攒到最后。
    全部 `sources[]` 都达 B0∧B1∧B2 才进入 S6；否则本条保持 pending 等待重试。
S6  查重：遍历链上各世代的 attempts[]，若存在 `requestId` 相同者 → 判定"已提交"，
    直接跳 S10（不追加、不新起世代）。
S7  构造新世代：generation = （`GENESIS` 则 1，否则 tip.generation + 1），fence = 本租约的 fence，
    predecessor = （`GENESIS` 则 null，否则 `{tip.fence, tip.generation, sha256(tip 文件字节)}`）；
    追加本 attempt。
S8  发布不可变世代：link(tmp, manifests/<digest>/g<GGGGGG>.json)。
    EEXIST → 该 generation 的目标名已被占 → 丢弃已构造内容，回 S3 重读链、再走 S4（不是覆盖）。
S9  回 S3 重读链、再走 S4：必须仍为 `UNIQUE`，且**我发布的这一代仍在唯一链中**
    （即从 tip 沿 predecessor 能回溯到它，且其字节摘要等于我 `link` 的那份）。
    **不要求"tip 就是我"**——同机另一实例可能已在我之后追加了 g+1（§5.4.5），那仍然是健康链。
    只有"我的代不在链上"或 `TS` 变成错误时，才 `chain-broken`/`chain-fork` 终止（不删自己已发布的文件，它是证据）。
S10 写本地提交收据（§5.6.1）并回读校验：收据 = 该世代文件字节的 sha256 + 世代号 + fence。
S11 队列条目 state=confirmed，落盘。
S12 释放或继续持有租约（§5.5 决策表）；解除保护引用（§5.9 P3）。
S13 只有在此之后，才允许对该 session 的 scrollback 做任何回收动作（§5.10）。
```

四句不可交换的话：**本机先于共享、领取先于 fence、blob 先于 manifest、回读先于清理。**
再加三句：**号码在持有租约时分配，不在入队时分配；fence 号在持有 claim 之后才分配；
blob 条件按全部 sources 聚合判定，不因"先传完一件"就跳步。**

`S0` 与 `S1` 的区别要看清：`S0` 建立的是"不许删"的**声明**，`S1` 才是读字节。
上一版把两者合成一步，导致"保护引用写入"与"读取"之间没有顺序约束（M8）。

### 5.3 S1：稳定前缀怎么取

不要 `read()` 一把梭。现成工具：

- `swarm/log_io.py:24-36` 的 `prefix_digest(source, size)`：1 MiB 分块算前缀摘要，内存与文件大小无关；
  读到提前 EOF 会抛错，把"文件被截断"与"文件到底"分开。
- `swarm/pi_transcript.py:44-57` 是完整范例的读取循环（`fstat` 拿身份 → 逐行读 → 校验每行以 `\n` 结尾），
  `:58-60` 是读后 `seek(0)` 重算摘要并比对。**这两段要分别引用**，别混成一段。
- 返回值用成对形状 `{bytes, sha256}`（`swarm/pi_transcript.py:79`）。

第一期按 §5.11 只归档已结束会话，因此正常路径不会遇到半行；但 `truncated` 字段仍然必须存在，
否则将来放开增量归档时只能改 schema。

### 5.4 世代链：tip、predecessor、fork 检测（**B1 的解法，路线：甲**）

本轮审查证明上一版的核心推论不成立，先把它写清楚，再给新协议。

#### 5.4.1 上一版错在哪（被采纳的反例）

上一版说："发布 `g<G+1>-f<F>` 成功就等于对预期 head 做了原子 CAS，且 head = `(fence, generation)` 最大者。"
审查给出的交错（**成立**）：

```text
A 持 f1，读到 tip H(=g4-f1)，检查 maxFence == 1，然后暂停
B 领到 f2（fences/2 已存在，所以 maxFence == 2），读到同一个 tip H，暂停
A 发布 g5-f1（名字无人占用 → 成功）；S8 读回：候选只有 {g4-f1, g5-f1}，最大是 g5-f1 → A 判定自己是 head，确认并交付
B 发布 g5-f2（**另一个名字**，也成功）；此后按"fence 大者胜"，head 变成 g5-f2
结果：A 已确认的那一代不再是 head，A 的 attempt 从 head 消失
```

两个不同 fence 的两个不同文件名**都能创建成功**，所以"名字独占"不是跨 fence 的 head CAS。
更根本的问题：写入者**在写入时刻无法知道**"我是不是唯一的后继"——纯 POSIX 不提供这个信息。

#### 5.4.2 第一阶段的写者模型：单写者追加（本设计的范围收窄）

连续三轮审查的剩余缺陷都集中在"同一 session 有两个写者时如何裁决"。**这不是第一阶段的问题**：
第一阶段要解决的是"轨迹只在那台执行主机上"，所以一个 session 的字节天然只有一个来源主机。
据此把第一阶段的契约收窄——这是本设计可定的范围，不是 owner 待拍板项。

**三条规则（第一阶段的全部写者语义）：**

| # | 规则 |
| --- | --- |
| W-1 | **每个 session 只有一个合法写者。** 追加只能由 `head.attempts[-1].sourceHostId` 那台主机进行（以及它自己的重试）。**创世世代**是个例外：`head` 还不存在时，谁能抢到那个名字谁就是创世者（见下） |
| W-2 | **第二台主机一律不追加、不发布新世代、也不写任何共享字节。** 它只返回可判定状态 `session-claimed-elsewhere`（附 `head` 的 `generation`/`manifestSha256` 与 `sourceHostId`）或 `already-archived`（内容与 head 相同）。**第一阶段不登记第二份来源**：manifest 不可变，非 owner 无权写它（§5.5.1） |
| W-3 | 因此**"两个写者交错发布"在协议层面不可达**。claim / 租约退化为**去重与避免重复劳动的最优努力机制**，不再承担正确性（§5.5） |

**创世为什么不是竞态**：`generation == 1` 的文件名是**固定的那一个** `g000001.json`。
两台主机同时尝试创世时，`link`/`O_EXCL` 只可能有一个成功，另一个拿到 `EEXIST`；
失败者按 W-2 读回胜者的 `g1`，发现 `attempts[-1].sourceHostId` 不是自己 → 返回 `session-claimed-elsewhere`。
**从此这个 session 的写者就是胜者那台主机，直到那台主机明确地不再持有该 session**（§5.5.1 / §5.12）。

**claim 竞态的最坏结果（逐条证明，这是路线收窄换来的性质）：**

| 竞态 | 最坏结果 | 为什么不会更坏 |
| --- | --- | --- |
| 两方都以为自己持有 claim，各传同一 blob | 重复上传**同一份字节** → 内容寻址，第二份 `EEXIST` 或被 `lstat` 判为已存在 → **一份 blob** | blob 名即摘要，不可能产生第二份 |
| 两方都以为自己持有 claim，各算同一代 | 撞名 `g<N>.json` → 一方 `EEXIST` → 它必须重读（§5.4.5） | 一个世代只有一个名字（§4.1） |
| 非写者（另一台主机）强行追加 | 它算出的代号已被占 → `EEXIST`；或算出的代号更新 → 它能写进去，但它的 `sourceHostId` 与 `head.attempts[-1]` 不同 ⇒**违反 W-2**，属于实现缺陷，被 B20 的断言捕获（读侧仍能看到完整链，因为两个世代用不同名字且前驱指针正确） | 这不是协议允许的路径，而是需要测出的缺陷 |
| claim 被误删/被抢 | 一次**拒绝服务**（该 session 暂停归档）或重复劳动 | claim 不承载正确性，所以它坏掉不会让已提交的 attempt 消失 |
| 写者 host 永久损坏 | 该 session **停在最后一个已提交世代**：仍然**可读**，只是不再增长 | 没有"必须由别人接管才能读"的依赖（对比上一版：分叉会让会话不可读） |

**明确不声称、也不提供（后续切片）**：多写者并发、跨主机接管、迁移后由新主机续写。
它们的前置条件是**存储侧条件写**（对象存储条件 PUT / `If-None-Match: *`、DB 行锁、带 version 的 CAS），
纯 POSIX 文件协议给不出。§5.12 保留了这套机制的设计草案与其反例证据，**但它不在第一阶段契约内，
也不是第一阶段正确性的前提**。

| 项 | 第一阶段（契约） | 后续切片（草案，§5.12） |
| --- | --- | --- |
| 写者数 | 每 session 一个（W-1） | 可接管、可迁移 |
| claim / 租约 | 最优努力去重（§5.5） | 承担正确性，需可证明互斥 |
| fence | 属性，只用于归因 | 单调 token，参与裁决 |
| head 判定 | 唯一写者链上的唯一 tip | 需跨 fence 的线性化提交 |
| 分叉 | 只来自人为复制/篡改 ⇒ 诊断 + fail closed | 仍需处理并发写者 |

#### 5.4.3 链的结构：`generation` 全局单调，`predecessor` 显式三元组

```text
创世世代：generation == 1，predecessor == null
          fence = 首个"成功提交创世"的写者的 fence（不是"第一个被领取的 fence"——
          被领取但从未成功提交的 fence 不应写进历史，§5.5.2）
后继世代：generation == predecessor.generation + 1
          predecessor = {fence, generation, manifestSha256}   # 上一代是谁、在哪、字节摘要
```

`generation` 全局单调、不回退，且**一个世代只有一个文件名**（§4.1）。
所以一个 session 历史上只有一个 `generation == 1` 的文件（创世），它空前驱；
此后所有世代都指向前一代。R8（§4.10）就这一条基例，无第二分支。

#### 5.4.4 候选错误门 + head 判定：一张表，按 A→B→C→D 顺序，每步都可判定

上一版把"枚举"、"候选自己坏不坏"、"链断没断"、"分不分叉"混在一起，于是同一份输入可以同时推出
`chain-broken` 与 `chain-fork`，而且"最高代坏了"的归属要另写一段文字补。现在把**候选错误门**
（B）显式放在**选 head**（D）之前，四步走完，**先满足的那一步就结束**，每步的判据都只依赖前一步的输出。

```text
A. 枚举（只看文件名，不看内容）
   A1  目录不存在，或目录内没有匹配 ^g(\d{6})\.json$ 的文件        →  GENESIS（结束）
   A2  名字不匹配正则的文件一律**忽略**，并记 gap: nonconforming_file
       （本文自始至终是设计记录、上一版命名从未发布，所以没有需要兼容的历史目录）
   A3  否则得到候选集 C = { g | 存在 g<g>.json }

B. 候选错误门（必须整集通过才进 D；每个候选恰归一类，分类顺序固定：JSON → kind → version → 结构）
   b1  字节不是合法 JSON（含重复键、NaN）                →  parse-error
   b2  kind ≠ "agent_session_archive"                    →  schema-invalid   （与 R2 同一个码）
   b3  schemaVersion != 1（含 0、负数、>1、非 int、字符串数字）→  version-unsupported
       —— 即 **R1 的全部否定形式都在 b3 收口**，R1 不是独立判定点（避免两处谓词漂移）
   b4  R4–R7 / R9 不通过（不含 R1，R1 已在 b3）              →  schema-invalid
   ok  以上都不命中                                        →  该候选合格

C. 候选错误裁决（只在存在非 ok 候选时执行）
   C1  g* = max{ g | 候选 g 非 ok }
   C2  报 g* 的码并结束                                  →  "最高坏代说了算"
       （不管 g* 下面有没有合格候选；这就是"不静默退回旧代"的操作化形式）

D. 全部合格 ⇒ 求 head
   d1  存在候选的 predecessor 解析不了（指向不存在的文件 / 摘要不符 / generation 不是 g-1）
                                                          →  chain-broken（**优先于 d2**）
   d2  tip 数 ≥ 2，或两个世代声明**同一个** predecessor    →  chain-fork（**本期不可达，见下**）
   d3  恰好一条 tip 且回溯到 g1 成功                       →  UNIQUE，该 tip 就是 head
```

**`d2` / `chain-fork` 在本期不可达，这是一个结论而不是待办**：单名空间下"一个世代恰好一个文件名"
（§4.1），而 `d1` 又要求 `predecessor.generation == g-1`。要产生两条 tip，需要有两条支挂在同一前驱上，
那必然要求"同一 generation 两个文件"（被命名唯一性排除）或"跳号的 generation"（被 `d1` 判为
`chain-broken`）。所以正常实现与单点篡改都到不了 `d2`：**它只为后续多写者切片与排障保留**（§5.12），
读侧仍必须实现它的响应形状，但**本文不声称它有端到端场景**（§8 B8/B15）。

**三个必须唯一的输入，各自的唯一输出（这是本轮 M7 要求的覆盖条件）：**

| 输入 | 命中 | 唯一输出 |
| --- | --- | --- |
| 全部候选都坏 | C1 取最高坏代；若都坏则 g* 就是最大代 | 该代的码。例：全部 JSON 坏 → `parse-error`；一坏版一坏结构且版本代更高 → `version-unsupported` |
| 合法 `g1` + 坏 `g2` | C，g* = 2 | `g2` 的码（例：`parse-error`）。**不返回 `g1`**，要读 `g1` 只能 `--at-generation 1` 诊断模式 |
| 同一代两个文件、错误类型不同 | **当前命名下不可构造**：一个世代只有一个名字 `g<gen>.json`（§4.1）。若有人把旧命名 `g<gen>-f<fence>.json` 塞进目录，A2 直接忽略并记 `nonconforming_file`，**不参与任何判定** | 该输入不会产生竞争性码；判定只由 A2 + 后续步骤给出 |
| 人为把副本改名成"下一个世代"，且前驱**指向前一代**（连续） | 两个候选都合格 ⇒ **d3** | **`UNIQUE`**——这是**正常延长链**，不是分叉（上一版把这一行写成 d2/`chain-fork`，与 d1 的连续性规则相反，已改）；要让链真的分叉，必须让两条支挂在**同一个前驱**上，而那在当前单名空间下不可构造（见上一行与 B15） |
| `schemaVersion = 0`（其余合法） | B/b3 | `version-unsupported` |
| `schemaVersion = -1`（其余合法） | B/b3 | `version-unsupported` |
| `schemaVersion = "1"`（字符串，其余合法） | B/b3 | `version-unsupported` |

四条必须记住的性质：

1. **`GENESIS` 不是"零条 tip"，而是"零个候选文件"。** 上一版写"`¬T0` → `chain-fork`（任意态适用）"，
   而首次归档的候选集就是空 —— 那条规则把创世直接闸死（B16 无法执行）。判据从"tip 数"换成"候选数"
   之后，空目录与不存在的目录都是 `GENESIS`，目录存在但不含规范文件也是 `GENESIS`。
2. **候选错误门先于 head 选择。** 只要某一代坏了，**任何** head（包括完好的 `g1`）都不返回。
   理由：坏候选可能是一次写了一半的新世代，拿 `g1` 冒充当前内容是一次**静默降级**（§6.4 的策略）。
3. **`chain-broken` 优先于 `chain-fork`，且后者本期不可达。** 前驱缺失或不连续的候选
   **根本不是链上节点**，所以"一个断链节点 + 一个 tip"不是分叉；而"两个候选都完整回溯到 `g1`"
   在单名空间 + 连续前驱两个不变量下构造不出来。所以 d2 是**保留码**，不是常规路径。
4. **head 不含"取最大"这一步。** 上一版的 `max(有效, key=(fence, generation))` 正是"静默选边"。
   现在即使出现两条 tip 也只能被**看见**（`chain-fork` fail closed），不能被**解决**。

#### 5.4.5 单 fence 内的并发（同一个写者身份）

同一 fence 意味着同一个租约持有者，但进程内可能有两个请求同时处理同一 session：

- 两者都从 tip `G` 构造 **同一个名字** `g<G+1>.json`；`link` 只有一个成功，另一个 `EEXIST`；
- 失败者**丢弃已构造内容**，回 S3 重读链、再走 S4（现在 tip 是胜者的那一代），重新构造 `g<G+2>.json`；
- 因此 **CAS 落在"世代号"上，与写者身份无关**：只要两方算出的代号相同就必然撞名。
  这比"名字里塞 fence"强：塞 fence 会让同一代有两个可用名字，写入者反而可以各写一份（§5.4.2）。

#### 5.4.6 发布原语与能力要求（fail closed，不许降级）

| 能力 | 探测方式 | 不支持时 |
| --- | --- | --- |
| `O_EXCL` / `link` 不覆盖（**第一阶段的唯一硬依赖**） | 探针在第二次创建同名文件时必须 `EEXIST` | `fence-unsupported`：**禁止归档写入**（不能建世代），条目 `failed_terminal`。第一阶段的 CAS 完全建立在这一条上（§5.4.2） |
| `link` 不覆盖 | 探针第二次 `link` 到同一目标必须 `EEXIST` | `blob-publish-unsupported`；**不得改用 `replace`** |
| `fsync(dir)` 生效 | 探针写入后 fsync 目录并核对 | `fsync-unsupported`：**不发布**（宁可不归档，也不假装落盘） |
| 目录原子 rename | 探针要求 rename 后目标可见且源消失 | 只影响本地队列；共享侧不用 rename 发布 |
| 跨客户端互斥（**可选**，仅去重优化） | 两台进程同时 O_EXCL 同一名字 | 不使用 `flock` 优化即可；**正确性不依赖它**（§5.4.2） |

`swarm/coordinator_io.py:264-276` 的 `publish_new` 与 `:279-305` 的 `publish_directory_new` 是同一取向的
先例：后者在能力缺失时 `ENOTSUP` fail closed，**不提供 rename/replace 回退**（注释
"No rename/replace fallback: unsupported kernels/filesystems fail closed"）。但要说清一件事：
`publish_new` 的 `link` 只能证明"这个**名字**没被占用"（`swarm/coordinator_io.py:273`）。
在第一阶段的命名下（一个世代一个名字）这一条**恰好够用**：它保证同一代只有一个文件，
而"谁能写这一代"由 §5.4.2 的 W-1 决定。它仍然不能证明"我是唯一的后继"——那个问题属于 §5.12。

### 5.5 第一阶段：写者判定在前，claim/租约只做去重

**顺序先说清：正确性由 §5.4.2 的 W-1/W-2 承担，不由租约承担。** 本节描述的 claim 与租约
只是"别让两台机器做同一件重复劳动"的**最优努力**机制——它坏了、被抢了、被误删了，
最坏结果是重复上传或一次拒绝服务，**不会让已提交的 attempt 消失**（§5.4.2 的逐条证明）。

```text
leases/<sessionKeyDigest>.lease   最优努力占用；内容含 holderId/hostId/pid/fence/heartbeatAt
leases/<sessionKeyDigest>.claim   最优努力去重：正在做这件事的短时标记（可被过期回收）
```

#### 5.5.1 谁能追加：先看 owner，再看本地占用

| 步 | 判定 | 结果 |
| --- | --- | --- |
| 1 | `TS == GENESIS`（还没有任何世代） | 可以尝试创世：`link` 到固定名 `g000001.json`（§5.4.2）。**创世的互斥由这个名字本身提供**，不由租约提供 |
| 2 | `TS == UNIQUE` 且 `head.attempts[-1].sourceHostId == 本机` | **本机是合法写者**，进入 S5 上传 blob |
| 3 | `TS == UNIQUE` 且 owner 不是本机 | **不追加、不发布**。返回 `session-claimed-elsewhere`，附 `{headGeneration, headManifestSha256, ownerHostId}`；若本次字节与 `head.sources[]` 逐件摘要相同则返回 `already-archived` |
| 4 | `TS == UNIQUE`、owner 是本机，但字节与 head 相同（同一内容重试） | 返回 `already-archived`（附 head 摘要），**不追加新世代** |
| 5 | `TS ∈ {chain-broken, chain-fork}` 或候选错误码 | 不追加；按 §6.4 报同一码（写侧报 `manifest-unusable`，`detail.reason` 携带原码） |

**重复字节的处置（本期结论：不登记）**：非写者确实采集到了同一份轨迹时，**只返回** `already-archived`
与 head 摘要，不写任何共享字节。原因是结构性的：`manifest` 是不可变的，往里加"第二份来源"需要 owner 身份；
另立一个独立来源对象则要新增对象、新增授权面、新增读路径分支——收益（同一摘要的第二份副本）
在内容寻址下几乎没有（同一 `sha256` 就是同一份内容），所以**第一阶段取消它**。
如果将来确实需要"多来源证据"，那是一个独立对象的设计，不是往 manifest 里塞字段。

#### 5.5.2 claim / 租约：用途与最坏情况

| 用途 | 说明 |
| --- | --- |
| 避免重复劳动 | 拿到 claim 的机器去做上传；另一台直接得到 `lease-busy` 并退出，省一次全量哈希与上传 |
| 停滞可见 | 租约 `heartbeatAt` 过旧 ⇒ `stalled-hours` 信号进 Operator/用户视野。**过期不授权任何接管** |
| 记录写者 | `fence` 写进 manifest 的 `producer`，用于归因与排障 |

| 故障 | 后果 | 是否影响正确性 |
| --- | --- | --- |
| 两台机器都以为自己持有 claim | 重复上传同一份 blob（内容寻址 ⇒ 一份）、或同代撞名（`EEXIST` ⇒ 一方重读） | **否** |
| claim 被误删 | 多一台机器做重复劳动 | **否** |
| 租约被误清 | 同机/异机都可能重复劳动；异机仍按 W-2 被拒 | **否** |
| 租约永久滞留（写者 host 消失） | 该 session 停在最后一个已提交世代，**仍然可读**；只是不再增长 | **否**（可读性不变） |

**第一阶段不做的事**：`claim` 的半成品状态机、fence 单调分配、跨主机接管、同机继承的互斥边界。
它们全部移到 §5.12 的草案里，并明确标注"不在第一阶段契约内"。

**明确不要复用** `swarm/coordinator_io.py:327-382` 的 `directory_lock`（`bound_lock` 同理
`:415-424`）：它要求目录 `0700` 且 `st_uid == os.getuid()`、锁文件 `0600` 同 uid、`flock` 加
`st_nlink == 1` 复核——全是单机私有目录假设，而且它没有"持有者身份 + TTL + fence"的概念。
仓库自己已把这层风险写成纪律：`swarm/release_radar/storage.py:1-5`（"On NAS these semantics must be
verified by the operator; unsupported locking fails closed"）。

`flock` 若实测可靠，可作为**同主机内的快速排他**（省一次远端读），但正确性不依赖它。

### 5.6 崩溃 / 部分上传后的对账

#### 5.6.1 每步的落盘点（本轮 M2 补齐）

**落盘规则是逐步骤的，不是一句笼统的"先落盘再动共享侧"**（上一版那句话与"`link` 之后才落
`manifest_published`"互相矛盾，r6 的 MINOR 指的就是这个）。精确规则三条：

| 规则 | 内容 |
| --- | --- |
| P-a 先落盘再做 | 任何**对外可见的副作用之前**，先把"我要做什么"写到本地（条目 `state` / `requestId` / `items`）；这样崩溃后能判断"做到哪" |
| P-b 后落盘表示完成 | 依赖外部动作**成功**的状态（`blob_published`、`manifest_published`）在动作**成功之后**才写；**绝不预写**（预写会让状态指向一个不存在的对象） |
| P-c 幂等重算 | 不能从本地判断的（`TS`、`Ball`、`M2`、`R`）一律**重算，不缓存权威** |

每一步归哪一条：

| 步骤 | 落盘内容（本地队列条目） | 崩溃后可从何处恢复 |
| --- | --- | --- |
| S0 | 保护引用 `archive-protect/<digest>.json`（P-a） | 保护引用 |
| S1–S2 | `state=pending`、`items[]`、`requestId`、`submittedSeq`；`fence/attempt/generation = null`（P-a） | 条目本身 |
| **S3（读链）** | **不落盘**（P-c：`TS` 每次现算，不缓存权威） | 重算 |
| **S4（验 owner）** | `preOwner` 与 `fence`（若通过）；`¬OW` 时只落"拒绝"事实，**不写共享字节**（P-a） | 重算 + 条目 |
| S5 每传完一件 blob | `state=blob_published`（**逐件落盘、动作成功之后才写**，P-b） | 动作表逐行 |
| S6–S7 | 构造出的世代内容**不落盘**（避免半成品被误认）；**已构造但未发布 = 不存在**（P-b） | 重构造 |
| **S8 `link` 成功后（下一动作）** | **`state=manifest_published`**，并记 `publishedGeneration`/`publishedManifestSha256`；**这一步是独立的落盘动作，与 `link` 不是一个原子单元** | tip 解析（§5.6.3 的 `¬R` 行） |
| S10 | **提交收据** `archive-receipt/<requestId>.json` = `{requestId, sessionKeyDigest, generation, fence, manifestSha256(所发布文件字节), archivedAt}` | 收据 |
| S11 | `state=confirmed`、`confirmedManifestSha256` = 收据里的 `manifestSha256` | 收据 + 条目 |
| S12 | `leaseToken=null`（已释放）或新 `expiresAt`（继续持有）；保护引用解除 | 租约 + 保护 |

**收据是幂等确认的锚点，不是"最新 head 的摘要"。** 下一节与 §5.10 都靠它。

**P-b 的直白说法**：`link` 之前**什么状态都不写**
（构造物不落盘）；`link` 成功**之后**才把 `state=manifest_published` 落盘。
两者之间是一个**可崩溃窗口**，处理办法见 §5.6.3 的 `¬R` 与 `M2` 两行——不需要、也不允许
“先写 manifest_published 再发布”这种预落盘（那会让崩溃后的状态指向一个不存在的文件）。

#### 5.6.2 观察谓词

| 谓词 | 判定 | 成本 |
| --- | --- | --- |
| `B0(s)` / `B1(s)` / `B2(s)` | 单个 source：存在且普通文件 / 长度 == `bytes` / 回读摘要 == `sha256` | O(1) / O(1) / O(n) |
| **`Ball`** | **聚合**：∀ s ∈ `sources[]`: `B0(s)∧B1(s)∧B2(s)` | Σ |
| `Bmiss` / `Btrunc` / `Bcorrupt` | `Ball` 为假时的子情形归类（哪一件、哪种错）；多种同时出现时按 `Bcorrupt > Btrunc > Bmiss` 归一个 | Σ |
| `G0` | **存在至少一个世代文件**：目录中存在匹配 `^g\d{6}\.json$` 的文件 | O(1) |
| `TS` | §5.4.4 的 A→B→C→D 判定结果：`GENESIS` / `UNIQUE` / `<候选错误码>`（`parse-error`/`schema-invalid`/`version-unsupported`）/ `chain-broken` / `chain-fork` | O(n) |
| **`OW`（owner 闸门）** | 本机是该 session 的**唯一合法写者**：`TS==GENESIS`，或 `TS==UNIQUE ∧ head.attempts[-1].sourceHostId == 本机`。**它是"能不能写共享字节"的唯一判据**，与 §5.5.1 的写者判定同一条件，不另立一套 | O(n) |
| `preOwner` | **发布前**读到的 owner：`u.attempts[-1].sourceHostId`，其中 `u` 是本条目将要指向的前驱世代（`GENESIS` 时为 `null`）。**审计与 B20 只能用它，不能用发布后的 `tip.attempts[-1]`** | O(n) |
| `M2` | 本请求已提交：链上任一世代的 `attempts[]` 含 `requestId == 条目.requestId` | O(n) |
| `R` | 收据存在且可校验：`archive-receipt/<requestId>.json` 可解析，其 `manifestSha256` 所指文件存在且摘要相符 | O(1) |
| `Q0` | 队列条目可解析：`parse()` 通过且 `requestId` 与文件名一致 | O(1) |

三处修正（本轮 M2 与 M7）：

- **删掉旧的 `M0`（“目录存在”）与 `T0`/`T1`。** 上一版用“目录存在”冒充“有世代存在”，
  于是**空目录**同时给出 `M0 真 / M1a 假`，被误报 `parse-error`；而首次归档（目录不存在）又因
  `¬T0` 被直接判 `chain-fork`，创世永远走不到。现在：**目录是否存在根本不参与判定**，
  只看“有没有匹配模式的世代文件”（`G0`），没有就是 `GENESIS`。
- **`Ball` 是聚合谓词**，不是“先传完的那一件”。上一版把 `B0∧B1∧B2` 挂在单件上，
  于是“只传了 transcript、scrollback 还没传”会被当成“blob 已齐”；现在必须全部 `sources[]` 达标。
- **`TS` 把链的四种结果收到一个引用上**，后面的动作表只比对 `TS`，不再自己拼 tip 集合。
  这样重算动作表与读侧（§6.4）用的是**同一张判定表**，不会两处给出不同答案。
- **`OW` 是本轮（r6）新增的前置谓词**：上一版的恢复表里，"补 blob"与"发布新世代"直接跳到 S5/S6–S10，
  没有重验 owner，于是**非 owner 可以从恢复路径合法地追加**（r6 的最小反例见 §5.6.3 末尾）。

#### 5.6.3 动作表

**唯一裁决顺序（本轮 r7 重写；顺序本身是契约的一部分，不许重排）**：

```text
R0  终态：state ∈ {superseded, confirmed} ⇒ 只做收尾校验，不进下面任何一步
R1  队列条目可解析吗（Q0）                       ⇒ 否则 queue-entry-corrupt（隔离，不重试）
R2  算 TS（A→B→C→D：解析 / 版本 / 结构 / 缺链 / 分叉）
R3  TS 不可用（候选错误 / chain-broken / chain-fork）
                                                 ⇒ 返回对应读侧码（manifest-unusable 等）
                                                    **此时还没有可用的 head/owner，因此绝不可能报
                                                    session-claimed-elsewhere**
R4  无条件豁免（不写共享字节，因此不适用 OW）
    4a 补记本机收据（M2 命中 / manifest_published ∧ ¬R）
    4b 本地诊断（分叉/损坏证据、本地诊断副本、清理自己的临时名）
R5  需要写共享字节的动作 ⇒ 才适用 OW
    5a ¬OW  ⇒ session-claimed-elsewhere 终止（附 head 摘要与 owner），**不写任何共享字节**
    5b OW    ⇒ 按 blob → 链 → 提交继续
```

三条必须写死的性质：

1. **`OW` 的判定需要 head，因此它不能排在"算 TS"之前。** 上一版把"任意非终态 ∧ `¬OW` ⇒ 立即终止"
   放在表首，于是 `TS == parse-error` 时连 head 都没有，却会算出 `OW=false` 并报
   `session-claimed-elsewhere`——一个**在事实上无法成立的拒绝理由**。现在 `R3` 先出读侧码。
2. **豁免写在 `OW` 之前，而且它不是"例外"，是这一层根本不适用 `OW`。** 补记收据与本地诊断
   **不写共享字节**，所以不存在"要不要过 owner 闸门"这个问题；上一版把它写成"任何路径都不例外"
   再加一行"不需 OW"，两句话互相抵消，导致豁免永远到不了（r7 指出的矛盾）。
3. **`OW` 只约束"写共享字节"的动作。** 清单固定为三项：补上传缺失的 blob、构造并发布新世代、
   重发一个已存在的 blob（不做"这个 blob 已经对所以可以写"的例外——例外会重新开一条不验 owner 的写路径）。
   除此之外没有任何需要 `OW` 的动作；**也没有任何绕过 `OW` 的共享写**（见 §5.6.4：分叉证据本期只落本地）。

下表**按 R0–R5 排列，行序即求值序**（不是排版顺序）。

| 层 | 条目 state | 观察 | 动作 | 对外状态 |
| --- | --- | --- | --- | --- |
| R0 | 任意 | `state == superseded` | 终态，不处理；其字节已由后继请求覆盖 | `superseded` |
| R0 | `confirmed` | `R`（收据可校验、世代在链上） | 无事可做 | `confirmed` |
| R0 | `confirmed` | `¬R`（文件被改/被删） | 降回 `manifest_published` 并报 | `manifest-regression` |
| R1 | 任意 | `¬Q0` | 隔离到 `archive-queue/_corrupt/`，不重试 | `queue-entry-corrupt` |
| R3 | 任意 | `TS == chain-fork` | **停止**，写**本地**分叉证据（§5.6.4；本期只落本地），不选边 | `chain-fork` |
| R3 | 任意 | `TS == chain-broken` | 停止；**不退回旧代** | `chain-broken` |
| R3 | 任意 | `TS ∈ {parse-error, schema-invalid, version-unsupported}` | 停止（候选错误门 C + 最高坏代裁决，§5.4.4）。**此时不可能报 `session-claimed-elsewhere`**：还没有可用 head/owner | `manifest-unusable`（`detail.reason` = 该码） |
| R4a | `pending` | `Ball ∧ M2` | 本请求已在链上（崩在 S10/S11 之前）→ 补写收据 → S11。**不适用 `OW`**（只写本地） | `confirmed` |
| R4a | `blob_published` | `Ball ∧ M2` | `link` 成功、`manifest_published` 未落盘即崩溃 → 链上已有本 `requestId` ⇒ 补写收据 → S11。**不适用 `OW`**（只写本地） | `confirmed` |
| R4a | `manifest_published` | `R ∧ 该世代在链上` | **正常确认路径**：读收据 → 校验文件摘要 → S11。**不适用 `OW`** | `confirmed` |
| R4b | 任意 | `¬Ball` → `Btrunc` | 半截；**不覆盖、不写共享**，留本地诊断副本，需人工。**不适用 `OW`** | `blob-truncated` |
| R4b | 任意 | `¬Ball` → `Bcorrupt` | 同名不同内容 = 事故；停止重试。**不适用 `OW`** | `blob-corrupt` |
| R4b | `manifest_published` | `¬R`（收据未写成，崩在 S10） | 按 `publishedGeneration` 定位文件、重算摘要、**补写收据** → S11。**不适用 `OW`**（只写本地） | `archive-pending` |
| R5 | 任意（非终态） | **`¬OW`** | **终止**；附 head 摘要与 owner，**不写任何共享字节**。只对下面几个写共享的动作成立 | `session-claimed-elsewhere` |
| R5 | 任意（非终态） | `OW ∧ 本请求与 head 内容逐件相同 ∧ M2` | 已经归档过 ⇒ 只确认，**不发布新世代** | `already-archived` |
| R5 | 任意 | **`OW ∧ ¬Ball` → `Bmiss`** | 上传缺失的那几件（S5）。**写共享字节 ⇒ 必须先过 `OW`** | `archive-pending` |
| R5 | `pending` | **`OW ∧ Ball ∧ ¬M2`** | 还没提交过 → S6 查重 → S7 构造 → S8 发布（**写链 ⇒ 必须先过 `OW`**） | `archive-pending` |
| R5 | `blob_published` | **`OW ∧ Ball ∧ TS == GENESIS ∧ ¬M2`** | **真创世**（无任何世代文件，或只有临时名）→ S7 建 `g1`，`predecessor=null`（`GENESIS` 下 `OW` 恒真） | `archive-pending` |
| R5 | `blob_published` | **`OW ∧ Ball ∧ TS == UNIQUE ∧ ¬M2`** | 继续 S6–S10（这正是 r6 反例的入口，现在被 `OW` 拦住） | `archive-pending` |
| R5 | `blob_published` | `¬Ball`（首代只传了一部分） | 回上面三行（唯一写共享的 `Bmiss` 也要先过 `OW`）；**不要因"已有 blob"就跳去发布** | 同左 |
| R5 | `manifest_published` | `R ∧ 该世代不在链上` | 世代被链丢掉了（只可能来自人为删除/还原） | `manifest-regression` |
| R5 | 任意 | 发布时 `EEXIST` | 名字被占 = **同一 generation 目标名**已有人写 | 回 S3 重读链、再走 S4（§5.4.5） |
| R1–R5 | 任意 | 共享侧错误/超时/权限 | **不改变 state**，按退避重试 | `unavailable/<§6.3 的 offline\|unreachable\|permission-denied>` |

本轮（r5）对这张表的三处改动：① 新增 **`blob_published ∧ Ball ∧ M2`**（`link` 成功、状态未落盘就崩溃）；
② 把**终态排除提到第一行**（`superseded` 不再与上传规则竞争）；③ 把"预落盘"的说法全部删掉，
只保留"`link` 之后落 `manifest_published`"，并说明两者之间的可崩溃窗口由 `¬R`/`M2` 两行吸收。

**r6 的最小反例，与它的处置（必须对照读）**：

```text
A/B 都在 GENESIS 通过 S4；B 完成 blob 上传、落 blob_published、在 S8 之前崩溃
A 随后发布 g1，成为 owner
B 重启：Ball 成立、TS==UNIQUE、¬M2、条目 state=blob_published
        —— 上一版按"blob_published ∧ Ball ∧ TS==UNIQUE ∧ ¬M2 ⇒ 继续 S6–S10"直接发布 g2
结果：非 owner 从恢复路径追加成功，W-2 与 B9 双双失效（链仍完整，但"任何路径非 owner 都不写链"不成立）
```

**现在**：该行前面多了 `OW` 闸门。B 在 `OW` 处判出 `head.attempts[-1].sourceHostId != 本机` ⇒
`session-claimed-elsewhere` 终止，**不发布**。B 的条目保持 `blob_published`，它的字节留在
`blobs/` 里（内容寻址、无害），由 owner 的后续世代自然引用到同一份 blob。
**验收见 §8 B21**（专门覆盖这条交错）。

#### 5.6.4 分叉证据：**本期只落本地**

```text
<local-state>/archive-fork-evidence/<sessionKeyDigest>.json     # 唯一落点
```

| 项 | 决定 |
| --- | --- |
| 位置 | **只写本机**（`<local-state>`）。本期**不写共享侧的 `chainfork/`** |
| 权限 | 无（本机私有目录） |
| 内容 | `{detectedAt, sessionKeyDigest, archivalGroup, candidates:[{file, generation, manifestSha256, producer.hostId, updatedAt}], reason:"chain-fork", predicate:"d2"}`（本项在 §5.4.4 的 D/d2 层） |
| 写失败 | 只记本地日志；**结论不变**（仍是 `chain-fork`） |

**为什么本期只落本地**：写共享侧需要一个"诊断写例外"——它在 `¬OW` 时也要能写，
而 `¬OW` 的全部意义就是"不写共享字节"（§5.6.3 R5）。两者只能留一个。本期选**本地**，
因为①分叉在当前单名空间下不可达（§5.4.4 d2 的说明），证据是罕见排障物而不是常规产物；
②留一个"在特定条件下可以绕过 owner 闸门写共享"的例外，会把刚刚唯一化的裁决顺序重新打开。
**将来若要共享诊断，必须单独定义授权条件（谁能写、写在哪、与 `OW` 的关系）并单独评审**，
不能靠"顺便也写一份"混进来。

### 5.7 本地待上传队列：按请求保存、稳定 requestId、上限、退避

**位置**：`<local-state>/archive-queue/<requestId[0:2]>/<requestId>.json`（**本地，不进共享**）。

**`requestId` 的规范（冻结）**：

```text
requestId = sha256hex(canonicalBytes({
  schemaVersion: 1,
  sessionKey: {provider, sessionId},
  archivalGroup: {repoId, itemType, number} | null,
  sourceHostId: <产出这份字节的 host>,
  sources: [ {kind, sha256, bytes} ... ]        # 按 (kind, sha256) 升序
}))
```

三处刻意的设计：

- **不含时间戳、不含 attempt 号**——否则重放会算出不同 id，幂等失效；
- **含 `sourceHostId`**——它让"**同一 host 的重试**"算出同一个 id（真幂等），
  同时让"**另一台 host** 采同一份字节"算出**不同的 id**。后者在第一阶段不会被提交：
  非 owner 在 §5.6.3 的 `R5`/`OW` 处被拒，返回 `already-archived` 或 `session-claimed-elsewhere`（§5.4.2 W-2），
  **不产生第 2 行 attempt**。所以"一 session 一行 attempt per 请求"与单写者口径是一致的；
  `sourceHostId` 在这里的作用是**区分"同一写者的重试"与"另一个写者的重复采集"**，
  而不是为了给后者留一行记录（上一版把它写成"两台 host 各一行 attempt"，与 W-2 冲突，已删）。

| 字段 | 类型 | 必填 | 含义 | 默认 |
| --- | --- | --- | --- | --- |
| `queueVersion` | int | 必填 | 本期 `1` | 无 |
| `requestId` | hex64 | 必填 | 见上；必须等于文件名 | 无 |
| `sourceHostId` | string | 必填 | 产出字节的 host（与 requestId 一致） | 无 |
| `submittedSeq` | int ≥ 1 | 必填 | 该 session 在本机的提交序号；**同一 session 的请求按此升序串行提交** | 无 |
| `sessionKey` / `sessionKeyDigest` | object / hex64 | 必填 | 后者必须等于共享侧目录名 | 无 |
| `archivalGroup` | object \| null | 必填 | 决定写入哪个域 | 无 |
| `state` | `pending \| blob_published \| manifest_published \| confirmed \| superseded \| failed_terminal` | 必填 | 与 §5.6.3 动作表对齐 | `pending` |
| `items` | array | 必填 | `[{kind, origin, localPath, sha256, bytes, truncated, prefixBytes}]` | 无 |
| `retry` | `{count, nextAt, lastCode}` | 必填 | `count` 从 0 起 | `{0, now, ""}` |
| `fence` / `attempt` / `generation` | int \| null | 必填 | **读到链时填写**；`fence` 只是归因属性（§4.1） | `null` |
| `publishedGeneration` | int \| null | 必填 | `link` 成功后写入：我发布到了哪一代；仅用于 `manifest_published ∧ ¬R` 的恢复定位 | `null` |
| `publishedManifestSha256` | hex64 \| null | 必填 | `link` 成功后写入：该世代文件字节的摘要；与收据里的值必须相等 | `null` |
| `confirmedManifestSha256` | hex64 \| null | 必填 | 收据里的 `manifestSha256`；**非 `null` 才允许解除保护引用** | `null` |
| `supersededBy` | hex64 \| null | 必填 | 只有 `state=superseded` 时非 `null`：覆盖它的那个 `requestId` | `null` |
| `leaseToken` | string \| null | 选填 | 本机持有租约时的令牌 | `null` |

**`superseded` 的完整语义**（本轮 M5 要求把它纳入枚举/恢复/GC）：

| 面 | 规则 |
| --- | --- |
| 何时产生 | 同一 session、同一 `sourceHostId`、同一 `archivalGroup` 的两个请求，后者的 `sources` 的 `(kind, sha256)` 集合是前者的**真超集**，且前者尚未提交成功 |
| 落盘 | 前者 `state=superseded`、`supersededBy=<后者 requestId>`；**条目与保护引用都不删除**（审计需要） |
| 提交 | **不提交**：`superseded` 的请求永远不会产生 attempt（否则链上会有一行被超集覆盖的无效 attempt） |
| 恢复表 | 落在"终态，不处理"行（§5.6.3） |
| GC 语义 | **视为已解决**：G5 只要求"没有非终态条目"，`superseded` 是终态，因此不阻塞 GC；前提是 `supersededBy` 的条目已 `confirmed`（否则 G5 仍被那条挡住） |
| 保护引用 | 由 `supersededBy` 的请求继续持保护；前者解除保护时必须确认后者已持保护（同一时刻至少一条保护存在） |

**同一 session 的串行提交**：按 `submittedSeq` 升序处理；不满足超集关系的两个请求各自提交、各占一行 attempt。

**写入**：临时名 + `fsync` + `rename` + `fsync(dir)`。**不选 JSONL 追加**——队列状态是可变的
（`state`/`retry.count`/`fence`），JSONL 会把"更新"变成"追加补丁"，重放补丁正是崩溃后
最容易出分歧的地方。JSONL 适合只追加的事件流（`orca/src/shared/agent-hook-spool.ts:53-97`、`:143-163`
为此付出了处理残缺末行、原位重写未读尾部、保 inode 的代价）；选了单文件 JSON，这些复杂度一个都不用付。

**上限**：`MAX_PENDING_ARCHIVES`（建议 128，含终态但未清理的条目）。达到上限**拒绝新归档并明确报错**，
不静默丢弃。先例：`orca/src/main/artifacts/artifact-create-intent-store.ts:221-224`（超过 32 个即抛
"Too many artifact creates are waiting for recovery"）。

**退避**：`delay = min(base × 2^count, cap)`，`base=60s`，`cap=30min`，±20% 抖动。
`nextAt` 落盘，进程重启后沿用——否则崩溃会重置退避，把一次共享存储抖动放大成重试风暴。

**失败分类**，判据形状照搬 `orca/src/main/artifacts/artifact-publisher.ts:43-50`：

| 类别 | 例子 | 处理 |
| --- | --- | --- |
| 可重试 | 共享存储不可达、超时、`EAGAIN`、暂时 `EACCES` | `count += 1`，按 `nextAt` 再试 |
| 可重试但不计数 | `lease-busy`、`lease-indeterminate` | 保持 `count`，只推迟 `nextAt` |
| 终止 | `chain-fork`、`chain-broken`、`manifest-unusable`、`blob-corrupt`、`manifest-regression`、`blob-publish-unsupported`、`fence-unsupported`、`fsync-unsupported`、`queue-entry-corrupt` | `failed_terminal`，保留全部本地物与保护引用，等人工（`manifest-unusable` 的 `detail.reason` 携带读侧码） |

`lease-busy` 不递增计数是刻意的：另一台主机正常持有租约不该消耗本机重试预算。
同类"忙碌不是失败"的表达在 `swarm/coordinator_io.py:323-324`（`LockBusy` 单列成子类）。

### 5.8 三种字节来源与它们的可靠性顺序

| `origin` | 来源 | 可否在释放后取得 | 完整性 |
| --- | --- | --- | --- |
| `provider_dir` | provider 自己的 session 目录 | 可以（provider 不因工作区删除而删） | 会话已结束时最完整 |
| `daemon_checkpoint` | `<root>/<encodeURIComponent(sessionId)>/` 的 `checkpoint.json`/`output.log` | **不可以**：`removeSession` 立即删（`orca/src/main/daemon/history-manager.ts:274-283`） | 取决于 checkpoint 时机（≥5s 或 5 MiB） |
| `renderer_snapshot` | daemon 之外的渲染侧快照 | **不可以**：ref 消失即删（`orca/src/main/persistence/loading-store/terminal-session-cleanup.ts:35-38`） | 只覆盖渲染过的内容 |

采集优先级：`provider_dir` → `daemon_checkpoint` → `renderer_snapshot`。前两者可得时不做后者，
因为它们的存活时间更长。三种来源都拿不到时，不静默省略，记 `gaps`。

### 5.9 保护引用：谁建、什么时候建、谁必须读它

**问题（本轮 M8 指出的仍不闭合之处）**：上一版说"任何会让字节不可取得的动作之前必须已落盘保护引用"，
却又规定保护在"归档意图产生时"写入。而 `renderer_snapshot` 的删除由 **ref 差集**驱动
（`orca/src/main/persistence/loading-store/terminal-session-cleanup.ts:35-38`，调用点
`orca/src/main/persistence/loading-store/workspace-session-snapshot-publication.ts:104`），它与"归档意图"完全没有关系：
一个会话可能从未被归档过，它的快照也会在 ref 变化时被删。**所以保护不能等意图。**

**契约 P0–P6：**

| 编号 | 规则 |
| --- | --- |
| **P0** | 保护引用在**首次产生可归档字节时**建立：`daemon_checkpoint` 的首个 checkpoint 落盘、或 `renderer_snapshot` 的首次快照写入、或 provider transcript 首次被观察到。**由该 session 的 daemon/窗口服务创建**（它们正是会产生这些字节的地方），不是由 collector 创建 |
| P1 | 归档流程进入 S0 时只**续期/确认**已有保护；若不存在则补建（例如老会话升级后首次归档） |
| P2 | **三类删除路径都必须读它**：① `deleteRemovedTerminalScrollbackSnapshots` 的 ref 差集删除；② daemon `removeSession`/墓碑；③ worktree 拆除。受保护即**删除被挡住**（不是"删了再报"） |
| P3 | 保护只由 §5.10 的 `archiveConfirmed`（或显式放弃归档并经二次确认）解除 |
| P4 | 保护引用自身损坏 → **拒绝删除**（`session-mapping-unreadable`），不得当作"没有保护" |
| P5 | 保护写入失败 → **拒绝开始归档**（不能承诺一件自己保护不了的事） |
| P6 | `expiresAt` 过期**不自动解除**，只报警；长会话的保护必须由心跳续期 |

```text
<local-state>/archive-protect/<sessionKeyDigest>.json
{ protectVersion: 1, sessionKey, sessionKeyDigest, worktreeId,
  createdAt, renewedAt, expiresAt, createdBy: "daemon" | "window" | "collector",
  sources: [{kind, origin, localPath, bytes, sha256}],   # 允许 sha256 为 null（尚未采集）
  requestIds: [hex64, ...] }
```

**"此前已丢字节"不是保护失败的替代品**（本轮 M8 的措辞要求）：如果某段字节在 P0 生效之前就已丢失
（例如从老版本升级而来、P0 尚未上线时的历史窗口），那么在 manifest 里记
`gaps: {code: "scrollback_evicted_before_archive", severity: "blocking"}` 并把 `completeness` 压到
`partial`。**这条只允许用于降级，不允许用来替代"保留验收"**——`partial` 是"我们承认缺"，
不是"所以不必保留"。

### 5.10 确认前不删本地，不 GC 对应 scrollback

```text
archiveConfirmed(requestId) :=
    Q0(条目) ∧ state == confirmed
  ∧ R(收据存在且可校验：收据的 manifestSha256 所指文件存在、字节摘要相符)
  ∧ 该世代在**当前链上**（从唯一 tip 沿 predecessor 回溯到 g1 可达）
  ∧ 该世代的 attempts[] 中存在 requestId 匹配的行，其全部 sources[] 满足 B0∧B1∧B2

sessionArchived(sessionKey) := 该 session 的全部请求都处于终态（confirmed / superseded），
                               且每个 confirmed 请求都 archiveConfirmed，且保护引用已解除

worktreeArchived(worktreeId) :=
    session 集合可完整枚举（读不到 → false，不是"没有 session"）
  ∧ 对每个 session：sessionArchived(session)
```

**关键改动（本轮 M2）**：确认不再要求"收据等于**最新** head 的摘要"。第二个请求推进链之后，
第一个请求的收据必然不等于最新世代——上一版的写法会让**所有**已确认请求在一夜之间失效。
现在判据是**"不可变提交收据 + 链上包含关系"**：收据自证它提交了哪一代，链证明那一代还在链上。
这正是"已提交的内容不因后续追加而失效"的可判定形式。

| 判据 | 内容 | 不成立时 |
| --- | --- | --- |
| G1 | `<archive-root>` 可达且能列出目标域 | 拒绝 GC，`unavailable` |
| G2 | 该 worktree 的 session 集合**可枚举**（含保护引用） | 拒绝 GC，`session-mapping-unreadable` |
| G3 | 每个 session 的 `TS` 为 `UNIQUE`（唯一 tip 且链闭合） | 拒绝 GC，报 `chain-fork`/`chain-broken`/`manifest-unusable` |
| G4 | 每个 confirmed 请求的全部 `sources[]` 满足 B0∧B1∧B2 | 拒绝 GC，报 `blob-missing`/`blob-truncated`/`blob-corrupt` |
| G5 | 本地队列中该 worktree 的所有条目均为**终态**（`confirmed`/`superseded`），无 `pending`/`blob_published`/`manifest_published`/`failed_terminal` | 拒绝 GC，`archive-pending`；`superseded` **不阻塞**（§5.7） |

**G1/G2 的失败一律是"拒绝执行"，不是"视为没有"。** 这条纪律仓库里已有非常明确的实现：
`orca/src/main/terminal-history-gc.ts:159-162` 在活跃集合为空时**跳过整轮 GC**，注释写明理由——
"空集合看起来与'用户真的没有 worktree'无法区分……拒绝不花钱，而这是可恢复的错误负载与
每个 worktree 的 shell history 被删光之间的区别"。

**第一期不删 provider transcript**：那是 provider 的资产，本协议只读。
需要保护的是（a）`daemon_checkpoint` 与 `renderer_snapshot`，（b）队列条目与收据。

**GC 前先写一条删除意图记录**（worktreeId、session 列表、每项确认时的收据摘要），再执行删除；
中途崩溃则下一轮先处理意图记录。同构于墓碑两阶段删除
（`orca/src/main/terminal-history-deletion.ts:137`、`:158`）。

### 5.11 只归档已结束的会话："已结束"的三个机器条件

本期只归档已结束会话（issue 第 6 项），"已结束"定义为三个条件的**合取**，且每个条件都要写进
`attempts[].endEvidence`：

| 条件 | 正面证据 | 不可接受的替代 |
| --- | --- | --- |
| ① provider 进程已退出 | 拥有该进程的宿主机报告的退出事实（`kind: "process_exit"`） | "看不见它了"——传输失败不能产生"已退出"（`orca/docs/reference/ssh-execution-boundary.md:14`） |
| ② transcript 不再增长 | 观察窗口内 `mtime` 与 `size` 不变（`kind: "stable_window"`，含窗口长度） | 单次观察（可能是两次写的间隙） |
| ③ Orca 侧 terminal 会话已释放 | `closeSession` 已回填 `endedAt`（`orca/src/main/daemon/history-manager.ts:257-272`）或该 handle 已不在活集合 | "没有活终端"——那与"从未有过"不可分 |

**这三个条件只影响 `lifecycle`，不影响 `completeness`**（§4.9）。三个都成立才 `sealed`；
只有 ①② 成立时是 `complete + open`（数据已齐、生命周期未终结）——这是合法状态，不是缺数据。

代价必须写清：**崩溃/断电的会话永远无法归档**（除非将来做显式"快照"）。换来的是
"manifest 指向的 blob 一定是完整文件"这一可验收性质。

---

### 5.12 后续切片草案：多写者接管（**不在第一阶段契约内**）

本节是**草案**，不是第一阶段契约的一部分，也不构成任何实现前提。写在这里有两个目的：
① 把已经推演过的机制留在原地，避免下一个切片从零开始；② 把**反例**留下来，作为"开启它必须先具备什么"
的前置证据。**第一阶段不得引用本节的任何机制作为正确性依据。**

**前置条件（缺少任何一条就不该开这个切片）**：存储侧条件写——对象存储条件 PUT / `If-None-Match: *`、
数据库行锁（`SELECT … FOR UPDATE`）、或带 version 的 CAS。理由：纯 POSIX 文件协议里，
"我是不是唯一的后继"在写入时刻不可知（§5.4.1 的推演）。

**待解决的三个反例（都是被审查确认成立的）**：

| # | 反例 | 为什么第一阶段不需要解决 | 开启本切片必须先证明什么 |
| --- | --- | --- | --- |
| D-1 | 两个 host 都看到"无租约"，各自 `O_EXCL` 建**不同编号**的 fence 都成功，随后都写租约、都发布 ⇒ 双 tip | 第一阶段第二个写者根本不发布（W-2），所以这个交错不可达 | 领取必须在**固定名字**上独占，而不是在编号上独占 |
| D-2 | 固定 claim 也有洞：B 先做步骤 1/2（看到无租约、无 claim）后暂停；A 完成领取、写租约、删 claim；B 恢复执行步骤 3，`O_EXCL` 成功 ⇒ **B 拿到 claim 却不重读租约**，A/B 同时进入写 | 同上 | **成功持 claim 之后必须重检有效租约**，且领取/继承/释放共用同一互斥边界；不能把锁外旧读当锁内许可 |
| D-3 | 释放凭据可被重复消费：A/B 都读到旧 `claim.released`，A 删旧 claim 并建自己的，B 延迟 `unlink` 会删掉 A 的新 claim | 同上 | 释放必须是**条件删除**（可证明无 ABA），或单一清理者 |

**草案机制（照抄自 r4 版本，仅供后续切片起手）**：
`leases/<digest>.claim`（固定名，O_EXCL = 唯一领取权）→ 拿到 claim 后才 `readdir` 分配 fence →
写租约 → 删自己的 claim；`fences/<digest>/<NNNNNN>`（永不删除、永不复用）与
`<NNNNNN>.released`（只能由持有者所在 host 写，`releasedByHost == claim.hostId` 否则视为不存在）；
claim 的四种半成品（无 fence / 有 fence 未生效 / 租约已写 claim 残留 / 有合法 released）
各有唯一可恢复者；同机继承也必须走 claim；人工释放必须同时证明"进程已停"与"在途写已排空"
并记 `lastObservedGeneration`。

**本切片明确不做的**：把 fence 塞回文件名（那会让同一代有两个可用名字，正是 D-1 的温床，
见 §4.1 的说明）。


## 6. 读取语义

本节同样是**待实现的契约**。下面每一类状态码、每一条 `绝不`，都是实现完成后可以用
负例断言的东西；本文不声称其中任何一条已在运行。

### 6.1 为什么"本地优先"是正确性要求

本地 provider 会话文件是**唯一权威源**，共享 blob 只是它的字节副本。任何"从共享侧读到的东西覆盖本地"
都把副本提升成权威，后续归档会产出第二份不同内容的 blob。读路径复用既有"派生可重建、丢了不损失事实"
的性质（`orca/src/main/ai-vault-search/session-search-database-path.ts:5-12`），而不是新增第二个权威。

### 6.2 解析顺序（每步失败即返回状态，不继续）

| 步 | 动作 | 成功 | 失败 → 状态 |
| --- | --- | --- | --- |
| 0 | 解析寻址键 `(archivalGroup, worktreeId, sessionId)` | key | `identity-incomplete` |
| 1 | 本地 provider 会话文件存在且可读？ | 直接返回，`source:'local'` | 不存在**不算失败**，进 2 |
| 2 | 读**本地索引快照**（§6.7）。**索引缺失/过期 → 直接进 4**，不得进入需要期望 hash 的步骤 | 期望 `sha256`/`bytes`/来源集合 | 索引问题不是读失败：进 4 |
| 3 | 用期望 `sha256` 查 `<local-cache>` 并**校验**（§6.7） | `source:'cache'` | 未命中/校验失败 → 进 4 |
| 4 | 读共享 manifest：按 §5.4.4 的 **A→B→C→D** 判定 `TS` | `manifest` | `TS ∈ {parse-error, schema-invalid, version-unsupported, chain-broken, chain-fork}` 时按 §6.4 出码；**`GENESIS` 与内部观察 `manifest-missing` 不在此处终结，转入 §6.5** |
| 5 | 本机 cache 无该 blob → 拉取到 **staging** | staging 文件 | `blob-missing` / `blob-expired` / `permission-denied` / `unreachable` / `offline` |
| 6 | 校验 staging 摘要 == manifest 的 `sha256` **且长度 == `bytes`** | cache 条目 | `hash-mismatch` 或 `blob-truncated`（丢 staging、丢旧 cache 条目、**重拉一次**；再失败即返回） |
| 7 | 计算响应头（`source:'archive'`、`executionHostId`、`presence`、`cwdResolution`） | results | — |
| 8 | 以上任一失败 | — | `unavailable/<reason>`，**不返回任何内容字段** |

四处必须与状态表一致：

- **第 2 步失败要"进 4"而不是"报错"**，但更关键的是**不能进 3**：期望 hash 正是索引提供的（M6）。
- **第 4 步不自己做判断。** 它只调 §5.4.4 的判定表并拿到 `TS`，再由 §6.4 出码；
  这样重算（§5.6.3）与读侧用的是**同一张表**。
- **`manifest-missing` 是内部观察，不是对外码**（§6.3）。它只用于把控制流交给 §6.5。
- **第 4 步的 `GENESIS` / `manifest-missing` 是"转交"而不是"失败"。** 它们直接进 §6.5 的本机/全局分支，
  否则 B13 要求的 `archive-status-unknown` 在整个读路径上**没有入口**（本轮 M7）。
- **第 6 步比长度**，这样 `blob-truncated` 可达。

**先校验后暴露**是本节唯一硬规则：写入 cache 必须经"staging + 校验 + 一次性暴露"，
形状与 `swarm/coordinator_io.py:264-276` 的 `publish_new` 同源。读侧不能直接复用它（它拒绝覆盖），
但必须复用这个形状。**一次读取 = 一次状态**：禁止"先返回空 body 稍后补"。

### 6.3 响应形状与唯一词表（**17 个读侧码**）

```text
成功：{ kind: 'results', source: 'local' | 'cache' | 'archive',
        executionHostId, sessionKey, headGeneration, headFence, blobSha256,
        bytes, presence, cwdResolution?, tokens? }

失败：{ kind: 'unavailable', reason: <下表 17 个之一>, retryable, scope?, detail? }
```

`presence` 三态：`present` / `unverifiable` / `missing`。**`missing` 只能由"共享侧明确回答该键不存在"
得出**；只要本次读取没到达共享侧，就只能是 `unverifiable`。

词表基线是既有的 host outcome 枚举（`orca/src/shared/ai-vault-search-contract.ts:83-94`）与
`unavailable` + `reason` 判别（`orca/src/shared/ai-vault-search-contract.ts:124-129`）；
归档侧只**新增**枚举值，不改既有语义。

**读侧码（唯一词表，恰好 17 个；`kind: 'unavailable'` 时只能取其中之一）**

| # | 码 | 判据 | `retryable` |
| --- | --- | --- | --- |
| 1 | `identity-incomplete` | 寻址键缺项（`sessionId` 为空等） | false |
| 2 | `offline` | 共享根探测失败且宿主无连接 | true |
| 3 | `unreachable` | `EIO`/`ESTALE`/`ETIMEDOUT` 或超时预算耗尽 | true |
| 4 | `permission-denied` | `EACCES`/`EPERM`（读或列目录） | false |
| 5 | `parse-error` | 某世代字节不是合法 JSON（含重复键、`NaN`） | false |
| 6 | `schema-invalid` | JSON 合法但 `kind` 不符或 R2/R4–R7/R9 失败（§5.4.4 b2/b4） | false |
| 7 | `version-unsupported` | `kind` 对但 **`schemaVersion != 1`**（含 0、负数、>1、非 int；§5.4.4 b3 = R1 的否定形式） | false |
| 8 | `chain-broken` | 某候选的 `predecessor` 指向不存在的文件或摘要不符（R8，§5.4.4 d1） | false |
| 9 | `chain-fork` | 两条 tip，或两个世代声明同一 `predecessor`（§5.4.4 d2） | false |
| 10 | `alias-cycle` | 别名指向别名，或别名目标不存在（R10） | false |
| 11 | `hash-mismatch` | 重算摘要 ≠ manifest 的 `sha256` | false |
| 12 | `blob-truncated` | 长度 ≠ `sources[].bytes` | false |
| 13 | `blob-missing` | `blobs/<sha256>` 返回 `ENOENT` | false |
| 14 | `blob-expired` | 保留期到期且 head 上明确标注（§7.3） | false |
| 15 | `not-archived-local` | **仅本机范围**："本机没有该会话的归档记录"（§6.5） | false |
| 16 | `archive-pending` | 本机队列有非终态请求，或保护引用仍在 | true |
| 17 | `archive-status-unknown` | **缺全局证据**，无法判定该会话是否曾被归档（§6.5） | true |

**`manifest-missing` 不是对外码，是内部观察。** §6.2 第 4 步遇到"该域可列出但没有这个 session"
时产生这个观察，随后**必须**转 §6.5；对外只会是 `not-archived-local`（带 `scope:'local'`）或
`archive-status-unknown`。上一版把它列进对外词表并要求 B8 逐码断言，造成一个**不可达的对外码**
（r5 指出的矛盾）。

**写侧码（只出现在归档动作返回值里，不进入读侧 `unavailable`）**

`read-only`、`lease-busy`、`lease-indeterminate`、`fence-unsupported`、`fsync-unsupported`、
`session-claimed-elsewhere`、`already-archived`、
`blob-publish-unsupported`、`blob-corrupt`、`manifest-conflict`、`manifest-regression`、
`manifest-unusable`、`queue-entry-corrupt`、`archive-quota-exceeded`、`session-mapping-unreadable`、
`resume-conflict`、`superseded`。

三个码是**读写共享的观察码**（事实不分读写侧）：`chain-fork`、`chain-broken`、`blob-truncated`。

写侧遇到"tip 不可用"一律报 `manifest-unusable`，并把具体读侧码放在 `detail.reason`（`parse-error` /
`schema-invalid` / `version-unsupported` / `bad-blob-ref`）。**这样写侧永远不会把读侧码当自己的状态码用**，
两边词汇表各自封闭（本轮 M7 的要求）。

**两类分开的理由**：读侧只可能返回 `results` 或上述 17 个码之一；写侧的失败码不参与读侧断言。
上一版把 `read-only` 塞进读侧表，导致验收 B8 要求"所有读侧场景都返回 `unavailable`"时，
不得不把"只读下的正常读取（`results`）"也算进去，自相矛盾（本轮 M7）。
`identity-incomplete` 上一版只出现在别处、不在表里，已补齐；`manifest-missing` 则从对外表里**移出**，降为内部观察（见上）。

### 6.4 读侧状态的判定（唯一入口：§5.4.4 的 A→B→C→D 表）

| 场景 | 结果 | 机器判据 | 绝不 |
| --- | --- | --- | --- |
| 本地有 | `results`（`source:'local'`） | 本地文件可读 | 不与 cache/archive 混用 |
| cache 命中且校验通过 | `results`（`source:'cache'`） | §6.7 判定通过 | 不在校验通过前返回字节 |
| 共享读成功 | `results`（`source:'archive'`） | `TS==UNIQUE` 且步骤 5–7 通过 | 不返回部分内容 |
| 共享只读 | `results`（正常读） | 只读不影响读路径 | **只读不是读失败**（写侧才是） |
| 离线 / 不可达 | `offline` / `unreachable` | 见 §6.3 | 不折叠成 `blob-missing`；不显示空正文 |
| 摘要或长度不符 | `hash-mismatch` / `blob-truncated` | 见 §6.3 | 不以 manifest 为准继续渲染；不写 cache |
| 候选解析失败（最高代） | `parse-error` / `version-unsupported` / `schema-invalid` | §5.4.4 **B** 阶段 + C1 的最高代策略 | 不猜字段；三者不互相顶替；**不被更低的完好世代掩盖** |
| 链断 | `chain-broken` | §5.4.4 **d1**（优先于 d2） | 不选边；**不退回旧代**（旧代只能 `--at-generation`，带 `diagnostic:true`） |
| 分叉 | `chain-fork` | §5.4.4 **d2**（两个候选都各自完整回溯到 g1） | 不选边；证据写不进去也不改变结论（§5.6.4） |
| 该域没有该 session（内部 `manifest-missing`）/ 无任何世代文件（`GENESIS`） | **转入 §6.5**（`not-archived-local` 或 `archive-status-unknown`） | §6.5 的四个条件 | 不在此直接下"从未归档"结论；`manifest-missing` 不出现在对外响应 |
| blob 缺失 / 过期 | `blob-missing` / `blob-expired` | 见 §6.3 | 不回退到本地空内容；不删 manifest |
| 权限不足 | `permission-denied` | `EACCES`/`EPERM` | **绝不与 `ENOENT` 合并** |
| 跨主机无法判定 | `archive-status-unknown` | §6.5 | 不声称"从未归档" |

**唯一的判定入口（本轮 M7 的核心修正）**：读侧不再自己拼"tip 集合"，而是**只调 §5.4.4 那张 A→B→C→D 表**，
再把结果映射到本表的行。三件事因此变成可判定的：

1. **同一输入只有一个结果**：`chain-broken`（d1）优先于 `chain-fork`（d2）。
   审查给的反例（"保留合法 g1、把 g2 的前驱改指不存在文件"）因此唯一地得出 `chain-broken`，不是两种。
2. **`version-unsupported` 只针对候选自己**（B2），不再与 R3"忽略未知字段"矛盾。
3. **"缺 manifest"不是读失败，是空态**：它进入 §6.5，而 §6.5 的两个可能结果
   （`not-archived-local` / `archive-status-unknown`）是本机与全局的区分问题，不是错误码选择问题。

**"坏/高版本最高代"的显式错误策略（冻结）**：永远不因为最高代坏了就退回旧代（§5.4.4 C1 + 本表第一行）。
理由：退回旧代会让一次损坏/升级变成"看起来正常但内容过期"的读取，而这正是最难被发现的一类错误。
要读旧代只能走**显式诊断模式**（`--at-generation <N>`），且响应必须标注 `diagnostic: true` 与外层
`headUnreadable: <code>`。

`permission-denied` 这条有直接教训：`orca/src/main/ai-vault-search/session-search-degraded-roots.ts:18-24`
记录的问题是——`EACCES` 的根与"从未安装的 agent"都以 "no files" 到达，
把前者报成空索引就是把失去联系当成不存在。

### 6.5 四种空态：本机范围与全局范围必须分开说

**本节是"没有可读 head"的唯一出口。** §6.2 第 4 步拿到 `GENESIS`（没有任何世代文件）或
`manifest-missing`（该域可列出但无此 session）时**不直接出错误码**，而是进入本节：
先在"本机无记录 / 归档未完成"之间判，判不了再降级为"跨主机无法判定"。
这条入口是本轮 M7 补的——上一版把这两个情形当成第 4 步的失败直接退出，
于是 `archive-status-unknown` 虽然在词表里，却在整个读路径上不可达，B13 也就无从判定。


| 空态 | 判据 | 用户看到 | reason |
| --- | --- | --- | --- |
| **本机**无记录 | 该域可列出且无该 `sessionKeyDigest`；本机队列无该 session 的请求；本机保护引用无该 session；本机意图日志显示从未触发 | "**本机**没有该会话的归档记录" | `not-archived-local` |
| 归档未完成 | 本机队列有非终态条目，或保护引用仍在 | "归档尚未完成" | `archive-pending` |
| 有归档但此刻不可达 | tip 命中，拉 blob 或读 manifest 失败 | "归档存在，当前不可达" | §6.3 之一 |
| **跨主机状态无法判定** | 本机证据全为空，且**无法取得"别的 host 是否曾为它排过队"的全局证据** | "本机没有该会话的归档记录；**另一台机器上是否已归档，在此无法确认**" | `archive-status-unknown` |

**本轮 M10 的修正（关键）**：`not-archived-local` 的语义被**严格限定在本机范围**，
它**不能**被用来得出全局结论"该会话从未归档"。原因很具体：A 主机离线 pending 时，
B 主机的队列正是空的、共享侧也还没有 manifest——B 完全满足"本机四条证据"，但真实状态是
"另一台机器上有待上传请求"。

因此：

- 任何面向"这个 session 历史上到底归档过没有"的结论，在**没有全局证据**时只能是
  `archive-status-unknown`（`presence: unverifiable`）；
- `not-archived-local` 的响应必须带 `scope: 'local'`，且 UI 文案必须出现"本机"二字；
- 想要全局精确区分，只能再引入共享侧的"请求状态"对象（`requests/<requestId>.json`），
  那会把私有性从"只放 blob+manifest"扩展到"放请求元数据"，属 §7.7 第 3 条的 owner 决策。
  **在此之前，"不知道"必须能说出来。**

### 6.6 实现约束（可写成断言）

| 编号 | 约束 |
| --- | --- |
| C1 | `kind:'results'` 的正文允许 0 字节：必须带 `bytes: 0` 且 `blobSha256` 指向真实空字节串的摘要。**0 字节 ≠ 缺失** |
| C2 | `kind:'unavailable'` 携带内容字段在类型上不可能（判别联合互斥字段） |
| C3 | 统计字段在不可达时为 `null`，不是 `0` |
| C4 | 命中 reason 后不再尝试更宽松的解析路径（禁止 fallback 到空内容、也禁止退回旧世代） |
| C5 | 一个 reason 只对应一个文案常量；同一码在不同调用点说不同的话是可判定缺陷 |
| C6 | 每条状态必须带 `retryable`，否则 UI 无法区分"点重试"与"找人" |
| C7 | 跨网络传输不得带回宿主路径与原始 errno，只给固定句 |
| C8 | `not-archived-local` 必须带 `scope:'local'` 且文案含"本机"；不得据此给出全局结论 |
| C9 | 读侧的 `reason` 只能取 §6.3 的 17 个码之一；新增码必须先改表再改实现。**内部观察（如 `manifest-missing`）不得出现在对外响应里** |

C3 在仓库里已是硬规则（`swarm/docs/design/delivery-ledger.md:95`：`unknown`/`false`/`true` 三态分离）。
C7 的先例是 `degradedRoots` 在 relay 与 paired client 上被替换为固定文案
（`orca/docs/reference/agent-session-search-contract.md:99-105`）。

### 6.7 本地 cache 与索引快照：完整性协议

| 项 | 决定 |
| --- | --- |
| 内容目录 | `<local-cache>/agent-session-archive/blobs/<sha256[0:2]>/<sha256>` |
| 校验记录 | 同目录 `<sha256>.verified.json`：`{size, sha256, dev, ino, mtimeNs, ctimeNs, verifiedAt, sourceHostId}` |
| 命中判定 | ①`verified.json` 的 `(dev, ino, size, mtimeNs, ctimeNs)` 与当前 `lstat` 完全相等；②该身份的戳已"沉着"（比 `verifiedAt` 早满 1 秒）。两条都成立才信任；**否则全量重算摘要** |
| 为何等长损坏也能抓到 | 同长度原地重写会移动 `st_ctime_ns`，`os.utime` 能恢复 `mtime` 但恢复不了 `ctime`（`swarm/coordinator_io.py:63-66` 记录了这条实测结论）；身份元组的定义在 `:118-124` |
| 失效 | 摘要不符 → 删 cache 条目 → **重拉一次** → 仍失败返回 `hash-mismatch` |
| 清理 | LRU + 字节上限；**可随时全删**（全删后行为等同新 host，这本身是可测断言） |
| 并发 | 同 `<sha256>` 并发拉取：临时名 + rename（谁先到谁赢），不用锁文件 |
| 权限 | 目录 `0700`、条目 `0600`（本机私有） |

**本地索引快照（§6.2 第 2 步的输入）——本轮 M6 的三处修正：**

```text
<local-cache>/agent-session-archive/index/<domainKeyHash>.json
{ indexVersion: 1, builtAt, archivalGroup,
  entries: {
    <sessionKeyDigest>: {
      head: { hostId, generation, fence, manifestSha256 },   # 该 session 的 tip 身份
      sources: [                                             # **列表**，不是单个 blob
        { kind, sha256, bytes, origin, sourceHostId, generation }
      ]
    }
  } }
```

| 修正 | 内容 |
| --- | --- |
| ① 索引缺失不得进入需要期望 hash 的步骤 | 见 §6.2 第 2 步：索引问题直接进 4（读共享），绝不进 3 |
| ② 每 session 保存 **head 身份 + source 列表** | 上一版每 session 只有一个 `blobSha256`，无法表达 transcript + scrollback 两个 source、更无法表达多 attempt 的多个来源。现在 `sources[]` 是列表，每项带 `kind`/`origin`/`sourceHostId`/`generation` |
| ③ **没有"域级 tip"，新鲜度逐 session 判定** | 见下 |

**为什么删掉"域级 tip"（本轮 M6 的实质）**：域内每个 session 各有**自己的一条链**，
不存在一个"域的 tip"这种东西——上一版在索引顶层放了一个 `tip: {…}` 并拿它做在线新鲜度校验，
那是一个**未被任何协议定义的根对象**：任一其他 session 推进世代后，比对这一个 tip 既不能证明
本 session 的索引新鲜，也不能否定它。现在顶层只有 `entries`，**每个 session 的 `head` 就是它自己的权威引用**。

**新鲜度口径（逐 session，且必须能离线判定）**：

| 模式 | 判定（只针对**目标 session** `d`） | 说明 |
| --- | --- | --- |
| 在线 | 对该 session 的 `manifests/<d>/` **完整重跑 §5.4.4 的 A→B→C→D**（含逐候选解析与前驱回溯），得到 `TS` 与 `head`；要求 `TS==UNIQUE` 且 `head.manifestSha256` 等于 `entries[d].head.manifestSha256` | 成本是**该 session 全部世代文件的一次读+摘要**。**没有“只读 head、不读其它世代”的捷径**：不逐候选过候选错误门、也不回溯前驱，就无法排除“更高的世代坏了”或“链断了”，而这两者都必须让结论 fail closed（§5.4.4）。成本随**该会话的世代数**线性增长，不随域内会话数增长 |
| 离线 | `entries[d].head.manifestSha256` 所指的**本地缓存副本**存在且 `verified.json` 命中（§6.7 上表），且 `indexVersion` 受支持 | "以本地证据为准"，不依赖时间、也不依赖共享侧可达 |
| 索引里没有 `d` | 视为"本机没有该 session 的索引条目" → 进 §6.2 第 4 步 | 不是 `parse-error`；也不能凭空猜 hash |
| 以上都不满足 | 索引条目作废（标记 `stale` 待重建），**进 §6.2 第 4 步** | 绝不"凑合用旧索引" |

它**只是派生索引**：可随时删除并重建。重建粒度是**一个 session**（读该 session 的 manifest 目录即可
重建它的条目）；重建整个域需要对该域内每个 session 目录各读一次（O(会话数)），
因此索引必须**按 session 增量维护**，而不是"读一次 manifest 就重建一个域的快照"——
上一版那句描述与逐 session 的链模型不一致，已删。
索引自身损坏 → 丢弃重建，**不得**因此返回 `parse-error`（那是 manifest 的码）。
与 `orca/src/main/ai-vault-search/session-search-database-path.ts:5-12` 的"派生可重建"定位一致。

### 6.8 resume：拉回 + 分级降级，不做远端 attach

resume 不是"Orca 能显示 transcript"，而是"provider CLI 以自己的身份重新进入那个会话"。
既有本机构造总会带 `cd <cwd> &&` 前缀（`orca/src/shared/ai-vault-resume-command.ts:123`），
所以 **cwd 是 resume 的一部分**。OMP/Prime 还支持绝对路径作为 `--resume` 目标，
注释说明这能绕开"按默认 store 做 id 前缀查找会 miss"的问题（同文件 `:30-38`）。

**前置校验**（任一不满足就走降级，不尝试）：归档完整性（`sha256(blob) == manifest.sha256` 且长度相符）、
provider 可得、版本兼容（`providerVersion`）、provider store 布局可推导、**目标 host 无同 id 但内容不同的文件**
（冲突则 `resume-conflict`，不覆盖）、会话已结束（§5.11 三条件）、两处都可写且有空间、**用户显式确认**。

| 级 | 行为 | 界面必须说 | 何时可用 |
| --- | --- | --- | --- |
| L0 | 写回 provider store，用原生 `--resume <id>` | "已在 `<host>` 恢复原会话" | store 布局可推导、版本兼容、无冲突、用户确认 |
| L1 | 路径式 resume（provider 支持绝对路径 target） | "以归档文件为目标的 resume" | OMP/Prime 一类 |
| L2 | 只读回放（Orca 内渲染 transcript + scrollback） | "回放；**不是** resume，未恢复 provider 会话" | provider 未安装/版本低/store 不可写 |
| L3 | 导出/注入为新会话的初始上下文 | "这是**新会话**，原 sessionId 未续" | 用户明确要求续做但 L0–L2 都不可用 |

**绝不做的降级**：伪造 provider 会话文件让 provider 以为是自己写的；以及"看起来成功"的降级——
L2/L3 的文案必须出现"不是 resume"/"新会话"。

**为什么不做远端 attach（四条理由）**：归档会话按定义没有活进程，"attach"会悄悄变成 fork/restore；
它需要跨 host 传输、鉴权、背压与并发输入仲裁（属于 C）；它会破坏归档的只读不变性；
**第一阶段无法验收**——"远端 attach 成功"没有可离线构造的判据。

### 6.9 读路径的负向清单

- 读时**不写**共享侧（读侧对 `<archive-root>` 只读，这也让"只读挂载"负例可构造）。
- 不信任 manifest 里任何宿主路径字段：`cwd` 是历史值，`localPath` 只作诊断。
- 失败时不返回空正文、空 `hits`、`tokens: 0`、`messages: 0`。
- 不用 `mtime`/`size` 推断"文件完整"。
- 版本高于本机支持时不"尽力解析"，**也不退回旧世代**（`version-unsupported` 是独立状态）。
- 分叉时不选边（`chain-fork` 就是终态回答）。
- 不在缺少本地索引时按"猜测的 hash"读 cache。
- 不用 `not-archived-local` 回答全局问题（§6.5）。
- **不做远端 attach**（§6.8）。

---

## 7. issue #34 六项待拍板：逐条

分类只有两种取值：**需要 owner 拍板** 或 **本设计即可定**。未决的**不写成已决**。
§7.1–§7.6 逐条对应 issue 原文的 6 项「仍待拍板」；§7.7 是收尾声明，不是第 7 条议题。

### 7.1 共享存储基质；挂载点变化时 `cwd` 如何重写

| | |
| --- | --- |
| 现状 | issue 的 B 形态图假设目录结构（挂载语义），同时把对象存储列为选项；仓库快照里没有对象存储客户端，"共享存储位置"是私有部署输入 |
| 选项 | (a) POSIX 挂载（NAS/SMB）；(b) S3 兼容 API；(c) 定义五个原语的 storage adapter（`stat` / `readRange` / `list` / `putNoReplace` / `createExclusive`），第一阶段只实现 (a) |
| **建议** | **(c)**，并把"必须支持 `putNoReplace` / `createExclusive`"写成基质选型的硬前提——世代发布与 fence 领取都建立在它之上。**但即使有了它，第一阶段也不开接管**：跨 fence 的线性化提交需要**条件写**（`If-None-Match` / 行锁），那是 (b) 或独立服务才有的能力（§1.5） |
| 影响 | 选 (a)：`ENOENT`/`EACCES` 可分辨、只读负例、不可变世代发布全部立即可用；缺的是"接管"。选 (b)：可把 `putNoReplace` 映射到条件创建，并在条件 PUT 可用时**将来**具备接管能力（届时另立设计）。adapter 让 (b) 成为增量而不是重写 |
| **分类** | **需要 owner 拍板**（基质选择就是部署输入） |

一句话理由：挂载与对象 API 的差集正好落在三处最硬的地方——错误可分辨性、原子不覆盖创建、条件写；
前者决定第一阶段能不能跑，后者决定将来能不能开接管。

`cwd` 的两段答案（本设计可定）：**共享侧挂载点变化 → 不需要重写**（无字段）；
**源主机 cwd 变化 → 不就地重写**（manifest 不可变），读响应携带
`cwdResolution: {archived, resolved, source: 'exact'|'remapped'|'missing'}`。
真正的重映射是显式动作，产出新的世代，而不是覆盖原记录。

### 7.2 transcript 含密钥/用户代码：ACL、加密、脱敏、按任务授权做到哪一层

| | |
| --- | --- |
| 现状 | transcript 是未脱敏原文；仓库既有做法是**传输期** redact + 路径扣留（`orca/docs/reference/agent-session-search-contract.md:99-105`）；本机私有模式 `0700/0600`（`orca/src/main/daemon/daemon-private-file-modes.ts:1-4`）**不能表达跨主机共享** |
| 选项 | L0 仅目录权限 + 路径不跨网络；L1 授权域 + 组 ACL；L2 静态加密；L2' per-task 密钥；L3 采集期脱敏；**L1g** 经鉴权网关取 blob |
| **建议** | **L0 + L1，且 L1 必须落实到"blob 与 manifest 同域"这一层**；**明确拒绝 L3**；L2 用下面的判据决定；L2'/L1g 由 owner 定 |
| 影响 | L1 要求 collector 知道域的参与者（**新的私有输入**）；域内去重会放大存储占用；不做 L2 时同域可读者能读该域全部内容（这是 L1 的边界，不是缺陷）；做 L3 会让 sha256 验收直接失效 |
| **分类** | L0 / 域内放置与去重 / 拒绝 L3 = **本设计即可定**；是否加密、是否 per-task 密钥、读者集合怎么产生、`_unlinked` 归谁 = **需要 owner 拍板** |

| 层 | 措施 | 可判定性 |
| --- | --- | --- |
| 布局 | `blobs` 与 `manifests` **同处一个授权域子树**，域的组即授权组 | 一个域 = 一次 `du`；越界读 = 一次 `EACCES` |
| 去重边界 | `sha256` **只在域内去重**；跨域同字节是两份 | 结构上不可能出现跨域引用（R9 只校验结构，域由路径决定） |
| 权限 | 域目录 `2770`（**setgid**）+ 文件 `0640`；父级 `<archive-root>` 为 `2710` | 组 mask 必须允许读取：`getfacl` 与 `umask 007` 是部署检查项 |
| 越权负例 | 只有域 A 组身份的账号直接 `open` 域 B 的已知 `sha256` | 必须 `EACCES` |
| 做不到一域一组 | **必须**走 L1g（鉴权网关）或 L2（加密） | 否则 `blobs/` 就是"所有任务共读的明文池" |
| `_unlinked` 归属 | 无 issue 的会话落 `_unlinked/`，其组是"仅采集者与所有者"的组，**默认不与任何任务共享** | 无该组身份 → `permission-denied`，不是 `not-archived-local` |

加密的触发判据（把"要不要加密"变成可回答的问题）：**若某域的可读主体集合 ⊋ 该域的参与者集合，
就必须加密或改走网关**。

一句话理由：脱敏必须发生在"读出之后、跨网络之前"；一旦挪到采集期，
"host B 读回 sha256 与本地一致"这条验收就无法成立。

### 7.3 保留期与配额；删除工作区/issue 时共享归档是否跟着删

| | |
| --- | --- |
| 现状 | 本地只有索引侧 `historyDays` 与"只裁剪已删除记录、上限 1500"（`orca/src/main/ai-vault-search/session-search-retention-policy.ts:6-12`；`orca/src/shared/task-run-history.ts:60-65`）；共享侧没有先例 |
| 选项 | (a) 跟随删除；(b) 不跟随 + 显式删除；(c) 不跟随且永不删 |
| **建议** | **(b)**。blob 保留期与 manifest 保留期**分治**；过期产生 `blob-expired` 且必须在 head 上留 `gaps: blob_expired` 标记；配额超限 fail-closed（`archive-quota-exceeded`），**不得**为腾空间删别的会话的 blob；显式删除写 tombstone |
| 影响 | (a) 取消归档的核心价值且不可逆；(c) 让配额无限增长、把隐私窗口变成永久；(b) 需要一次人工删除动作的设计 |
| **分类** | **需要 owner 拍板**（保留期数值与"是否跟随删除"都是不可逆决策） |

一句话理由：保留期是唯一"删了就没有"的参数。

**必须显式写出的一处反差**：本地侧的会话清理是"跟随状态差集删除"（`orca/src/main/persistence/loading-store/terminal-session-cleanup.ts:27-38`）。
**共享侧必须故意不复用这个模式**，否则归档退化成第二个本地缓存。注意：本地那套删除仍受 §5.9 保护引用约束。

### 7.4 manifest 的 schema 与版本；collector 是 orcad 内嵌任务还是独立 sidecar

| | |
| --- | --- |
| 现状 | issue 倾向内嵌（"少一个进程"）；orcad 已是若干后台任务的宿主；本机已有"版本化契约 + 只做加法"的先例（`orca/src/shared/ai-vault-search-contract.ts:83-94`） |
| 选项 | (a) 内嵌 orcad 后台任务；(b) 独立 sidecar；(c) 由 archive hook 触发外部命令 |
| **建议** | **(a)**；schema 见 §4.10 |
| 影响 | 内嵌的真实代价不是进程数，而是**没运行 orcad 的 host 永远不归档**——需要"显式 `orca archive` 前台命令"兜底。**此外还有一条本轮新增的代价**：保护引用（§5.9 P0）需要由 daemon/窗口服务创建，内嵌 collector 只能"消费"它，不能替代 |
| **分类** | schema 与内嵌 = **本设计即可定**；"无 orcad 的 headless host 是否也必须能归档" = **需要 owner 拍板** |

一句话理由：内嵌的代价是覆盖面而不是架构，这条先被承认再决定。

### 7.5 resume：跨 host 先拉回再 resume，还是支持远端 attach；provider 路径不同时如何降级

| | |
| --- | --- |
| 现状 | 本机构造 `cd <cwd> && <agent> --resume <id|path>`（`orca/src/shared/ai-vault-resume-command.ts:123`）；provider store 布局因 agent 而异；跨 host resume 无任何先例 |
| 选项 | (a) 远端 attach；(b) 拉回 + 写 provider store；(c) 拉回 + 只读回放；(d) 导出注入新会话 |
| **建议** | **不做 (a)**；按 L0(b) → L1(路径式) → L2(c) → L3(d) 降级，每级在界面上说清自己在哪一级（§6.8） |
| 影响 | (b) 是对 provider 私有格式的写，版本变化会碎；(c) 没有 provider 上下文，续做体验差；(a) 需要 C 的全套能力且不可离线验收 |
| **分类** | 不做远端 attach = **本设计即可定**；"是否允许把归档写回目标 host 的 provider 会话目录" = **需要 owner 拍板** |

### 7.6 只归档已结束会话，还是允许正在运行的会话增量归档

| | |
| --- | --- |
| 现状 | provider transcript 是 append-only，边读边写会抓到半截行；本地 scrollback 在标签页移除时被删（`orca/src/main/persistence/loading-store/terminal-session-cleanup.ts:27-38`） |
| 选项 | (a) 只归档结束会话；(b) 周期性增量归档；(c) 结束 + 用户显式"快照" |
| **建议** | **(a)**，"已结束" = §5.11 三个机器条件合取，每个条件记 `endEvidence`；`truncated` 字段保留 |
| 影响 | (a) 崩溃/断电的会话永远无法归档；换来"manifest 指向的 blob 一定是完整文件"这一可验收性质。(b) 需要"部分 blob"语义 + 可变或 chain manifest，是另一个设计 |
| **分类** | **本设计即可定** |

### 7.7 本文没有决定、也不声称的事

1. 同一 session **跨域**归档的授权语义（谁能替别人的域建别名）——形状见 §4.13，授权由 owner 定。
2. 租约 TTL、停滞告警阈值、`skew` 容差的**具体数值**——形状见 §5.5，数值随部署定。
3. 是否引入共享侧"请求状态"对象（`requests/<requestId>.json`）以把
   `archive-status-unknown` 变成可判定——默认不引入（会把共享侧从"只放 blob+manifest"扩展成
   "放请求元数据"，且暴露意图）。**在此之前，跨主机的"从未归档"不可断言（§6.5）。**
4. **是否开启多写者与跨主机接管**，以及为此引入的条件写能力（对象存储条件 PUT / DB 行锁）。
   本文把第一阶段收窄为**单写者追加**（§5.4.2），这是**本设计可定的范围**，不是待 owner 拍板的项；
   若要放开，需另立设计与反例覆盖（§5.12 保留了 D-1/D-2/D-3 三个前置反例），不是改一个开关。
5. 配额与保留期的具体数值；读者集合的来源；是否启用 L2 加密；`_unlinked` 归谁（§7.2、§7.3）。
6. 任何"已实现""已通过验收"的结论（§1.4）。

---

## 8. 验收矩阵

**本节全部条目都是"实现后才能执行"的检查，本文只给判据，一条都没有通过。**
标注：**离线** = 单机可判定；**双机** = 需要两台真实 host。

### 8.1 issue「验收（B）」逐条

| ID | issue 验收条目 | 可判定检查 | 可测 |
| --- | --- | --- | --- |
| A1 | 在 host A 完成一个任务 → 归档/删除 → collector 上传 transcript + manifest | **步骤**：`<host-a>` 创建并结束一个会话 → 触发归档 → 列目标域，断言出现 1 个 blob 与 1 个 `g000001.json`（创世）；断言 tip 的 `sessionKey`/`worktreeId`/`archivalGroup`/`agent`/`endedAt`/`endEvidence` 与本地一致，`sources[].sha256` 等于本地 `sha256sum` | 双机（上传部分可离线） |
| A2 | 在 host B（无本地副本）按 issue/worktree 读回 manifest 和全文，sha256 与本地一致 | **断言**：`<host-b>` 的 provider 目录与 `<local-cache>` 均为空 → 按 `archivalGroup` 列举 → 读全文 → 重算摘要 == A1 记录值；`<local-cache>` 出现该条目与新索引快照 | 双机 |
| A3 | 断网时 agent 正常结束；恢复后重试成功；重复上传不产生第二份 blob/manifest | **步骤**：断开共享侧 → 结束 agent → 断言退出码正常、本地完整、**队列里已有该请求（`state=pending`，离线可写）** → 恢复 → 断言条目 `confirmed`、blob 与 1 个世代出现。**幂等断言**：同一 host 对同一内容触发两次 → `blobs/` 该摘要 1 个、**世代数仍为 1**、`attempts[]` 长度 1（第二次在 S6 用 `requestId` 查重）。**单写者断言（与 W-2 一致）**：让**第二台 host** 归档同一内容 → 它返回 `already-archived` 或 `session-claimed-elsewhere`，**`attempts[]` 长度不变、`generation` 不增、它不写任何共享字节**（第一阶段**不要求**两 host 各产生一行 attempt；旧版那句"两台 host 各采 → 2 行 attempt"与 W-2 冲突，已删）。**负例**：断网期间不得出现"已完成归档"文案 | 离线（幂等/第二台被拒部分）+ 双机（第二台部分） |
| A4 | 部分上传/进程崩溃后不出现"半截 manifest"；本地文件在确认前不被删除 | **负例 1**：blob 写完、世代未发布时 `kill -9` → 条目已停在 `blob_published`（S5 逐件落盘），断言无 `g*` 文件（或只有临时名），读侧转 §6.5 得 `not-archived-local`/`archive-status-unknown`（**不是** `parse-error`）；恢复走 `blob_published ∧ Ball ∧ TS==GENESIS` 建创世。**负例 2**：`link` 成功、`manifest_published` 未落盘时崩溃 → 条目仍 `blob_published`，`Ball ∧ M2` 命中 ⇒ `TS==UNIQUE` 且链上已有本 `requestId` ⇒ 补写收据 → `confirmed`，**不产生第二个世代**。**负例 3**：`manifest_published` 已落盘、收据未写 → `manifest_published ∧ ¬R` ⇒ 按 `publishedGeneration` 定位文件、重算摘要、补写收据。**负例 4**：收据已写、`state` 未落盘 → `M2` 补收据后 `confirmed`。**断言**：上传未确认时本地 transcript/scrollback 仍在且摘要不变，**且受保护删除被挡住**（§5.9 P2） | 离线（需可注入崩溃点）
| A5 | 归档工作区删除后 trace 仍可读回；删除工作区但未成功上传时明确显示"归档未完成 / trace 不可达"，不假装有 | **步骤**：A1 成功后删除工作区 → 按 `archivalGroup` 或 `worktreeId` 读回 → 断言全文与 A1 一致、`source:'archive'`、`cwdResolution.source != 'exact'` 时有明确说明。**负例**：`read-only` 或断网条件下删除工作区 → 断言输出 `archive-pending` 或 `read-only`，**不出现**空正文、`0` 条消息、"该会话无记录" | 双机（"另一台无本地副本"部分） |
| A6 | 负例：权限不足、共享存储只读、manifest 损坏、blob 缺失，都必须报明确状态，不静默回退成本地空内容 | 见 §8.2 的 B1–B5、B8 | 离线 |
| A7 | 不在本 issue 里授权部署、清理或迁移任何现有数据 | **断言**：交付时 `git -C <worktree> status --porcelain` 只含目标文档；交付物中不含部署/清理/迁移命令；不含真实挂载路径、主机名、账号、凭据 | 离线（文档 + git 状态检查） |

### 8.2 负例矩阵

| ID | 负例 | 构造 | 断言 |
| --- | --- | --- | --- |
| B1 | 权限不足 | 目标域 `chmod 000`（或用无该域组身份的账号） | `permission-denied`；**不**被报成 `not-archived-local`/`blob-missing` |
| B2 | 共享存储只读 | `mount -o ro` | **读侧仍返回 `results`**；**写侧返回 `read-only`**（`retryable:false`）、队列保留、本地不删、保护不解除 |
| B3 | manifest 损坏 vs 不合规 vs 版本过高 vs 坏的 tip | 截断字节 / 删必填字段 / `schemaVersion=2` / 让 tip 的 `predecessor` 指向不存在的文件 | 分别得 `parse-error`、`schema-invalid`、`version-unsupported`、`chain-broken`；四者**互不顶替**；且**都不静默退回旧世代**（要把旧代读出来只能用 `--at-generation` 诊断模式，响应带 `diagnostic:true`） |
| B4 | blob 缺失 vs 过期 vs 截断 | 删 `blobs/<sha256>`；只让保留期过期；把 blob 截短 | `blob-missing`、`blob-expired`、`blob-truncated` 三者可区分；都**不**被报成 `schema-invalid`（结构合法、存在性问题是读时观察，§4.10 R9）；都不删 manifest |
| B5 | hash 不符 | 换掉 blob 内容但保留文件名 | `hash-mismatch`、staging 被丢弃、cache 不写入、不返回部分内容 |
| B6 | 等长字节损坏（cache 直读） | 把 cache 里某 blob 的 1 个字节改成同长内容 | 由身份元组判定（`ctime` 变化）触发重算 → `hash-mismatch` → 重拉一次后恢复；**不得**直接返回损坏字节 |
| B7 | 队列条目损坏 | 改坏一个字节 | `queue-entry-corrupt`、隔离、保留原字节、不当作"没有条目"、**不解除保护** |
| B8 | 词表与响应形状（跨条目） | 对 §6.3 的 **17 个读侧码**逐条断言响应形状；对"只读下的正常读取"单独断言。**测试层级要写清**：其余 16 码都有可构造的存储/请求输入，**`chain-fork` 只按响应形状测**（本地合成"两条 tip"状态喂读侧函数），**不声称端到端可达**（§5.4.4 d2、B15） | 每个码都只在 `kind:'unavailable'` 出现且 `retryable` 与表一致；**只读的读路径返回 `results`**（成功场景，不参与 `unavailable` 断言）；写侧失败码不出现在读侧响应；`not-archived-local` 必带 `scope:'local'` |
| B9 | 单写者：第二个写者被拒绝且不发布 | ①A 是 owner，B 尝试归档同一 session；②A 的租约过期后 B 尝试；③r3 的交错（A 暂停在发布前、B 出现）；④**r4 的交错：A 释放后 A/B 都看到"无租约"**；⑤**r5 的交错：B 先读"无租约/无 claim"后暂停，A 完成领取并删 claim，B 恢复执行** | ①`session-claimed-elsewhere`（附 `headGeneration`/`headManifestSha256`/`ownerHostId`），**B 不产生任何共享写入**；②同上（过期不授权接管）；③④⑤**任一方若不是 owner，它根本不进入 S5–S8**（§5.4.2 W-2），因此双 tip 不可达；若同一份内容，返回 `already-archived`；**不登记第二份来源**（§5.5.1）。**断言**：无论哪种子例，`head` 的 `attempts[]` 不变、`generation` 不增、已提交 attempt 不消失 |
| B10 | 跨域越权读已知 hash | 只有域 A 组身份的账号 `open` 域 B 的已知 `sha256` | `EACCES` |
| B11 | 零字节 transcript 端到端 | 归档空 transcript，在另一台无副本 host 读回 | `bytes: 0`、`results` 成功、`blobSha256` = 空字节串摘要；不报 `blob-missing`；`completeness` 可为 `complete` |
| B12 | 受保护删除必须被挡住（保留验收） | 会话仍在保护期 → ①触发 ref 差集变化；②`removeSession`；③worktree 拆除 | 三处都**删除被挡住**，文件仍在、摘要不变；保护只在 `archiveConfirmed` 后解除。**注意**：本负例**不得**先删字节再要求保护（那是自相矛盾的构造） |
| B12b | 此前已丢字节的降级（不是保留验收的替代） | 在 P0 生效之前就已丢失的字节（模拟旧版本升级） | head 记 `gaps: scrollback_evicted_before_archive`（`blocking`）、`completeness=partial`；**且**不得据此认为"保留已验收" |
| B13 | 跨主机"从未归档"不可断言 | A 离线 pending；B 查询同一会话 | B 返回 `archive-status-unknown`（`presence: unverifiable`），**不得**返回 `not-archived-local` 的全局版本；本机范围的响应必须带 `scope:'local'` 且文案含"本机" |
| B14 | 能力缺失 fail closed | 探针发现 `O_EXCL`/`link`/`fsync(dir)` 任一不可靠 | 分别 `fence-unsupported` / `blob-publish-unsupported` / `fsync-unsupported`；**不降级为 replace、不假装落盘**；`fence-unsupported` 时**完全不写共享侧** |
| B15 | 前驱不连续 ⇒ `chain-broken`；正常延长 ⇒ `UNIQUE`；**`chain-fork` 本期不可达** | 在健康 `g1,g2` 上构造三种：①复制 `g2` 为 `g3` 且让 `g3.predecessor` **仍指向 `g1`**（generation 1 ≠ 3−1）；②复制 `g2` 为 `g3` 且让 `g3.predecessor` **指向 `g2`**（连续）；③人为复制并让两条支都挂在同一前驱上（尝试造 fork） | ①`chain-broken`（§5.4.4 **d1**："前驱 generation 必须等于 g−1"），**不是** `chain-fork`；②`UNIQUE`——这是**正常延长链**，不是分叉；③在当前**单名空间 + 连续前驱不变量**下不可能成立：一个世代只有一个文件名（§4.1），而"两条支挂同一前驱"要求两个文件都声明 `predecessor.generation == g−1` 且 generation 相同或跳号，两者都会先被 d1 或文件名唯一性挡住。**因此 `chain-fork` 本期不可达**，只保留为诊断/后续切片用的码；它在 §8 B8 里只按**响应形状**测（本地构造一个"两条 tip"的合成状态喂给读侧函数，不构造真实存储布局），**不声称有端到端场景**，也不得为了造它引入第二个文件名
| B16 | 创世基例（修正后可执行） | 首次归档（manifest 目录不存在 → `TS==GENESIS`） | §5.4.4 的 **A1** 把"目录不存在 / 无匹配文件"判为 `GENESIS`（**不是** `chain-fork`），因此 S7 能建 `generation=1`/`predecessor=null`；第二次归档 `generation=2` 且 `predecessor` 指向 g1；**不存在"新 fence 的 g1"**（§5.4.3）；**目录存在但为空**同样判 `GENESIS`，不得因"目录存在"报 `parse-error` |
| B17 | `superseded` 语义 | 同 host 同 session 先发 A 请求（transcript only），未提交前再发 B 请求（transcript+scrollback） | A 落 `superseded`、`supersededBy=B`、**不产生 attempt**；B 正常提交；G5 不被 A 阻塞；保护引用始终至少一条 |
| B18 | claim 退化后不承担正确性（r4 的 B1 专项，收窄后重述） | ①两台 host 同时从"无租约"起步；②A 拿到 claim 后暂停；③A 建了 fence 但未写租约就崩溃；④同机两个 collector 实例；⑤**人为删掉 claim** | 五种情况下都断言同一件事：**owner 之外的机器不产生新世代**；最坏结果是重复上传同一 blob（内容寻址 ⇒ 一份）、一次 `lease-busy` 拒绝、或一次重复劳动，**链上已提交 attempt 与其摘要不变**。不再要求 claim 提供互斥（那是 §5.12 的后续切片） |
| B19 | 判定表唯一性（r4/r5 的 M7 专项） | ①保留合法 g1、把 g2 的 `predecessor` 改指不存在文件；②**复制 g2 为 g3 且让 g3 的 predecessor 仍指 g1**（前驱 generation 不连续）；③最高代是坏 JSON、次高代完好；④全部候选都坏；⑤空目录；⑥只有临时名文件；⑦目录里混有非规范名（如上一版的 `g<gen>-f<fence>.json`）| ①`chain-broken`（d1 优先）；②`chain-broken`（d1：`predecessor.generation` 必须等于 `g−1`）；**②的近邻输入（旁注，不编号）**：若副本的前驱指向**紧邻的前一代**，那是**正常延长链** ⇒ `UNIQUE`（上一版把它写成 fork，与 d1 冲突，已改）；**旁注（不编号）**：想造 `chain-fork` 的输入在当前单名空间下不可达（见 B15），`chain-fork` 只在 B8 里按响应形状测，**不占用本条编号**；③报**最高坏代**的 `parse-error`，不被次高代掩盖、不退回旧代；④报最高坏代的码（唯一）；⑤⑥`GENESIS`（A1），不是 `chain-fork`、不是 `parse-error`；⑦这些文件**不匹配正则**、被 A2 忽略并记 `nonconforming_file`，**不参与判定**（因此"同代不同 fence 不同错误类型"在当前命名下是不可构造输入） |
| B20 | 非写者强行追加会被测出来（实现缺陷检测，不是协议路径） | 故意绕过 S4 的 `OW`，让非 owner 主机在 `TS==UNIQUE` 时仍发布 `g<N+1>` | **比较时点固定在发布前**：用 `preOwner`（= 我在 S4 读到的那一代的 `attempts[-1].sourceHostId`，也就是我的 `predecessor` 所指的那一代），**不得用发布后的 `tip.attempts[-1]`**——发布之后那已经是违规者自己了，用它断言"与 B 不同"是同义反复。断言：`preOwner != 本机 ⇒ 该发布属于 W-2 违规`，由本用例捕获。若它算的代号已被占 ⇒ `EEXIST` 重读；若它算的代号更新且前驱正确 ⇒ 链在结构上仍完整，但 `preOwner` 与本机不符。**注意**：本断言证明"违规可见"，不证明"违规被阻止"——后者由 S4 的 `OW` 阻止（B21 测的是阻止，不是可见性） |
| B21 | **恢复路径的裁决顺序与 `OW` 闸门**（r6/r7） | 四个入口各构造一次，**且都按 §5.6.3 的 R0–R5 顺序求值**：①`Bmiss`（A 是 owner，B 的条目缺一件 blob）；②**真创世**（`TS==GENESIS` 且目录确实没有任何世代文件，B 是第一个到者）；③**GENESIS 旧快照失效**（B 在上次观察时还是 `GENESIS`，但 A 已发布 `g1`）；④`manifest_published ∧ ¬R`（A 已合法提交但本机收据缺失，B 只是这台 host 上的同机实例） | ①B 在 `R5` 判 `¬OW` ⇒ `session-claimed-elsewhere`，**不补 blob**；②`OW` 在 `GENESIS` 下恒真 ⇒ **允许**建 `g1`，结果 `archive-pending` 后进入 S7/S8；③B **必须先重算 `TS`**：重算得 `UNIQUE` 且 owner=A ⇒ 走 `R5` 的 `¬OW` 分支被拒（**不得沿用旧的 `GENESIS` 内存快照直接创世**）；④B 在 `R4b` 补写本机收据 ⇒ **允许**（`¬R` 只涉及本地文件，`R4` 层根本不适用 `OW`），结果 `archive-pending` 后转 `confirmed`。**断言**：每个输入的结果**唯一**；**不同的输入允许得到同一个码**——①③ 都是"被 `OW` 拒绝"（`session-claimed-elsewhere`），②④ 都是先 `archive-pending` 再各自收敛（②→创世，④→`confirmed`），所以**不得**断言"四个码互不相同"（上一版这么写，与它自己的期望输出矛盾，已删）。**③ 的机制要写对**：旧 `GENESIS` 快照必须先重算成 `UNIQUE`；**即使不重算就直接去发布**，`g000001.json` 是**固定同名**、独占发布会拿到 `EEXIST`，于是回到 S3/S4 重读、再按 owner 被拒——**不会出现两个规范 `g1`**（上一版写"会产生两个 `g1` 并被 A2/d1 检出"是错的：A2 只忽略非规范名，而两个同名文件在文件系统层面不可能共存）。**注意**：④ 的构造**不能**复用 ①–③ 里那个尚未发布的 B，必须另起一个"已合法发布、只缺收据"的输入 |

### 8.3 矩阵的使用方式

- **A2 / A5 与 B9/B10/B13 建议双机**（它们考的就是跨主机语义）；其余都能用"两个 dataRoot + 构造负例"离线判定。
- 实现切片必须把**离线可测的那些**当作最小门禁。否则第一阶段结束时无法回答"到底验过什么"。
- 任何"已通过"的说法，必须能指向一次真实执行（命令 + 结果），否则只能说"未执行"（§1.4）。

---

## 9. 分阶段实施计划

| 切片 | 交付 | 退出条件 | 明确不含 |
| --- | --- | --- | --- |
| **S1 能力探针 + 最小可验证切片** | **(1) 存储能力探针**；(2) 显式"归档历史"触发的采集 + 域内 blob 上传 + **创世世代** + fence 目录 + 单机读回 | 探针逐项结论；A1 上传部分、A3 幂等部分、B4/B5/B11/B14/B16 通过 | 自动触发、队列退避、跨主机接管（不做）、resume、保留期 |
| **S2 链与对账** | 世代链（`predecessor`/tip/`chain-fork`）、收据、完整恢复表、保护引用与三处删除闸门 | A4 三条崩溃负例、B7、B12、B12b、B15、B17 通过；"确认前不删本地"有断言 | 归档/删除工作区触发 |
| **S3 触发点接入** | 归档/删除工作区前置条件、删除意图记录、会话打开即建保护（P0） | A5 的"未上传就删"负例通过；P0 在会话打开时确实建了保护 | 双机读回 |
| **S4 跨主机读回与 resume** | 读路径全状态机（17 码）、索引快照 + cache 完整性、`cwdResolution`、L0–L3 降级 | A2、A5（双机部分）、B3/B6/B8/B10/B13 通过 | 远端 attach（不做）；写回 provider store（待 owner） |
| **S5 保留期与显式删除** | blob/manifest 保留期分治、`blob-expired` + head gap 标记、配额 fail-closed、显式删除 tombstone | §7.3 数值由 owner 拍板后才能开工 | 自动删除（永不） |
| **S6（后续切片，不在本设计范围内）多写者与跨主机接管** | 条件写能力 + 唯一后继提交协议 + 反例覆盖（草案见 §5.12） | 必须先有 §1.5 的条件写能力、并解掉 §5.12 的 D-1/D-2/D-3，再走一次独立评审 | 本设计的一切 | 

三处依赖关系必须显式写：

1. **S1 的第一件事是能力探针，不是采集器。** 探针是**获准临时目录内的非破坏性写探针**：
   `O_EXCL` 抢名、`link` 不覆盖、`fsync(dir)` 生效、跨客户端互斥、目录原子 rename 五项都无法只靠读元数据
   证明，必须真的创建文件并制造一次冲突。规则：只在**调用方显式指定的探针目录**内写
   （`<archive-root>/<域>/.probe-<run随机>/`），每个用例独占子目录、结束即删，目录外写视为越界；
   目标若只读，探针只能返回 `unsupported` / `未验证`，**不得**用"读成功"冒充"写能力已确认"。
2. **S5 不能先于 owner 对 §7.3 的拍板**。保留期是唯一"删了就没有"的参数。
3. **S6 不在本设计范围内**。它需要 §1.5 列出的条件写能力与 §5.12 的三个反例全部解掉；
   第一阶段用"每 session 一个写者"绕开了这个问题（§5.4.2），而不是假装它已被解决。

**C（共享会话服务）作为演进方向，不是依赖**：S1–S5 全部可以在"NAS 只存 blob + manifest"下完成。
若将来要做 C，前提是服务独立于任何一台 Orca 的生命周期，且 blob 契约（内容寻址、不可变、域内）
可直接复用；届时"接管"也会变成服务端的一次行锁，而不是文件协议问题。

---

## 10. 与现有设计的关系

本节只**引用不复述**。任何冲突以被引用文档为准。

| 文档 | 关系 | 本文的边界 |
| --- | --- | --- |
| [task-workspaces.md](task-workspaces.md) | 任务身份、工作区绑定、跨入口续做的模型来源。本文的 `archivalGroup` 与 `worktreeId` 用法与它一致：**任务身份不由入口决定，系统不猜** | 本文不定义任务身份，不改任务 sparse 契约 |
| [task-workbench/README.md](task-workbench/README.md) 第 7.10 节 与 [task-workbench/development-plan.md](task-workbench/development-plan.md) P4 | issue #31 的历史三态与 `taskRunHistory`（S2）已在 main；P4 `taskRecords` **未开始**（`task-workbench/README.md:4`） | 本文**不落 `taskRecords`**、不写 `usageSettlement`、不给 `taskRunHistory` 加字段。S3 读回**事实条**，本文读回**字节** |
| issue #31 | 本文延续"三种空态必须分开"（本文扩为四种，§6.5）与"未知不写 0"的口径 | 不改变 #31 已实现的三态判定 |
| issue #35（历史保留结论） | 与"只裁剪历史、不裁剪活跃"一致：本地只裁剪已删除记录且上限 1500（`orca/src/shared/task-run-history.ts:60-65`）。**说明**：本 checkout 内没有 #35 正文，只对齐上述可核验的代码事实 | 不复述 #35 的保留数值 |
| [delivery-ledger.md](delivery-ledger.md) I5 | "unknown / false / true 三态分离"是 §4.6、§6.6 C3 的直接依据 | 不复用它的投递语义 |
| issue #34 | 方向、边界与验收的唯一出处 | 把 6 项待拍板与验收逐条落成可判定项；**不改它已定的边界** |
| [start-grant.md](start-grant.md) | 写作与论证风格参照：结论先行、状态集中在唯一出处、明确"不做/不声称" | 不涉及 Run 启动授权 |

三处**必须避免的重复**：① 不重述 #31 的三态表（引用 `task-workbench/README.md` 第 7.10 节）；
② 不定 `taskRecords` 字段（那是其 §8.3）；③ 不列私有部署输入。

---

## 11. 审查处置记录

本节分两类内容，**用途不同，不要混读**：

- **11.1 – 11.7 = 改动记录**（r2 … r8）：我改了什么、改在哪。它只说明"做了什么"。
- **11.7.1 / 11.8 / 11.9 = 复审核准状态**（r9 / 截至 r8 历史 / r10–r12 最新）：审查方对每一项的判定。
  **当前是否已被核准以 §11.9 所述增量确认链的最后一次为准**（r9 见 §11.7.1，§11.8 是截至 r8 的历史快照，
  该次摘要见其审查报告与归档索引）；作者的改动记录（11.1–11.7）永远不等于审查通过——
  这是被 r3 的 NIT 指出后在 r4 里坚持下来的区分。

### 11.1 第一轮（r2）改动记录

对象：第一版（1160 行，sha256 `fc918e14…`）。报告：`w3-reviewer-findings-r2.md`
（BLOCKER 2 / MAJOR 10 / MINOR 2，**共 14 项**）。

| finding | 处置 | 位置 |
| --- | --- | --- |
| B1 跨主机租约无 fencing/CAS | 已改（第一轮方案；**第二轮判定未解决**，见 11.2） | §5.4、§5.5 |
| B2 全局 blob 无任务级 ACL | 已改 | §4.1、§7.2 |
| M1 离线无法持久记录请求 | 已改 | §5.2 S0–S2、§5.7 |
| M2 无首代基例/缺恢复路径 | 已改（**仍未闭合**，见 11.2） | §4.3、§5.6 |
| M3 单枚举混合两轴 | 已改（**留下 MINOR**，见 11.2） | §4.9 |
| M4 身份键两套定义 | 已改 | §4.4、§4.13 |
| M5 幂等未落到 manifest | 已改（**仍未闭合**，见 11.2） | §5.7、§4.5 |
| M6 cache 顺序与等长损坏 | 已改（**仍未闭合**，见 11.2） | §6.2、§6.7 |
| M7 状态词表矛盾 | 已改（**仍未闭合**，见 11.2） | §6.3、§6.4 |
| M8 释放前无保护 | 已改（**仍未闭合**，见 11.2） | §5.9、§5.10 |
| M9 零字节 | 已改 | §4.2、§6.6 C1 |
| M10 跨主机推断"从未归档" | 已改（**判定未解决**，见 11.2） | §6.5 |
| N1 4 处引用错 | 已改 | §3.1、§3.2、§3.4、§4.8 |
| N2 探针称为只读 | 已改 | §9 S1 |

### 11.2 第二轮（r3）改动记录

对象：第二版（1549 行，sha256 `6c6adaf5…`）。报告：`w5-reviewer-findings-r3.md`
（剩余 BLOCKER 1 / MAJOR 6 / MINOR 1 / NIT 1，**共 9 项**；其中 B1 附一条结构矛盾子项，表中单列一行，故表有 10 行）。

| finding | 处置 | 位置 |
| --- | --- | --- |
| **B1** 跨 fence 无 CAS；"名字独占 + 最大 fence"不成立；含反例"B 用旧 head 发布的更大 fence 让 A 已确认 attempt 消失" | **已改：选路线甲（不接管）。** ①head 不再按 fence 裁决，改为**唯一 tip + `predecessor` 链**，分叉即 `chain-fork` fail closed、不选边；②`generation` 改为**全局单调、跨 fence 连续**，于是"新 fence 的 g1 空前驱"这个结构矛盾消失（历史上只有一个 `generation==1`，即创世）；③**关闭跨主机接管**：租约过期只产生停滞信号，释放证据只能由持有者所在 host 出具，同机 reclaim 不换 fence；④新增 §1.5「显式不声称」逐条写清"不提供跨 fence 线性化提交"及其所需能力；⑤反例覆盖表变成 B9（交错不可能）+ B15（人为造分叉必须 fail closed）+ B16（创世基例） | §1.2、§1.3-2、§1.5、§4.1、§4.3（`predecessor`）、§4.10 R8、§4.11、§5.2、§5.4（重写，含 5.4.1–5.4.6）、§5.5（重写）、§5.6.2（`TS`/`Ball`）、§5.6.3、§5.10、§7.7-4、§8 B9/B15/B16、§9 S6 |
| 结构矛盾（新 fence 的 g1 前驱） | **已改**：不再有"每 fence 从 1 重来"；`generation` 全局单调 ⇒ 只有一个创世世代 | §4.1、§4.3、§4.10 R8、§5.4.3 |
| **M2** M3 无 g1/null 基例；缺 `blob_published+无 manifest`、`manifest_published` 正常确认、每步落盘点；收据要求等于最新 head | **已改**：R8 给唯一基例；恢复表补 3 行（首代、`M2` 命中、`manifest_published ∧ R` 正常确认）；新增 §5.6.1 每步落盘点表（含"构造出的世代不落盘"）；`archiveConfirmed` 改为**不可变提交收据 + 链上包含关系** | §4.10 R8、§5.6.1（新增）、§5.6.3、§5.10 |
| **M3(minor)** 等 terminal 确认即判 partial | **已改**：`completeness` 只由 sources/gaps 决定，`lifecycle` 只由 `endEvidence` 决定；去掉"等待确认 ⇒ partial"，该情形现在是 `complete+open` | §4.9、§5.11 |
| **M5** 内容幂等同"两份都列来源"冲突；`superseded` 不在枚举/恢复/GC | **已改**：`requestId` 纳入 `sourceHostId`（同 host 重试仍幂等；跨 host 那条当时写成"两行 attempt"，**r7 已按单写者口径改为"非 owner 被拒、不产生第 2 行"**）；`attempts[].sourceHostId` 显式化；`superseded` 进状态枚举，补"何时产生/不提交/恢复/GC/保护"五行语义；G5 明示 `superseded` 不阻塞但需后继已 confirmed | §4.5、§4.13、§5.7（requestId 与 superseded 表）、§5.6.3、§5.10 G5、§8 A3/B17 |
| **M6** 索引缺失仍进期望 hash 步骤；索引无法表达多 session head/多 source；无离线新鲜度口径 | **已改**：§6.2 第 2 步失败**直接进 4**；索引 `entries[]` 每 session 带 `head` + `sources[]` 列表（含 `kind`/`origin`/`sourceHostId`/`generation`）；新增**在线/离线两套新鲜度判定**，离线只用本地证据（缓存副本 + 摘要相符），不满足即作废进 4 | §6.2、§6.7 |
| **M7** 域路径合法性与存在性混判；坏/高版本 tip 静默退回旧代；`identity-incomplete`/`manifest-missing` 不在词表 | **已改**：R9 只判结构（`bad-blob-ref`），存在性归读时观察 ⇒ `blob-missing` 可达；冻结"只判 tip、不退回旧代，读旧代只能 `--at-generation` 诊断模式"；词表补齐至 18 个读侧码（含 `identity-incomplete`/`manifest-missing`/`chain-broken`/`chain-fork`/`not-archived-local`）——**r4 起降为 17 个，`manifest-missing` 移出对外表** | §4.10 R9、§6.2、§6.3、§6.4、§8 B3/B4/B8 |
| **M8** 保护在归档意图时才建，而 ref 差集删除与意图无关；B12 构造自相矛盾 | **已改**：保护改由 **P0** 在"首次产生可归档字节时"由 daemon/窗口服务创建，`S0` 只续期/补建；三处删除路径共享同一闸门且**删除被挡住**；B12 改为"保护挡住删除"的保留验收，另立 **B12b** 专测"此前已丢字节只允许降级 partial"，并明示它**不替代**保留验收 | §5.1、§5.2 S0、§5.9（P0–P6）、§5.10、§8 B12/B12b |
| **M10** 仍可用本机"从未触发"推出全局 `not-archived` | **已改**：码名改为 `not-archived-local`，语义**严格限定本机范围**，响应必须带 `scope:'local'` 且文案含"本机"；任何全局结论只能是 `archive-status-unknown`；§7.7 增列"是否引入共享请求状态对象"作为 owner 决策 | §6.3(16/18)、§6.5、§6.6 C8、§6.9、§7.7-3、§8 B13 |
| **NIT** 计数不一致（14 码写 12、14 项写 13）；§11 未区分改动与核准 | **已改**：全文统一读侧码计数（当时 18 个，r4 起为 17 个）、**r2 共 14 项 / r3 共 9 项**，且 §6.3 表头写明确切个数；§11 拆成 11.1/11.2（改动记录）与 11.3（复审核准状态） | §6.3、§6.6 C9、§11 全节 |

**未采纳的 finding**：r2、r3 两轮共 23 项，全部有处置，无一项静默跳过。

### 11.3 第三轮（r4）改动记录

对象：第三版（1713 行，sha256 `448b0e62…`）。报告：`w7-reviewer-findings-r4.md`
（剩余 BLOCKER 1 / MAJOR 3，**共 4 项**）。

| finding | 处置 | 位置 |
| --- | --- | --- |
| **B1** 初领不互斥：两个 host 都看到"无租约"，各自 O_EXCL 建**不同编号**的 fence 都成功，随后都写租约、都发布 ⇒ 双 tip；O_EXCL 只独占号码，不独占 session | **已改：把"号码独占"换成"固定名字独占"。** 新增 `leases/<digest>.claim`（固定名）作为唯一领取权，`fences/<n>` 只能在持有 claim 之后才分配，因此第二个 host 在 claim 的 `EEXIST` 上被挡、**连 fence 号都不去算**；补 §5.5.1 五步收取协议 + 新旧协议逐时刻对照表（含 r4 的反例）；补 §5.5.2 "收取中崩溃"的四种半成品与各自可恢复者；补「同机继承**也必须走 claim**」这一条、人工释放必须同时证明"进程已停"+"在途写已排空"并记 `lastObservedGeneration`、释放后新写者只能从 `max(last, tip)+1` 继续；`claim.released` 加作者约束（`releasedByHost == claim.hostId`，否则视为不存在）；并把"原 host 永久损坏 ⇒ 该 session 永久停滞、超出本期恢复范围"写成 §5.4.2 的显式一行 | §5.2 S3、§5.4.2（新增一行）、§5.5（**r5 已整体改成 §5.5 + §5.12**；r4 当时的那三个子节现在都在 §5.12 的草案里）、§8 B9/B18 |
| **M2** S0–S12 缺上传 blob 步骤（恢复表把 S4 误称上传）；无 `manifest_published` 落盘点；首代：空候选被"任意态 `¬T0` ⇒ chain-fork"闸死、`M0` 用目录存在冒充世代存在、空目录误报 `parse-error`；缺 `blob_published`+无世代/缺其他 blob 的恢复行；blob 条件未按全部 sources 聚合 | **已改：** ① 步骤序列重排为 S0–S13，**新增 S5 上传 blob（逐件落盘）**，S6 查重、S7 构造、S8 发布、S9 重解析、S10 收据、S11 confirmed、S12 租约/保护、S13 GC 闸门；② 落盘点表补 **`S8 发布成功 ⇒ state=manifest_published` + `publishedGeneration`/`publishedFence`**；③ 谓词表删掉 `M0`（目录存在）与 `T0`/`T1`，改为 **`G0`（存在至少一个匹配的世代文件）+ `TS`（A→B→C 单一结果）+ `Ball`（∀s∈sources: B0∧B1∧B2 的聚合）**，并给出 `Bmiss/Btrunc/Bcorrupt` 的归类优先级；④ 动作表补 `blob_published ∧ TS==GENESIS`（首代待建）、`blob_published ∧ ¬Ball`（首代只传一部分）、`manifest_published ∧ ¬R`（已发布但收据未写成）三行；⑤ 空候选 = `GENESIS` 写进 §5.4.4 的 A1 | §5.2（S3–S13）、§5.4.4（A1）、§5.6.1（新行）、§5.6.2（重写）、§5.6.3（重写）、§8 A4/B16 |
| **M6** 域级 single tip：域内多个 session 各有独立链，却用一个域级 `tip` 校验在线索引，且无对应域根对象/协议 | **已改：删掉索引顶层的 `tip`。** 顶层只留 `entries`，**每个 session 的 `head` 就是它自己的权威引用**；在线新鲜度改为**只对目标 session** 重跑 §5.4.4 并与 `entries[d].head.manifestSha256` 比对；离线新鲜度仍为"该 head 的本地缓存副本 + 摘要相符"；并明确重建粒度是**一个 session**（重建整域是 O(会话数)），删掉"读一次 manifest 重建一个域快照"那句与逐 session 链模型不一致的描述 | §6.7（重写新鲜度段） |
| **M7** 错误优先级与未知态路由：同一输入可同时推出 `chain-broken` 与 `chain-fork`；坏 JSON/未知版本未定义如何参与判定；§6.2 第 4 步缺 manifest 即失败退出，未转 §6.5，故 B13 的 unknown 无入口 | **已改：** ① §5.4.4 重写为 **A（枚举）→ B（逐候选解析）→ C（求 head）** 三阶段，C1 定"最高代坏了报最高代的错"、**C2 `chain-broken` 优先于 C3 `chain-fork`**，因此同一输入只有一个结果；② §6.2 第 4 步改为"只调 A→B→C 拿 `TS`，再由 §6.4 出码"，且 **`GENESIS`/`manifest-missing` 明确"转交"§6.5**；③ §6.5 开头写明它是"没有可读 head 的唯一出口"，使 B3/B8/B13 共用同一入口；④ §6.4 表格化为"唯一入口：§5.4.4 的 A→B→C 表"，逐行给判据 | §5.4.4（重写）、§6.2（第 4 步与四条说明）、§6.4（重写）、§6.5（新增入口段）、§8 B19 |
| 顺带：B15 的 fork 证据落到哪里；B16 首次创世应可执行 | **已改：** 新增 §5.6.4，把证据分成本机（`<local-state>/archive-fork-evidence/`，**必写**）与共享（`chainfork/`，**尽力**）两处，并写明"证据写不进去也不改变 `chain-fork` 结论"；B16 在 A1 修正后可执行，并补"空目录同样判 `GENESIS`、不得因目录存在报 `parse-error`" | §5.6.4（新增）、§8 B15/B16 |

**未采纳的 finding**：r2/r3/r4 三轮共 27 项，全部有处置，无一项静默跳过。

### 11.4 第四轮（r5）改动记录

对象：第四版（1873 行，sha256 `9a0733ac…`）。报告：`w9-reviewer-findings-r5.md`
（剩余 BLOCKER 1 / MAJOR 2 / MINOR 1，**共 4 项**）。
本轮按 Coordinator 决策**把第一阶段收窄为"单写者追加"**，因此 B1 不再是"把 claim 修得更严"，
而是"**把需要 claim 承担正确性的那个前提去掉**"。

| finding | 处置 | 位置 |
| --- | --- | --- |
| **B1** 领取后不重读租约：B 先读"无租约/无 claim"后暂停，A 完成领取并删 claim，B 恢复执行步骤 3 就成功；claimId 检查不是条件删除，延迟 `unlink` 会误删后继 claim | **已改：范围收窄，不再让 claim 承担正确性。** ①新增 §5.4.2 的**单写者追加**三条规则（W-1 只有 `attempts[-1].sourceHostId` 可追加；W-2 第二台主机一律不追加/不发布，只返回 `session-claimed-elsewhere`/`already-archived` 并可登记 `duplicateSources[]`；W-3 交错发布不可达）与**逐条最坏结果证明**；②创世改为"固定名 `g000001.json` 上的 O_EXCL"——两台主机同时创世必然一方 `EEXIST`，**不需要租约参与**；③**把 fence 从世代文件名里拿掉**（`g<NNNNNN>.json`），使"同一代只有一个名字"：两个写者算同一代必撞名，这是"不丢已提交 attempt"的结构基础；④§5.5 重写为"写者判定在前、claim/租约只做去重"，并给出四种故障的后果表（都不影响正确性）；⑤旧的多写者机制整体移入**§5.12 后续切片草案**并显式标注"不在第一阶段契约内"，r5 的延迟领取反例作为其前置证据 D-2 保留；⑥§8 B9 改为断言"第二个写者被拒绝且不发布、head 不变"，B18 改为断言"claim 坏掉也不影响链" | §5.2 S3/S4、§5.4.2（重写）、§5.4.3、§5.4.4、§5.5（重写）、§5.12（新增）、§1.3、§1.5、§2.3、§4.1、§7.7-4、§8 B9/B18/B20、§9 S6 |
| **M2** 缺 `link 成功 → manifest_published 落盘前崩溃` 的恢复行；superseded 终态排在缺 blob 上传之后；`publishedGeneration`/`publishedFence` 未进队列字段表；"预落盘"与"发布后落盘"措辞不一；A4 与 S5 实际状态不对齐 | **已改：** ①动作表新增 **`blob_published ∧ Ball ∧ M2`** 行（`link` 成功、状态未落盘即崩溃）⇒ 补写收据；②把**终态排除提到动作表第一行**，并写明"一个 `superseded` 条目若先跑 blob 规则就会被'缺 blob ⇒ 去上传'命中"；③队列字段表新增 **`publishedGeneration` / `publishedManifestSha256`**；④**删掉"预落盘"说法**，只保留"`link` 之后才落 `manifest_published`"，并说明两者之间是可崩溃窗口、由 `¬R`/`M2` 吸收；⑤A4 重写为四个负例（含 `link` 成功崩溃、收据未写、state 未落盘），并把首例的期望状态改为 `blob_published`、读侧改为经 §6.5 转空态 | §5.6.1、§5.6.3（重排 + 新行）、§5.7（新字段）、§8 A4 |
| **M6（MINOR）** 在线新鲜度右栏说"只需 readdir + 摘要 head、不读全部世代"，与主判据要求的完整 A→B→C 冲突 | **已改：删除该捷径与错误成本口径。** 在线校验必须**完整重跑 A→B→C→D**（含逐候选过候选错误门与前驱回溯），成本明确写为"该 session 全部世代文件的一次读+摘要，随世代数线性、不随域内会话数增长" | §6.7 |
| **M7** C1/最高坏代规则不闭合（"已成功解析的最高 generation"在全部候选都坏时不存在）；`kind` 不符在 R2 是 `schema-invalid`、在 B2 是 `version-unsupported`；`manifest-missing` 已规定只能转 §6.5 却仍在对外 18 码与 B8 逐码断言里 | **已改：** ①§5.4.4 重写为 **A（枚举）→B（候选错误门）→C（最高坏代裁决）→D（求 head）**，C 规则改成**取最高坏代 `g*` 并报它的码**（不再依赖"最高合格代"，因此"全部候选都坏"也有唯一答案）；②`kind` 不符统一映射到 **`schema-invalid`**（与 R2 一致），`version-unsupported` 只用于 `kind` 对但版本过高，并把分类顺序固定为 JSON→kind→version→结构；③给出**三个覆盖输入的唯一输出表**（全坏 / 合法 g1 + 坏 g2 / 同代两文件），并说明"同代不同 fence"新命名下不可构造、旧命名文件被 A2 忽略；④**`manifest-missing` 降为内部观察**，读侧码从 18 降为 **17**，§6.2/§6.3/§6.6 C9/§8 B8 同步，B8 只断言 17 个可达码 | §5.4.4（重写）、§6.2、§6.3（17 码）、§6.4、§6.5、§6.6 C9、§8 B8/B19 |

**未采纳的 finding**：r2/r3/r4/r5 四轮共 31 项，全部有处置，无一项静默跳过。

### 11.5 第五轮（r6）改动记录

对象：第五版（1948 行，sha256 `00464fd8…`）。报告：`w11-reviewer-findings-r6.md`
（剩余 BLOCKER 0 / MAJOR 2 / MINOR 1，**共 3 项**）。BLOCKER 已清零，本轮**不引入任何多写者机制**。

| finding | 处置 | 位置 |
| --- | --- | --- |
| **B1（MAJOR）** 恢复动作表绕过 owner 闸门：`blob_published ∧ Ball ∧ TS==UNIQUE ∧ ¬M2 ⇒ 继续 S6–S10` 让**非 owner 从恢复路径合法追加**；B20 用发布后的 `last attempt` 断言；`duplicateSources` 落点自相矛盾（塞在不可变 manifest 里却要求非 owner 写）；A3 仍要求两 host 各一行 attempt；同机双实例下 S9 的"tip 就是我的代"会把健康链误报为坏链 | **已改：** ①§5.6.2 新增 **`OW`（owner 闸门）** 与 **`preOwner`（发布前读到的 owner）** 两个谓词；②§5.6.3 加 `OW` 闸门与"哪些动作必须先过 `OW`"的矩阵——**补 blob、发布新世代、重发已存在 blob 都要过；补记收据不过**（它不写共享字节）。**r7 修正**：该行当时放在表首，导致 `TS` 错误时也报 `session-claimed-elsewhere`、且豁免永远到不了；现在改为 R0–R5 唯一顺序，豁免在 `R4`、`OW` 在 `R5`；③把 r6 的最小反例原文写进 §5.6.3 并给出处置，新增 **§8 B21** 覆盖四个恢复入口；④**B20 的比较时点固定为发布前的 `preOwner`**，明确"不得用发布后的 `tip.attempts[-1]`，那是同义反复"；⑤**本期取消 `duplicateSources`**：manifest 不可变、非 owner 无权写，另立对象要新增授权面而收益近乎为零（同一 `sha256` 就是同一份内容），因此非 owner 只返回 `already-archived` 与 head 摘要、不写任何共享字节；⑥**§8 A3 改写**：删除"两台 host 各采 → 2 行 attempt"（与 W-2 冲突），改为"第二台 host 被拒、`attempts[]` 长度不变、不写共享字节"；⑦**S9 改为"我发布的这一代仍在唯一链中"**，不要求它是 tip——同机另一实例可能已追加 `g+1`，那仍是健康链 | §5.6.2（`OW`/`preOwner`）、§5.6.3（矩阵 + `¬OW` 行 + 反例）、§5.2 S9、§4.3、§4.13、§5.4.2 W-2、§5.5.1、§8 A3/B9/B20/B21 |
| **M7（MAJOR）** 版本谓词不一致：R1 要求 `int 且 ==1`，b3 只拒"非 int 或 >1"，b4 又不含 R1 ⇒ `schemaVersion=0/-1` 能通过候选门被选为 `UNIQUE`；分叉验收在新单名空间下不可构造（B15/B19②）；A1 仍写 `g000001-f…json`；§6.4 仍引 C2/C3；写侧封闭表漏 `session-claimed-elsewhere`/`already-archived` | **已改：** ①版本谓词统一为 **`schemaVersion == 1`（严格等于）**，`0`/负数/`>1`/非 int/字符串数字**全部**在 **b3** 收口，R1 不再是独立判定点（避免两处漂移）；给出 **三例负例**（`0` / `-1` / `"1"`）与唯一输出 `version-unsupported`；②**B15 重写**：复制 `g2` 为 `g3` 且 `g3.predecessor` 仍指 `g1` ⇒ 前驱 generation 不连续 ⇒ **`chain-broken`**；**r7 修正**：当时把它判成 `chain-fork` 是错的（会先命中 d1），现在改为 `chain-broken`，并把"正常延长"判成 `UNIQUE`、把 `chain-fork` 明确标为**本期不可达的保留码**；③B19② 同步；④A1 的 `g000001-f…json` 改为 **`g000001.json`**；⑤§6.4 的 C2/C3 引用改为 **d1/d2**；⑥写侧封闭表补 **`session-claimed-elsewhere` / `already-archived`** | §4.10 R1、§5.4.4 B/b3/b4 与唯一输出表、§6.3（version 行 + 写侧表）、§6.4、§8 A1/B15/B19 |
| **M2（MINOR）** "每个状态转移都先落盘再动共享侧"与"`link` 之后才落 `manifest_published`"矛盾；落盘表的步骤名与 S0–S13 错位（把 S3 写租约分配、S4 写 tip 计算）；"从 S4 重读 tip"与"同一 (fence, generation)"是旧措辞 | **已改：** ①把笼统要求换成**三条逐步骤规则**（P-a 先落盘再做副作用、P-b 后落盘表示完成、P-c 不能本地判断的一律重算），并逐步标注每条属哪一类；②落盘表重排为 **S3=读链（不落盘）/ S4=验 owner（落 `preOwner` 与 `fence`）/ S5=逐件 blob_published / S8=link 成功后 manifest_published**；③全篇"从 S4 重读 tip"统一为 **"回 S3 重读链、再走 S4"**；④"同一 (fence, generation)"改为 **"同一 generation 目标名"** | §5.6.1（重写）、§5.2 S8/S9、§5.6.3（`EEXIST` 行）、§5.4.5 |

**未采纳的 finding**：r2–r6 五轮共 34 项，全部有处置，无一项静默跳过（r5 行里提到的 `duplicateSources` 已在本轮被整体取消）。

### 11.6 第六轮（r7）改动记录

对象：第六版（2013 行，sha256 `fd1c23cb…`）。报告：`w13-reviewer-findings-r7.md`
（**BLOCKER 0 / MAJOR 2 / MINOR 0**，共 2 项）。本轮只做精修，**不扩协议**。

| finding | 处置 | 位置 |
| --- | --- | --- |
| **B1（MAJOR）** 恢复裁决顺序：`¬OW` 被放在队列/`TS` 判定之前 ⇒ `TS == parse-error` 时报 `session-claimed-elsewhere`（此时连 head/owner 都没有），而"补收据豁免"永远到不了；B21 四入口的期望输出与正文矛盾；分叉证据"本地必写 + 共享尽力"两处并存，后者没有 `OW`；§5.7 仍有"两 host 两行 attempt"残文 | **已改：把顺序本身写成契约。** ①§5.6.3 新增 **R0–R5 唯一裁决顺序**：R0 终态 → R1 `Q0` → R2/R3 算 `TS` 并**先出读侧码**（`manifest-unusable` 等，**此时不可能报 `session-claimed-elsewhere`**）→ R4 **无条件豁免**（补本机收据、本地诊断）→ R5 才适用 `OW`；②明确写"`OW` 的判定需要 head，因此不能排在算 `TS` 之前"、"豁免不是例外而是这一层根本不适用 `OW`"；③动作表改为**按 R0–R5 排列、行序即求值序**，并给每行加层号；④`OW` 清单固定为三项写共享的动作，**没有任何绕过 `OW` 的共享写**；⑤**§5.6.4 改为本期只落本地**（删掉共享 `chainfork/` 那一行，并从 §4.1 布局与字段表里移除），理由写成"`¬OW` 的全部意义就是不写共享字节，两者只能留一个"；⑥**B21 四入口重写**：`Bmiss`（非 owner 拒）/ 真创世（`GENESIS` 且确无世代，允许）/ **`GENESIS` 旧快照失效（必须先重算成 `UNIQUE` 再按 owner 拒）** / `manifest_published ∧ ¬R`（补本机收据，允许，且**另起一个"已合法发布只缺收据"的输入**，不复用未发布的 B）；⑦删掉 §5.7 的"两 host 各一行 attempt"残文，改写为"`sourceHostId` 区分'同一写者重试'与'另一写者的重复采集'，后者在 R5 被拒、不产生第 2 行" | §5.6.3（R0–R5 + 表重排）、§5.6.4（改本地）、§4.1、§4.3、§5.7、§8 B21 |
| **M7（MAJOR）** 分叉验收与单名空间不一致：以规范六位名构造 `g1,g2,g3` 并让 `g3` 前驱仍指 `g1`，对 `g3` 而言"前驱 generation 1 ≠ 3−1=2"，按 d1 应先判 `chain-broken`；若把前驱改成 `g2` 则是正常延长链却被写成 fork；`chain-fork` 的可达性未声明；§6.4 标题漏 D、§5.6.4 证据 `predicate` 仍写 C3 | **已改**：①§5.4.4 的 **d2 明确标注"本期不可达"并给出推导**（单名空间 + `predecessor.generation == g-1` 两条不变量下，两条 tip 需要"同代两文件"或"跳号"，前者被命名唯一性排除、后者被 d1 判 `chain-broken`），说明它只为 §5.12 多写者切片与排障保留；②**B15 重写为三输入**：前驱指 `g1` ⇒ **`chain-broken`**（d1）、前驱指 `g2` ⇒ **`UNIQUE`**（正常延长）、尝试造 fork ⇒ **不可达**；③B19② 同步改判 `chain-broken`；④**B8 写明测试层级**：其余 16 码有可构造输入，`chain-fork` **只按响应形状测**（本地合成状态），**不声称端到端可达**；⑤§6.4 标题与正文的 "A→B→C" 补成 **A→B→C→D**；⑥§5.6.4 证据的 `predicate` 由 `C3` 改为 **`d2`** | §5.4.4（d2 + 推导）、§5.4.4 四条性质第 3 条、§6.4、§5.6.4、§8 B8/B15/B19 |

**未采纳的 finding**：r2–r7 六轮共 36 项，全部有处置，无一项静默跳过。

### 11.7 第七轮（r8）改动记录

对象：第七版（2059 行，sha256 `3dfbd652…`）。报告：`w15-reviewer-findings-r8.md`
（**ACCEPT_WITH_FIXES：BLOCKER 0 / MAJOR 0 / MINOR 2**）。本轮**只做两处定点清理，不扩协议、不改判定表**。

| finding | 处置 | 位置 |
| --- | --- | --- |
| **MINOR B1**（B21 附加断言）"四入口输出码互不相同"与它自己的期望输出矛盾（①③ 均为拒绝、②④ 均先 `archive-pending`）；"跳过重算会产生两个 `g1` 并被 A2/d1 检出"也违反"固定同名独占发布" | **已改**：①断言改为"**每个输入结果唯一，允许不同输入同码**"，并点名 ①③ 同码、②④ 同码；②③ 的机制改成"必须先重算成 `UNIQUE`；**即使不重算就直接发布，`g000001.json` 固定同名的独占发布会 `EEXIST`，于是回 S3/S4 重读、再按 owner 被拒——不会出现两个规范 `g1`**"，并说明"两个同名文件在文件系统层面不可能共存，所以上一版那句 A2/d1 检出是错的" | §8 B21 |
| **MINOR M7**（旧示例与编号）§5.4.4 的示例表里"副本改成下一代且前驱指向**前一代**"被写成 ⇒ d2/`chain-fork`，与主判定表（d1 要求 `predecessor.generation == g-1`，连续前驱是正常延长）相反；B19 的断言栏把 fork 旁注误编为 **③**，与"坏 JSON 的 ③"重号 | **已改**：①该行改为"前驱指向前一代（连续）⇒ **d3 / `UNIQUE`**——这是**正常延长链**，不是分叉"，并注明上一版写反了、以及"要真分叉必须两条支挂同一前驱，而那在单名空间下不可构造"；②B19 里的两处旁注（近邻输入、fork 不可达）改为**不编号旁注**，不再占用条目编号 | §5.4.4 示例表、§8 B19 |
| §11 同步 | **已改**：上一轮（r7）处置表虽记录"已改"，但漏了上面三处；本轮把它们逐条补进本表，不留"已改却未改"的记录 | §11.7（本表）、§11.6 对照 |

**未采纳的 finding**：r2–r8 共**七轮**（逐轮条目见 11.1–11.7），全部有处置，无一项静默跳过。**这里不另给汇总数**：各轮表里既有 finding 行、也有子项与"顺带"行，靠加总容易再算错（上一版把七轮写成八轮就是这类笔误）；要总数请直接数各表，本文不再重复汇总。

### 11.7.1 r9 终审后的两处 NIT 修正（追加记录，不改写上面的核准状态）

终审 `w17-reviewer-findings-r9.md` 结论 **ACCEPT（BLOCKER 0 / MAJOR 0 / MINOR 0），另记非阻断 NIT 2**。
本轮只按原文措辞改两处，**未动任何判定表、契约或验收条目**，因此上面的核准状态与历史表都不改：

| NIT | 位置 | 改动 |
| --- | --- | --- |
| NIT-1 | §4.1 末尾的"fence 移出文件名"说明 | 原文称"人为复制/备份还原/篡改"可产生分叉并由 d2 检测；改为"当前会**先被候选错误门或 d1 判 `chain-broken`**；`d2` 是后续切片与排障的保留诊断码，**本期不可达**（推导见 §5.4.4）"。这样与 §5.4.4 d2 的"本期不可达"自洽 |
| NIT-2 | §11.7 末行 | "r2–r8 共八轮"是计数笔误，改为"共**七轮**"，并**删掉汇总数**——各轮表里混有 finding 行与子项行，加总容易再错（本文不再给汇总数，总数请直接数 11.1–11.7 的表） |

审查方明确这两项"不重开 M7、不要求协议层修订"；本文按此执行，**不因此声称任何实现或实机验收**。

### 11.8 截至 r8 的历史核准状态（最新核准见 §11.7.1 的 r9 与 §11.9 的 r10–r12）

**本节是截至 r8 的历史快照，不再自称"唯一核准出处"。** 表头里的"r8（最近一轮）"只表示
**本节这张表的时间切片到 r8 为止**，不代表文档当前状态；当前状态见 §11.9。下表内容照抄不改写。

| finding | r3 | r4 | r5 | r6 | r7 | r8（最近一轮） |
| --- | --- | --- | --- | --- | --- | --- |
| B1 | 未解决 | **部分解决** → 结构已修（不接管、全局 generation、前驱三元组、唯一 tip），但**初领仍不互斥**；本轮补 claim | **部分解决** → 固定 claim 已修一半；r5 延长了延迟领取反例。**本轮按范围收窄改写**，待复审 | **部分解决（降为 MAJOR）** → 结构修复成立，但恢复表绕过 S4；本轮加 `OW` 闸门，待复审 | **部分解决（仍 MAJOR）** → 原反例已被 `OW` 拦死，但顺序与豁免互斥；本轮改为 R0–R5，待复审 | **部分解决（核心已解决，残文降为 MINOR）** → 仅 B21 两句断言；本轮清理，待复审 |
| B2 | 已解决 | 维持已解决 | 维持已解决 | 维持已解决 | 维持已解决 | 维持已解决 |
| M1 | 已解决 | 维持已解决 | 维持已解决 | 维持已解决 | 维持已解决 | 维持已解决 |
| M2 | 部分解决 | **部分解决** → 创世 schema 与收据/链包含已修，发布步骤与恢复状态仍不闭合；本轮重排 S0–S13 | **部分解决** → 仍缺 `link` 成功后的崩溃行、终态顺序、队列字段；本轮补齐，待复审 | **部分解决（降为 MINOR）** → 与落盘口径/步骤编号冲突；本轮重写 §5.6.1，待复审 | **已解决** | 维持已解决 |
| M3 | 部分解决 | **已解决** | 维持已解决 | 维持已解决 | 维持已解决 | 维持已解决 |
| M4 | 已解决 | 维持已解决 | 维持已解决 | 维持已解决 | 维持已解决 | 维持已解决 |
| M5 | 部分解决 | **已解决** | 维持已解决 | 维持已解决 | 维持已解决 | 维持已解决 |
| M6 | 部分解决 | **部分解决** → 索引缺失分支/多 source/离线语义已修，域级 tip 仍不存在；本轮删掉 | **部分解决（降为 MINOR）** → 域级 tip 已删，但留了与主判据冲突的捷径句；本轮删除，待复审 | **已解决** | 维持已解决 | 维持已解决 |
| M7 | 部分解决 | **部分解决** → 结构/存在性分离与词表已修，判定优先级与未知态路由未闭合；r4 重写为 A→B→C 并接入 §6.5，r5 再加候选错误门并把码数改为 17 | **部分解决** → 候选错误门与码数映射仍未闭合；本轮重写并降为 17 码，待复审 | **部分解决** → 版本谓词与 fork 验收仍不一致；本轮统一为 `==1` 并重写可构造分叉，待复审 | **部分解决（仍 MAJOR）** → fork 输入会先命中 d1；本轮改判并声明 fork 不可达，待复审 | **部分解决（核心已解决，旧示例降为 MINOR）** → §5.4.4 一行旧示例与 B19 编号；本轮清理，待复审 |
| M8 | 部分解决 | **已解决** | 维持已解决 | 维持已解决 | 维持已解决 | 维持已解决 |
| M9 | 已解决 | 维持已解决 | 维持已解决 | 维持已解决 | 维持已解决 | 维持已解决 |
| M10 | 未解决 | **已解决** | 维持已解决 | 维持已解决 | 维持已解决 | 维持已解决 |
| N1 / N2 | 已解决 | 维持已解决 | 维持已解决 | 维持已解决 | 维持已解决 | 维持已解决 |
| NIT | 已解决 | 维持已解决 | 维持已解决 | 维持已解决 | 维持已解决 | 维持已解决 |

**本轮未做、也不声称的事**：未运行任何测试、未做实机存储语义验证、未改其它文件、
未决定任何私有部署输入。审查报告中标注为"未验证"的事项（#35 正文、真实 NAS 上的
`link`/`fsync`/`flock`/`O_EXCL` 语义、provider 写侧语义、ACL 组成员与祖先穿越权限）在本文中
仍标为未验证，**没有**被写成已验证。

### 11.9 r10–r12 增量确认（最新核准状态）

**三轮增量确认的对象与结论（照抄审查报告，不改写）：**

| 轮 | 对象 | 结论 |
| --- | --- | --- |
| r10 | 2087 行 / `83c10ec58b448a3474fa8bfd29421c202445e172365b813f44ad557561a8b9f4` | ACCEPT 0 BLOCKER / 0 MAJOR / 0 MINOR + NIT 1（报告 `w19-reviewer-findings-r10.md`） |
| r11 | 2105 行 / `11863f2dc6f38ea7370252172000c38312d64473eb05e9fe135182384a2864b2` | ACCEPT 0 BLOCKER / 0 MAJOR / 0 MINOR + NIT 1（报告 `w21-reviewer-findings-r11.md`） |
| **r12** | **2106 行 / `b52147010f8208d6166c9da19a1b2400923ff37bb08721ede8c1e3bf93b9df0d`** | **ACCEPT 0 BLOCKER / 0 MAJOR / 0 MINOR / 0 NIT**（报告 `w23-reviewer-findings-r12.md`） |

**交付字节 = 最后一次增量确认所核准的那份字节；它的行数与 sha256 记录在该次审查报告
（`w2x-reviewer-findings-rNN.md`）以及私有归档的 `INDEX.md` / `MANIFEST.sha256` 中，不在本文内嵌。**
本文不内嵌自身最终摘要，是因为写入摘要会改变字节（自指），任何写法都会在写下的瞬间失效——
这是**故意的、已知的性质**，不是遗漏。r10–r12 三行是历史增量（各自核准当时的字节），
它们的摘要可以内嵌，因为后续修订已把它们变成历史。

**本节自身的增量说明**：本节记的是 r10–r12 的历史核准轨迹。r12 之后的导航修订由**后续增量确认**核准；
该次确认的对象摘要与结论记录在**该次审查报告**（文件名见归档 `INDEX.md`），交付字节的最终 sha256
也只记录在那里与 `MANIFEST.sha256`。本文不重复这个数字，理由见上（自指）。

| 项 | 内容 |
| --- | --- |
| 审查报告 | `w19-reviewer-findings-r10.md`（r10）、`w21-reviewer-findings-r11.md`（r11）、`w23-reviewer-findings-r12.md`（r12） |
| 结论 | 三轮均 **ACCEPT；BLOCKER 0 / MAJOR 0 / MINOR 0**；r10、r11 各另记非阻断 NIT 1，r12 无 NIT |
| 审查对象 | 见上表：r10–r12 各自的对象摘要可内嵌（已是历史）；**交付字节的摘要不在本文内嵌**（见上：自指性质） |
| 审查范围（r10 报告的范围） | **未重开协议审查，只做增量确认**：复核 r9 两处 NIT 的落地（§4.1 的 d2 不可达表述、§11.7 的轮次计数）并抽查关键契约（§5.4.4 的 d1 优先 / d2 不可达 / d3 `UNIQUE`、§5.6.3 的候选错误门先于本地补收据再由 R5/`OW` 约束共享写、§8 B19/B21 的不编号旁注与同码允许） |
| 已关闭的遗留 | r10 的 NIT 1（§11.8 标"最近一轮 r8"、开头称其"唯一核准出处"）已在 r11 前修正；r11 的 NIT 1（§11 导语仍写"只有 11.8 能说明是否核准"）已在 r12 前修正。**r12 无遗留** |
| 不声称 | 审查方明确"本次非全文逐字 diff，不把抽查扩大为全部字节未改证明"；真实存储与实现验收**仍未验证**，本文不因此声称任何实现或实机验收 |

---

## 附录 A：本文引用的代码位置（供复核）

```text
orca/docs/reference/agent-session-search-contract.md:99-105
orca/docs/reference/ssh-execution-boundary.md:14
orca/src/main/ai-vault/claude-project-dir-encoding.ts:14-21,23-34
orca/src/main/ai-vault/omp-session-root.ts:37-60
orca/src/main/ai-vault/session-delete.ts:105-112
orca/src/main/ai-vault/session-scanner-agent-sources.ts:26-29,44-47,105-118,216-222,225-238
orca/src/main/ai-vault/session-scanner-muse-paths.ts:5-6
orca/src/main/ai-vault/session-scanner-roots.ts:8
orca/src/main/ai-vault-search/session-search-database-path.ts:5-12
orca/src/main/ai-vault-search/session-search-degraded-roots.ts:18-24
orca/src/main/ai-vault-search/session-search-instance.ts:74-76
orca/src/main/ai-vault-search/session-search-retention-policy.ts:6-12
orca/src/main/ai-vault-search/session-search-schema.ts:8-11,54-79
orca/src/main/artifacts/artifact-create-intent-store.ts:76,221-224
orca/src/main/artifacts/artifact-publisher.ts:43-50
orca/src/main/claude-usage/store.ts:63-67
orca/src/main/claude-usage/worktree-attribution.ts:27-77
orca/src/main/codex-usage/store.ts:70-72
orca/src/main/codex-usage/types.ts:17-32
orca/src/main/daemon/daemon-private-file-modes.ts:1-4
orca/src/main/daemon/daemon-pty-checkpoint-persistence.ts:69-72
orca/src/main/daemon/history-manager.ts:257-272,274-283
orca/src/main/daemon/history-paths.ts:1-7,6
orca/src/main/daemon/pty-session-id.ts:21-26
orca/src/main/daemon/terminal-history-metadata.ts:8-15
orca/src/main/daemon/terminal-history-session-files.ts:6-11
orca/src/main/daemon/terminal-history-session-tombstone.ts:90-101
orca/src/main/ipc/pty/host-env/assembly.ts:198
orca/src/main/ipc/worktrees/removal/worktree-removal-ownership.ts:96
orca/src/main/native-chat/session-file-resolver.ts:44-51,113-129
orca/src/main/orcad/orcad-entry.ts:365-371
orca/src/main/persistence/loading-store/task-run-history-persistence.ts:24-67,92-99
orca/src/main/persistence/loading-store/terminal-session-cleanup.ts:27-38,35-38
orca/src/main/persistence/loading-store/workspace-session-snapshot-publication.ts:104
orca/src/main/terminal-history-deletion.ts:137,158,317-340,318-321
orca/src/main/terminal-history-gc.ts:24,57-95,71-81,83-89,159-162
orca/src/main/terminal-history-id.ts:3-5
orca/src/main/terminal-history-paths.ts:8,12-14
orca/src/main/terminal-history.ts:70-80,120-127
orca/src/shared/agent-hook-spool.ts:53-97,143-163
orca/src/shared/ai-vault-resume-command.ts:30-38,123
orca/src/shared/ai-vault-search-contract.ts:83-94,124-129
orca/src/shared/native-chat-agent-support.ts:3
orca/src/shared/task-run-history.ts:3-19,24-40,60-65,80-82
orca/src/shared/worktree/archive-hook-removal-gate.ts:1-17,24-33
swarm/coordinator_driver.py:101
swarm/coordinator_io.py:28-30,33-34,63-66,118-124,212-215,247-253,256-261,264-276,267,273,279-305,308-320,323-324,327-382,415-424
swarm/coordinator_launch.py:101-102
swarm/docs/design/delivery-ledger.md:95
swarm/docs/design/task-workbench/README.md:4
swarm/evidence_archive.py:22-37,36,76,81-82
swarm/log_io.py:24-36
swarm/pi_transcript.py:31-34,44-57,58-60,79
swarm/release_radar/storage.py:1-5
swarm/supervisor/receipts.py:43-52
swarm/swarm_ledger/ledger.py:40-41,50-66,315-336
swarm/swarm_ledger/raw_usage.py:42-48
swarm/swarm_ledger/trae_jsonl.py:20-23,38-40
```

## 附录 B：术语与占位符

| 记号 | 含义 |
| --- | --- |
| `<archive-root>` | 共享存储的挂载根（NAS 或等价）；本机由部署配置注入，仓库内不写真实值 |
| `<local-cache>` | 读侧本地缓存目录与索引快照（派生、可随时全删） |
| `<local-state>` | 本机私有状态目录（含待上传队列、提交收据、保护引用） |
| `<host-a>` / `<host-b>` | 两台执行主机，仅在验收矩阵里出现 |
| 授权域（domain） | `<repoId>/<itemType>/<number>/` 或 `_unlinked/`；ACL 与 blob 去重的边界 |
| blob | 内容寻址的不可变字节块，名即 `sha256`；域内去重 |
| 世代（generation） | `g<generation>.json`；`generation` 全局单调，是**链上位置**也是**唯一名字** |
| fence | 租约的单调身份；文件里用来**归因与检测分叉**，不用于裁决 head |
| predecessor | `{fence, generation, manifestSha256}`；上一世代的三元组，是链的唯一连接 |
| tip | 没有任何后继引用它的世代；恰好一条才叫健康链，两条以上是 `chain-fork` |
| head | 健康链的唯一 tip；`chain-fork`/`chain-broken` 时**没有 head** |
| 提交收据 | 本机 `archive-receipt/<requestId>.json`：证明"我提交了哪一代"，不随后续追加失效 |
| 保护引用 | 本机 `archive-protect/<digest>.json`：删除路径必须先读它 |
| 身份键 | `(provider, sessionId)`，决定 manifest 目录名 |
| 寻址键 | `(archivalGroup, worktreeId, sessionId)`，决定用户如何找到它 |
| requestId | 一次归档请求的稳定标识，含 `sourceHostId`；同 host 重试幂等、跨 host 是两次采集 |
