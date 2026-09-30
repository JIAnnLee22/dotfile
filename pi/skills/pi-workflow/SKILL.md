---
name: pi-workflow
description: pi coding agent 工作流约定。用户手动调用 /skill:pi-workflow 时加载；按已安装工具选择计划、搜索、并行与自主循环。
disable-model-invocation: true
---

# Pi Workflow

- 先用 `fffind` / `ffgrep` 查找文件和符号，随后 `read` 核对上下文；最新资料用 `web_search`。
- 大输出优先在 `ctx_execute` / `ctx_execute_file` 中汇总；它们可以写宿主，不应当作只读沙箱。
- 需要人工审阅计划时使用社区包 `/plan`，批准后才实施；要自动实施时必须明确用 `/plan-auto`。
- 长期自主任务可用 `/loop start <目标> --check "<命令>" --until-done --max 50`，不能把模型自称完成当作验证。
- 独立子任务用社区 `subagent` 工具；实施任务设置 `isolation: "worktree"` 并在落地前检查 diff。
- 仅改必要文件，保护凭据与非任务范围内的未提交改动。

工具与包版本以 `settings.json` 为准；此 skill 不自动注入。
