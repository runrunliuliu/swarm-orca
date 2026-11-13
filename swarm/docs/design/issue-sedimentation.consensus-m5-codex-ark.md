VERDICT: AGREE-WITH-EDITS

1. 反对/范围：
- 不反对 M5-C1..C9；它们都属于 M5 前置的安全边界、门点覆盖与 owner 可见性修复。
- 编辑 C1：所有 worker_report 入口必须进同一 gate；非 worker_report 的人工终态、decision-gate、底层维护结算可作为 manual override 保留，但必须显式 `--override-acceptance`/API 字段、审计可见，并在 CLI/文档标明绕过 acceptance。
- 编辑 C4：零副作用指无声明热路径不创建/迁移 incidents DB、不写 meta；只读 existence lookup 可以接受。
- codex 原报的 real-argv vitest 失败不作为产品缺陷合并：外层未复现，且该用例依赖真实 child stdout/runner 环境，按非 hermetic/flaky 处理；若保留，应改 stub runner 或打印 stdout/stderr 捕获诊断。

2. 原评审未合并项：
- `acceptance list` 每行混入全量 rules：同意降级到 C8/C9 的 CLI 可读性修复；若改 formatter 可顺手修。
- evidence/repro 指针与归档级证据：同意延后到 M6。
- `ACCEPTANCE_ATTEMPT_EPOCH=1`：同意延后，但需在文档/测试固定 “dispatch id == attempt identity” 不变量。
- env 继承、串行规则、`resolve --accept` 不直接 settle：同意延后/接受；前提是 C2/C5/C8 修好。

3. M5-C1 manual override 选择：
- 倾向 (b)：非 worker_report 旁路保留 override，但必须显式 `--override-acceptance` 且审计；所有 worker_report 路径不许 override，必须 gate。
- 理由：acceptance 是 worker 报告验收门，不应意外拦截 operator 明确终态/维护恢复；但默认旁路会破坏声明可信度，所以必须 opt-in 可见。
- 测试影响：现有 direct complete/update/decision-gate 用例要拆成“无 override 被挡/有 override 通过”，底层单元测试使用显式 bypass helper 或 fixture 标注。
