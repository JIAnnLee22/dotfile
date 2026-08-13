# 工具速查

本机通过三个扩展包扩展了内置工具（settings.json `packages` 字段）。官方内置工具完整清单见当前会话系统提示的工具列表，以下按来源分组。

## 内置工具

| 工具 | 用途 | 备注 |
|------|------|------|
| `read` | 读文件（文本/图片） | 大文件用 offset/limit |
| `bash` | 执行命令 | 文件操作首选，比 cat/ls 更直接 |
| `write` / `edit` | 创建/改写文件、精确替换 | edit 支持同文件多处不重叠修改 |
| `ffgrep` / `fffind` | 内容/路径模糊搜索 | 见下方 @ff-labs/pi-fff |
| `web_search` 等 | 网络搜索与内容抓取 | 见下方 pi-web-access |
| `ctx_*` | 上下文管理 | 见下方 context-mode |
| `parallel_tasks` | 并行只读调研（probe/analyst/verifier 角色） | 子任务必须自包含、只读 |
| `plan_question` / `plan_submit` / `plan_step_complete` / `plan_blocked` | 计划模式四件套 | plan 模式工作流 |

## @ff-labs/pi-fff（v0.10.3）

FFF 模糊搜索，是定位代码的首选工具，git-aware + frecency 排序。

- `ffgrep <pattern>`：内容搜索。支持 `path` 限定目录/文件名/glob、`exclude` 排除噪音（如 `test/,*.min.js`）、`caseSensitive`、`context`、`limit`/`cursor` 分页。
- `fffind <pattern>`：按整个路径模糊匹配。多词为 AND 收敛；精确文件名用 `path: '**/name.ext'`；列目录用 `path: 'dir/**'`。
- 技巧：先用 fffind 定位文件再 read；grep 命中后直接读 top match，不要连环 grep；bare 标识符（无正则元字符）查询最有效。

## pi-web-access（v0.22.0）

网络访问全家桶：搜索、抓取、PDF/视频提取、来源核验。当前会话可见：`web_search`、`source_check`、`fetch_content`、`get_search_content`。

- `web_search`：多查询变体（queries 数组，2-4 个不同角度）、多 provider（auto/all/指定）、`includeContent` 后台抓全文、`recencyFilter`/`domainFilter`。
- `source_check`：用结构化来源证据核验断言，返回带引用的研究工件。
- `fetch_content`：抓 URL（readable/raw/answer 模式）、GitHub 仓库、YouTube 转录、本地视频帧提取。
- `get_search_content`：按 responseId 检索之前搜索/抓取的内容，用 findText 定位段落。

## context-mode（npm 包 + skills）

上下文管理：把大输出留在沙箱/知识库，只把摘要带回对话。对应 skills：`context-mode`、`ctx-doctor`、`ctx-index`、`ctx-search`、`ctx-stats`、`ctx-purge`、`ctx-upgrade`、`ctx-insight`。

- `ctx_execute` / `ctx_execute_file`：沙箱执行代码处理大输出（日志分析、聚合统计），只 print 结论。
- `ctx_index` / `ctx_fetch_and_index`：文档/URL 持久化进 FTS5 知识库。
- `ctx_search`：BM25 + 词干/trigram 混合排序检索，支持 session memory 时间线。
- `ctx_batch_execute`：批量命令 + 自动索引 + 内联查询一次往返。
- `ctx_stats` / `ctx_doctor` / `ctx_upgrade` / `ctx_purge` / `ctx_insight`：统计、诊断、升级、清库（破坏性，需 confirm）、看板。
- 触发词：分析日志、总结输出、处理数据、解析 JSON、构建输出、测试输出、git log、依赖分析等场景优先用 ctx_* 而不是直接 read。

## 场景选型

| 需求 | 选型 |
|------|------|
| 找文件/符号 | fffind → read |
| 找内容/调用点 | ffgrep（exclude 噪音） |
| 多块独立调研 | parallel_tasks |
| 大输出分析 | ctx_execute / ctx_execute_file |
| 文档长期记忆 | ctx_index / ctx_fetch_and_index |
| 网页资料/事实核验 | web_search / source_check / fetch_content |
| 官方语义确认 | docs 目录 + 已装包源码（`~/.config/pi/npm/node_modules/`） |
