VERDICT: AGREE-WITH-EDITS

1. 对合并清单的意见

- M2-C1：同意，且必须阻塞 M3。basename+offset 已被确认会在 base→.1 后把旧 offset 套到新 base，并整体跳过 .1 中未回放行；这是 M2 shadow/reconcile 核心正确性问题。
- M2-C2：同意，且必须阻塞 M3。normal write / DB insert / shadow replay 三条路径只要有一条绕过 evidence sanitize，就会把 replay/自报变成脱敏旁路。
- M2-C3：同意，且必须阻塞 M3。capacity_limited 的噪声行不能挡住后续 crash；否则“crash 豁免容量闸”在 replay 顺序上失效。
- M2-C4：同意，且必须阻塞 M3。reconcile stopped/failed 若只在 warn/meta 里，`list` 空结果会误导为“没有事故”，违背 coverage 语义。
- M2-C5：同意，但建议拆清阻塞口径：CLI source-id 去重提示与 evidence 大小/流式上限是 M2 必改；“路径本身可能敏感”至少需文档回写，代码层是否做相对化/遮盖可随 C2 sanitize 策略一次确定。
- M2-C6：同意，但不要求 M2 做完整异步 replay 或 UI 进度；M2 前置条件是有每进程硬字节/行数预算、可续跑且水位不倒退，并把本次耗时/行数/是否 incomplete 暴露到 coverage/meta。

2. 我原评审中未被合并项的处理

- O_APPEND 并发与 partial line：同意降级为“已排除 + 保留回归”。complete-line 才推进水位的设计可接受；轮转问题已由 C1 覆盖。
- startup attempt-once、no userData/store unavailable、cache reset 不每次 onPtyExit 重开：同意不列必改；C4/C6 已覆盖可见性和成本缺口。
- IPC/preload channel whitelist：同意延后到真正 UI/M3+，M2 维持 preload 窄入口即可。
- SSH/远端宿主事实：同意延后/保持 unsupported；M2 不应扩展远端判定。
- evidence symlink/raw path 细节：同意并入 M2-C5/C2，不单列阻塞项；关键是大小上限、去重提示、路径敏感边界与 sanitize 一致。
- report/detail 渲染 raw evidence 的担忧：同意并入 C2/C4；若 DB 内已统一 sanitize，渲染层只需避免重新暴露原始未清洗字段。

3. M2-C1 方案选择

支持 (a) shadow 行加单调 seq：seq 与文件名、inode、rename/copy/delete 都解耦，replay 可扫描全部现存文件并只接受 `seq > lastSeq`，重复扫描由 DB UNIQUE 兜底，比文件身份指纹更跨平台且更容易证明“不漏、不倒退”。
