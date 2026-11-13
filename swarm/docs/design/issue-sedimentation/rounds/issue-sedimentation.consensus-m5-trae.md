VERDICT: AGREE

## 1. 对合并清单的异议

无异议。M5-C1 到 M5-C9 都属于 M5 内必须收敛的问题，修完再进 M6：

- C1/C2 是 acceptance 作为“门”的基本语义；遗漏消费点或读掉 unread 都会让 resolve 失效。
- C3/C4 是 fail-closed 与零副作用边界；不能把 store 故障当 no_rules，也不能让无声明路径创建库。
- C5 是本机命令执行安全边界；`--cwd` 不能任意指向宿主路径。
- C6/C7 是长期运行可观测性和规则版本一致性；否则 attempts 噪声与旧 verdict 会误导。
- C8/C9 是运维可用性和回归证据；尤其 rejected 文案必须修。

文档回写项也同意，§8 必须明确 gate 覆盖、override 政策、store 故障和 cwd 授权。

## 2. 原评审未被合并项

同意降级/延后。

- 我提到的 `--expect-stdout` ReDoS 风险已由源码确认是 substring includes，不是正则；无需保留。
- 多规则串行执行可接受，不作为 M5 阻断项。
- `resolve --accept` 不直接 settle 可接受，只要 C2 保证后续重跑可靠，并在文档/CLI 写清依赖 coordinator tick。
- `dispatch-acceptance-run.test.ts` real argv 偶发失败我未复现；可作为环境敏感测试观察，不列入必改。若再现，应记录 Node 可执行路径、cwd、stdout match 与退出码。

## 3. M5-C1 override 选择

我倾向 (a) 所有旁路都接 gate。

理由：acceptance 的产品语义是 settlement gate；若保留默认 override，即使显式标记，也会让“声明了验收”的 dispatch 在部分路径下被完成，值班很难判断哪个完成可信。对既有测试的影响是需要把直接完成/decision gate/task terminal update 测试改为经过 gate，或新增明确的 manual override 测试；这比长期维护两套完成语义更安全。
