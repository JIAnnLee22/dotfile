---
name: pi-workflow
description: pi coding agent 工作流强化说明。工作流增强由 extension 默认注入；本 skill 仅在用户手动 /skill:pi-workflow 时加载，用于查看约定。
disable-model-invocation: true
---

# Pi Workflow

## 工作方式

- 默认优先使用 `repo_search` 定位代码和配置。
- 需要外部资料、最新信息或官方文档时，使用 `web_search`。
- 修改文件前先阅读上下文，尽量做最小改动。
- 计划模式需要用户手动通过 `/plan` 开启。
- 计划模式下不要编辑或写入文件。
- 执行阶段优先使用 `repo_search` + `read` + `write/edit` 组合。

## 约定

- 搜索：先仓库内，后网页。
- 规划：先整理成步骤，再进入执行。
- 修改：只改必要文件，避免连带改动。
- 保护：遇到 `.env`、`.git`、`node_modules` 等敏感路径要谨慎。

## 备注

该 skill 不再自动进入模型上下文；默认工作流由 `extensions/workflow.ts` 注入。需要查看完整约定时，手动执行 `/skill:pi-workflow`。
