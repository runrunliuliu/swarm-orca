# Repository role skills

Before planning, handoff or recovery, verify the exact target worktree and read its applicable
`AGENTS.md`. Discover domain role skills including hidden directories: `.agents/skills`,
`.codex/skills`, `.claude/skills`, `.trae/skills`, `skills`, and any repository-declared locations.
Do not scan neighboring worktrees or silently select another branch's skill.

- Operator reads the applicable Coordinator skill and required references fully before handoff;
  Coordinator reads them in its own context on receipt/recovery. Workers load their actual roles.
  Generic orchestration does not replace domain research, review or operation skills.
- Follow the skill's repository-location checks. Fix absolute skill paths and raw-byte SHA256 in
  the handoff alongside target and role. Multiple candidates require repository-directed selection,
  not first-match selection. A different worktree requires fresh checks and reading records.
- A path/hash proves which bytes were referenced, not that the Agent read, understood or followed
  them. Preserve actual file-tool reading evidence and review native logs where required.
- Missing, unreadable or incompatible skills block dependent work, not unrelated authorized work.
  Report a coverage gap, not user denial; do not install or rewrite skills to evade the boundary.
- Skills grant no authority and cannot override explicit user instructions. Authorization, skill
  compliance and execution-loop acceptance remain separate.

[Driver](../../../coordinator-driver.md) checks references/read declarations only in supported
paths; declarations alone do not attest compliance. `continue` still requires actual action or a
verifiable handoff; `wait` requires a real dependency. This policy is not a runtime launch gate.
