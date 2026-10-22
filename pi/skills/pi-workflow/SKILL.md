---
name: pi-workflow
description: pi coding agent 工作流约定。用户手动调用 /skill:pi-workflow 时加载；按已安装工具选择人工审批计划、搜索与并行任务。
disable-model-invocation: true
---

# Pi Workflow

- 先用 `fffind` / `ffgrep` 查找文件和符号，随后 `read` 核对上下文；最新资料用 `web_search`。
- 大输出先在 `bash` 内汇总；需要工具编排时可用 `pi --tools +codemode` 按需启用内置能力，不建立额外持久知识库。
- 需要人工审阅计划时使用社区包 `/plan`，通过 `/plan-approve current|new` 批准后才实施。自动批准已关闭，不使用 `/plan-auto`、`/goal` 或自动 review/fix flow。
- 当前不启用自主循环；任务完成以实际检查结果为准，不把模型自称完成当作验证。
- 独立子任务用社区 `subagent` 工具；实施任务设置 `isolation: "worktree"` 并在落地前检查 diff。
- 仅改必要文件，保护凭据与非任务范围内的未提交改动。

工具与包版本以 `settings.json` 为准；此 skill 不自动注入。
