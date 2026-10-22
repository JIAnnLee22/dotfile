# 本地 TPS 扩展

来源：[@monotykamary/pi-tps](https://github.com/monotykamary/pi-tps) `1.3.16`，MIT 许可证见 `LICENSE`；原始上游说明见 `README.upstream.md`。本地实现由此配置仓库维护，不通过 npm 更新。

Pi 自动发现 `extensions/tps/index.ts`，无需安装额外依赖。修改后执行 `/reload`，不要同时启用 npm 版 TPS。

## 默认显示与命令

保留 Pi 默认 footer，每 1000 ms 刷新扩展状态；结束后保留最终速率，不自动弹出通知。默认采用极简单值：**醒目的速率数字 + 弱化的 tok/s 单位 + 状态符号**，不显示 TPS 前缀、TTFT、输出量或图表，不增加独立面板。数值加粗、单位降低强调，沿用终端自身配色，不硬编码颜色；切换主题后也不会遗留旧主题色。

```text
◌ — tok/s
● ~42.0 tok/s
✓ 40.0 tok/s
```

状态：`◌` 等待首个输出，`●` 生成中，`◷` 等待流式更新，`◇` 执行工具，`✓` 完成，`○` 不可计量，`×` 中断/失败。状态由实际生命周期决定，不按速率快慢染色；详细状态与指标通过 `/tps` 查看。

- `/tps`：查看当前生成或当前分支最近一次生成的完整详情。
- `/tps full`：主动展开诊断页脚，显示 TTFT、输出量、实时 1s/3s、端到端、峰值、总耗时、输入/缓存、停顿、工具时间和费用；结束后显示可保留的最终指标。
- `/tps compact`：恢复极简单值。

显示模式只在当前扩展运行期间有效，重载后恢复 compact。窄终端可能截断状态栏，可用 `/tps` 查看未截断的详情；不替换其他插件的 footer。

## TPS 统计口径

采用客户端常用的**输出 token / 生成秒数**，实时与最终使用同一时间口径：

- 生成时间从每条 assistant 消息的**首个非空内容 delta 到 `message_end`**累计；识别文本、思考和工具参数 delta，不把空的块开始/结束事件当作首 token。
- **排除 TTFT 和工具执行时间，但不扣除生成过程中的停顿。**网络卡顿或服务端暂停会降低 TPS；不能仅凭流式间隔还原 GPU 的净推理时间。
- 不再使用上游的停顿扣除、TTFT 回退分母或依赖历史记录的工具调用限速。
- TTFT 为 `turn_start` 到首个非空内容 delta；工具执行期间生成 TPS 保持不变，端到端速率继续随总耗时变化。
- 最终 token 数使用服务端 `usage.output`，包含其上报的思考/工具 token；实时未上报用量时使用 Pi 的 `estimateTokens()` 并标 `~`，最终校准后可能变化。
- 少于 2 次有效更新、流式跨度不足 200 ms、生成时长不足 200 ms，或异常高于 10,000 tok/s 时显示 `—`，不将突发交付伪装成可靠推理速度。

这是**单轮、客户端观测的生成平均值**，不是会话平均或服务器硬件测速。生成速率与 TTFT 分开，与 [Ollama 的输出 token / 生成耗时](https://docs.ollama.com/api/usage) 采用相同的指标划分，但 Pi 没有服务器端 `eval_duration`，无法保证数值相同；也不将它等同于采用 `(N-1)` 的 TPOT 倒数或并发系统总吞吐量。

## 诊断指标

| 指标 | 口径 |
| --- | --- |
| `1s` / `3s` | 最近约 1 秒 / 3 秒的内容增量估算，始终标 `~`；采样从首个内容 delta 开始，不混入 TTFT，生成停顿时降至 0 |
| `e2e` | 输出 / `turn_start → turn_end`；包括首字等待和本轮工具执行 |
| `peak` | 近 1 秒采样速率的最高值，标 `~`；不足可靠采样区间时为 `—`，不是瞬时硬件峰值 |
| 缓存命中 | `cacheRead / (input + cacheRead + cacheWrite)`；分母未知/为零时不显示百分比 |
| 停顿 | 内容更新间隔达到 500 ms 的总时长和次数；仅诊断，不从 TPS 分母扣除，不含 TTFT 和工具时间 |
| 工具时间 | 本轮执行区间的并集；并行/嵌套工具不重复累加 |
| 费用 | 优先 Neuralwatt 账单，否则模型目录估价；无价格时 `—`，费用来源不重复相加 |

窗口采样始终使用内容估算，不会把最后一次服务端用量校准误判成峰值。估算受语言、隐藏思考、工具参数和分词器影响，不等于实际 token 数；历史仅保留滑动窗口所需的少量采样点。

## 遥测、历史与导出

保留 `tps`、`timing`、`tokens`、`cost` 和 `tps:telemetry` 事件。新记录使用 `metrics.version: 2`：`tps` 与 `metrics.averageTps` 均为上述生成平均；`metrics.generationMs` 为对应生成时间。为兼容导出结构，旧 `timing.generationMs` 仍为 `message_start → message_end` 的累计时间（包含首字等待），`isPrimaryBranch` 在 v2 中仅表示 TPS 是否可计量，已不再代表旧算法分支。`metrics.updateCount` 只计非空内容 delta。

恢复 v1 记录时使用其已保存的 `metrics.averageTps`，不再将旧的停顿扣除 TPS 当作主指标；没有 `metrics` 的旧结构化记录在极简模式下显示 `○ — tok/s`，其原始值仍可导出。兼容旧 `{ message, timestamp }` 格式：极简模式不解析旧文本猜测速率，显示不可计量状态；`/tps` 和 full 模式仍可查看原文，不改写历史数据。

- `/tps-export [自定义条目类型] [--full]`：导出遥测及模型切换/分支结构，重连 parentId，保留 metrics。
- `/session-export [--full]`：导出完整会话条目。

默认导出当前分支，`--full` 导出所有分支，保留命令补全。文件分别写入 `${XDG_CACHE_HOME:-~/.cache}/pi-telemetry/` 和 `${XDG_CACHE_HOME:-~/.cache}/pi-sessions/`，并尝试打开目录。会话导出可能包含提示词、工具结果及敏感信息，分享前需检查。

定时器只在有 UI 的生成过程中运行；结束、取消、切换会话、重载或关闭时清理，不在扩展工厂中启动后台资源。
