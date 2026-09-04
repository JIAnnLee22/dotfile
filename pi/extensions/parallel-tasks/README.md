# parallel-tasks

在当前 pi 会话中并行执行多个**互不依赖的子任务**，全部子任务结束后将结果汇总回主会话，由主会话统一整合、落地。

子任务分两类：

- **只读角色**（`probe` / `analyst` / `verifier` / `reviewer`）：在仓库中调研、定位、核验、审查，不改文件。
- **写角色**（`implementer`）：在**隔离的 git worktree** 中写代码、跑测试，产出 diff 交回主会话审查合并。

## 使用方式

直接在会话中说明并行意图即可，例如：

> 同时排查前端登录调用点和后端 token 校验逻辑，两个方向互不依赖。

主代理会调用 `parallel_tasks`：

```json
{
  "tasks": [
    { "role": "probe", "label": "前端调用点", "task": "在 src/web 下定位所有登录请求和 token 使用点，返回路径与行号。" },
    { "role": "analyst", "label": "后端校验流程", "task": "分析 src/server/auth 下 token 校验流程，说明调用链、失败分支和证据路径。" }
  ]
}
```

也可以派发独立编码子任务：

```json
{
  "tasks": [
    { "role": "implementer", "label": "A 模块测试", "task": "为 src/a/utils.ts 补单元测试，只改 src/a/ 下的文件，运行 node --test src/a 验证。" },
    { "role": "implementer", "label": "B 模块测试", "task": "为 src/b/parse.ts 补单元测试，只改 src/b/ 下的文件，运行 node --test src/b 验证。" }
  ]
}
```

也可以执行 `/parallel-roles` 查看角色列表。

## 角色

- `probe`：快速定位文件、符号、调用点，返回路径和行号。
- `analyst`：分析模块机制和调用链，返回带证据的结论。
- `verifier`：核验一个具体假设，返回「成立 / 不成立 / 证据不足」。
- `reviewer`：代码审查，返回分档（缺陷 / 风险 / 建议）意见。
- `implementer`：在隔离 worktree 中写代码、跑测试，返回结论 + diff。

角色定义在 `roles/*.md` 中，插件启动时读取。

## 安全和隔离

- 每个任务运行在单独的 pi 子进程中，有独立上下文，不会共享其他子任务的对话。
- 子任务禁用自动扩展发现，避免递归调用 `parallel_tasks`。
- 只读角色：`write` / `edit` 被禁用并由 `readonly-guard.ts` 再次拦截；`bash` 用只读命令白名单，拒绝重定向、管道、命令拼接、解释器与写入类命令。
- `implementer` 角色：运行在 `git worktree add --detach <tmp> HEAD` 创建的隔离目录中，与主仓库和其他并行任务文件级隔离；`write-guard.ts` 拦截越出 worktree 的写入、危险命令（rm -rf 根目录、dd、sudo、curl/wget、远程 git 等）。主仓库的未提交改动不会进入 worktree。
- 子任务不会直接改主仓库；`implementer` 的改动以 diff 形式返回，由主会话审查后用 `git apply`（或逐文件）落地。
- 最多 8 个任务，最多同时运行 4 个。

## 结果整合

返回内容包含每个任务的状态、任务描述、最终结论、工具统计，`implementer` 还附带 diff 与改动文件列表，并附整合要求。主会话需要合并共识、标记矛盾、保留证据不足项、审查并应用 diff，然后再落地文件修改。

## 不适用场景

有先后依赖的工作（例如先定位、再基于定位修改）、会改同一批文件的多个写任务、只有一个很小的 grep 问题，都不要使用该工具。
