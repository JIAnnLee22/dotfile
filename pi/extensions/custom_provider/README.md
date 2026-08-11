# custom_provider — 通用自定义 Provider 配置指南

本扩展从 `custom_provider.json` 读取参数，把任意 LLM 服务注册为 pi 的 provider，
无需写代码即可接入：OpenAI 兼容服务、自建端点、代理转发、Anthropic 兼容网关等。

**模型可以不用手写**：给 `baseUrl` + `apiKey`，扩展会自动请求 `{baseUrl}/models`
拉取该服务拥有的模型列表并注册，后续 pi 刷新模型时自动更新。

本文件说明**如何配置**这些 custom_provider。扩展源码见同目录 `index.ts`。

---

## 快速开始（3 步）

**第 1 步：编辑配置文件**

修改仓库根目录的 [`custom_provider.json`](../../custom_provider.json)，填入你的服务信息：

```json
{
  "providers": [
    {
      "id": "my-llm",
      "name": "My LLM",
      "baseUrl": "https://api.example.com/v1",
      "apiKey": "$MY_LLM_API_KEY",
      "api": "openai-completions",
      "models": [
        {
          "id": "my-model",
          "name": "My Model",
          "reasoning": false,
          "input": ["text"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 128000,
          "maxTokens": 8192
        }
      ]
    }
  ]
}
```

**不写 `models` 也可以**：只要 `id` 不是 pi 内置 provider，扩展会自动拉取
`{baseUrl}/models` 返回的模型列表（OpenAI 兼容网关 / 中转 / 本地服务都适用）：

```json
{
  "providers": [
    {
      "id": "my-llm",
      "name": "My LLM",
      "baseUrl": "https://api.example.com/v1",
      "apiKey": "$MY_LLM_API_KEY",
      "api": "openai-completions"
    }
  ]
}
```

**第 2 步：设置 API key 环境变量**

`apiKey` 里的 `$MY_LLM_API_KEY` 是环境变量插值语法，启动 pi 前先设置：

```bash
export MY_LLM_API_KEY=sk-xxxx
```

也可以直接写死字符串、`${ENV_VAR}` 形式，或用 `!command` 取命令输出（见下文「apiKey 取值语法」）。

**第 3 步：启动 pi 并验证**

```bash
pi -e ./extensions/custom_provider --list-models
```

看到 `my-llm  my-model`（或自动拉取到的模型）即注册成功。进入交互界面后用 `/model` 切换模型。

---

## 配置文件放在哪里

扩展按以下顺序查找 `custom_provider.json`，取**第一个存在**的文件：

1. 环境变量 `$PI_CUSTOM_PROVIDER_CONFIG` 指定的路径（优先级最高，适合多套配置切换）
2. `$PI_CODING_AGENT_DIR/custom_provider.json`
3. 当前工作目录 `custom_provider.json`
4. 本扩展目录 `extensions/custom_provider/custom_provider.json`
5. 本扩展目录上级两级（agentDir 根目录）`custom_provider.json`

推荐放在仓库根目录（即 `PI_CODING_AGENT_DIR` 指向的目录），或通过
`PI_CUSTOM_PROVIDER_CONFIG=/path/to/xxx.json` 指定。

> 注意：扩展与 `parallel-tasks` 一样需要被 pi 加载才能生效（`-e ./extensions/custom_provider`
> 或你现有的扩展发现机制），加载方式见各场景的启动参数。

---

## 配置格式

### 支持的三种结构

```jsonc
// A. 顶层数组：每个元素是一个完整 provider
[
  { "id": "my-llm", "baseUrl": "...", "api": "openai-completions", "models": [] }
]

// B. 显式 providers 数组（推荐）
{ "providers": [ { "id": "my-llm", "baseUrl": "...", "models": [] } ] }

// C. 对象映射：键名即 provider id
{ "my-llm": { "baseUrl": "...", "models": [] } }
```

三种效果等价，可按可读性选择。多个 provider 混在一个文件即可。

### provider 字段

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | string | 是 | provider 唯一标识（数组形式必填；映射形式取键名） |
| `name` | string | 否 | 显示名称，出现在 `/login`、`/model` 界面 |
| `baseUrl` | string | 是 | API 端点 URL，如 `https://api.xxx.com/v1` |
| `apiKey` | string | 否 | API key，支持插值语法（见下） |
| `api` | string | 定义 models 时必填 | 流式 API 类型（取值见下文） |
| `authHeader` | boolean | 否 | `true` 时自动发送 `Authorization: Bearer <apiKey>` |
| `headers` | object | 否 | 自定义请求头，值同样支持插值语法 |
| `models` | array | 否 | 模型列表；提供时**替换**该 provider 全部模型 |
| `fetchModels` | boolean/string | 否 | 自动拉取模型列表，见「自动拉取模型」 |

只给 `baseUrl`/`headers` 不给 `models` 时，表示**覆盖**同名内置 provider 的端点
（代理转发场景），原有模型全部保留（此时不会自动拉取，除非显式写 `"fetchModels": true`）。

### 模型字段

| 字段 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | string | 是 | - | 模型 ID，发送给 API 的标识 |
| `name` | string | 否 | 同 `id` | 显示名称 |
| `reasoning` | boolean | 否 | `false` | 是否支持扩展思考（thinking） |
| `input` | string[] | 否 | `["text"]` | 支持 `"text"` / `"image"` |
| `cost` | object | 否 | 全 0 | 单价，$/M tokens：`{ input, output, cacheRead, cacheWrite }`，可加 `tiers` 做阶梯定价 |
| `contextWindow` | number | 否 | `128000` | 上下文窗口（token） |
| `maxTokens` | number | 否 | `4096` | 最大输出 token |
| `api` | string | 否 | 继承 provider | 模型级 API 覆盖 |
| `baseUrl` | string | 否 | 继承 provider | 模型级端点覆盖 |
| `thinkingLevelMap` | object | 否 | - | 思考级别映射，见「思考能力配置」 |
| `headers` | object | 否 | - | 模型级请求头 |
| `compat` | object | 否 | - | 兼容性开关，见「compat 常用项」 |
| `samplingParams` | object | 否 | - | 默认采样参数（`temperature` 等） |

> 自动拉取时也接受蛇形字段（`context_window` / `max_tokens` / `input_modalities`），
> 兼容 OpenAI 风格目录。

### `api` 取值（与 pi 文档一致）

| 值 | 适用服务 |
| --- | --- |
| `openai-completions` | OpenAI Chat Completions 及**绝大多数 OpenAI 兼容服务**（vLLM、LM Studio、Ollama、各种网关） |
| `anthropic-messages` | Anthropic Claude API 及兼容实现 |
| `openai-responses` | OpenAI Responses API |
| `azure-openai-responses` | Azure OpenAI Responses API |
| `openai-codex-responses` | OpenAI Codex Responses API |
| `mistral-conversations` | Mistral 原生 Chat Completions 流式 |
| `google-generative-ai` | Google Gemini API |
| `google-vertex` | Google Vertex AI |
| `bedrock-converse-stream` | AWS Bedrock Converse API |

不确定就用 `openai-completions`。未知值会告警但不阻止注册（适合配合自定义 `streamSimple`，需另行写代码）。

### `apiKey` 取值语法

| 写法 | 含义 |
| --- | --- |
| `sk-xxxx` | 字面量 |
| `$MY_LLM_API_KEY` | 环境变量插值 |
| `${MY_LLM_API_KEY}` | 同上（花括号形式） |
| `!kubectl get secret ...` | 取命令 stdout（去首尾空白） |

### 思考能力配置（`thinkingLevelMap`）

模型 `reasoning: true` 后，可映射 pi 的思考级别到服务端取值；`null` 表示该级别不支持：

```json
"thinkingLevelMap": {
  "low": "low",
  "medium": "medium",
  "high": "default",
  "xhigh": "max",
  "max": "max"
}
```

### `compat` 常用项（OpenAI 兼容）

| 字段 | 值 | 说明 |
| --- | --- | --- |
| `supportsDeveloperRole` | boolean | `false` 时用 `system` 而非 `developer` 角色 |
| `supportsReasoningEffort` | boolean | 是否发送 `reasoning_effort` |
| `maxTokensField` | string | `"max_completion_tokens"` 或 `"max_tokens"` |
| `requiresToolResultName` | boolean | 工具结果是否需要 `name` 字段 |
| `thinkingFormat` | string | 思考格式：`openai` / `deepseek` / `qwen` / `chat-template` 等 |

---

## 自动拉取模型（fetchModels）

扩展可以自己向服务端请求「该 provider 拥有哪些模型」，无需在 JSON 里手写 `models`。

### 启用方式

| 写法 | 行为 |
| --- | --- |
| 不写 `fetchModels`，且**没有** `models`，且 `id` **不是** pi 内置 provider | **自动启用**（推荐，零配置） |
| `"fetchModels": true` | 显式启用（对内置 provider 也生效） |
| `"fetchModels": "https://xxx/models"` | 从自定义 URL 拉取（不限于 `baseUrl/models`） |
| `"fetchModels": false` | 显式关闭（对内置 provider 的代理转发保持原语义） |

> pi 内置 provider 名单见 pi-ai 的 `KnownProvider`（anthropic、openai、google、deepseek 等）。
> 覆盖它们时默认不拉取，避免破坏「保留原有模型」的代理语义。

### 请求方式

- URL：`fetchModels` 为字符串时直接用；否则 `GET {baseUrl}/models`（baseUrl 已以 `/models` 结尾时不重复拼接）。
- 认证：`Authorization: Bearer <apiKey>`（`apiKey` 已解析插值；自定义 `headers` 里的
  `Authorization` 优先）。自定义 header 值支持 `$ENV_VAR` 插值，缺失的环境变量对应的 header 会被跳过。
- 超时：15 秒。请求失败只告警、不影响启动，改用静态 `models` 兜底（若配置了）。

### 响应格式（三种都支持）

```jsonc
// A. OpenAI 风格
{ "data": [ { "id": "gpt-4o", "object": "model" }, ... ] }

// B. 网关风格
{ "models": [ { "id": "claude-sonnet-4-5" }, ... ] }

// C. 顶层数组
[ { "id": "llama-3.1-70b" }, ... ]
```

每个条目的 `id` 必填；其余字段可选，缺省值：`name` 同 `id`、`reasoning: false`、
`input: ["text"]`、`cost` 全 0、`contextWindow: 128000`、`maxTokens: 4096`。
也支持蛇形字段（`context_window` / `max_tokens` / `input_modalities`）与完整模型字段
（`api`、`baseUrl`、`thinkingLevelMap`、`headers`、`compat`、`samplingParams`）。

自动过滤规则：
- 跳过 `type` / `mode` 为 `embedding`、`image`、`tts`、`stt`、`rerank`、`audio` 等不可对话的条目；
- 若网关在条目里带 `supported_endpoint_types`（如 `["anthropic", "openai"]`），且能识别当前
  `api` 对应的端点类型，则只保留支持该端点类型的模型；词汇不匹配时不做筛选，全部保留。

### 刷新时机

- **启动时**：扩展工厂阶段拉取一次，注册结果立即可用（`--list-models` 也能看到）；
- **pi 刷新时**：接入 `refreshModels` 生命周期，启动刷新 / 交互界面刷新模型列表会自动更新，
  无需重启；60 秒内不会重复请求同一 provider（强制刷新除外）；
- **离线 / 拉取失败**：保留上一次结果（或静态 `models` 兜底）。

### 示例

```json
{
  "providers": [
    {
      "id": "my-gateway",
      "name": "My Gateway",
      "baseUrl": "https://gateway.example.com/v1",
      "apiKey": "$GATEWAY_KEY",
      "api": "openai-completions",
      "authHeader": true
    },
    {
      "id": "local-llm",
      "name": "Local LM Studio",
      "baseUrl": "http://localhost:1234/v1",
      "apiKey": "not-needed",
      "api": "openai-completions"
    }
  ]
}
```

---

## 配置示例（按场景）

### 场景 1：OpenAI 兼容本地服务（LM Studio / vLLM / Ollama）

```json
{
  "providers": [
    {
      "id": "local-llm",
      "name": "Local LLM",
      "baseUrl": "http://localhost:1234/v1",
      "apiKey": "not-needed",
      "api": "openai-completions",
      "models": [
        {
          "id": "qwen2.5-72b-instruct",
          "name": "Qwen 2.5 72B",
          "reasoning": true,
          "input": ["text"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 128000,
          "maxTokens": 8192,
          "compat": { "supportsDeveloperRole": false }
        }
      ]
    }
  ]
}
```

也可以删掉 `models`，让扩展自动拉取该服务已加载的模型。

### 场景 2：Anthropic 兼容网关 / 中转

```json
{
  "providers": [
    {
      "id": "claude-proxy",
      "name": "Claude Proxy",
      "baseUrl": "https://gateway.example.com/anthropic",
      "apiKey": "$ANTHROPIC_PROXY_KEY",
      "api": "anthropic-messages",
      "authHeader": true,
      "headers": { "X-Corp-Auth": "$CORP_AUTH_TOKEN" },
      "models": [
        {
          "id": "claude-sonnet-4-5",
          "name": "Claude Sonnet 4.5 (proxy)",
          "reasoning": true,
          "input": ["text", "image"],
          "cost": { "input": 3, "output": 15, "cacheRead": 0.3, "cacheWrite": 3.75 },
          "contextWindow": 200000,
          "maxTokens": 64000
        }
      ]
    }
  ]
}
```

### 场景 3：代理转发——覆盖内置 provider

不写 `models`，只改 `baseUrl`/`headers`，内置 provider 的模型原样保留、流量改走新端点
（此场景默认不会自动拉取模型）：

```json
{
  "providers": [
    {
      "id": "anthropic",
      "baseUrl": "https://proxy.example.com",
      "headers": { "X-Corp-Auth": "$CORP_AUTH_TOKEN" }
    },
    {
      "id": "openai",
      "baseUrl": "https://ai-gateway.corp.com/openai"
    }
  ]
}
```

### 场景 4：多 provider 混合（同一文件注册多个）

```json
{
  "providers": [
    {
      "id": "work-llm",
      "name": "Work LLM",
      "baseUrl": "https://llm.internal.corp/v1",
      "apiKey": "$WORK_LLM_KEY",
      "api": "openai-completions",
      "authHeader": true,
      "headers": { "X-Tenant": "engineering" },
      "models": [
        {
          "id": "work-70b",
          "name": "Work 70B",
          "reasoning": true,
          "input": ["text", "image"],
          "cost": { "input": 0.5, "output": 1.5, "cacheRead": 0.1, "cacheWrite": 0.6 },
          "contextWindow": 131072,
          "maxTokens": 16384
        }
      ]
    },
    {
      "id": "home-llm",
      "name": "Home LLM",
      "baseUrl": "http://192.168.1.10:8080/v1",
      "apiKey": "not-needed",
      "api": "openai-completions",
      "models": [
        {
          "id": "home-8b",
          "name": "Home 8B",
          "reasoning": false,
          "input": ["text"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 32768,
          "maxTokens": 4096
        }
      ]
    }
  ]
}
```

---

## 验证配置是否生效

```bash
# 列出全部可用的 provider / 模型（需先设置 apiKey 环境变量）
MY_LLM_API_KEY=xxx pi -e ./extensions/custom_provider --list-models

# 模糊搜索（如只看某个 provider 的模型）
pi -e ./extensions/custom_provider --list-models vimedia
```

启动时看到类似日志即注册成功：

```
[custom_provider] 从 /path/to/custom_provider.json 加载 2 个 provider
[custom_provider] "my-llm": 已从 https://api.example.com/v1/models 拉取 42 个模型
[custom_provider] 已注册 provider "my-llm"（42 个模型，来自自动拉取, baseUrl=https://api.example.com/v1）
```

`--list-models` 只列出**认证完整**的 provider：`apiKey` 用环境变量时，请确保该变量已设置。

---

## 常见问题

**改了 custom_provider.json 需要重启吗？**
扩展在启动时读取一次配置。修改 JSON 后需重启 pi（或用 `/reload` 重载扩展）。

**没有 API key 的本地服务怎么写？**
`apiKey` 写任意非空字符串（如 `"not-needed"`）即可；本地服务通常忽略该头。

**自定义 header 里的环境变量没有设置会怎样？**
该请求头会被跳过（不发送），pi 只在 key 存在时注入。

**模型没出现在 /model 列表？**
检查：`apiKey` 对应环境变量是否已设置；`baseUrl` 是否可达；`--list-models` 是否显示。
启用自动拉取时，启动日志里应有「已从 …/models 拉取 N 个模型」；若显示拉取失败，
确认 `/models` 端点可访问、返回格式受支持（见「自动拉取模型」），或改用静态 `models`。

**一个服务有多个模型？**
自动拉取模式下无需配置，服务返回的全部可用模型都会注册；静态模式下在同一个
provider 的 `models` 数组里全部列出即可。

---

## 限制（JSON 无法表达的内容）

以下字段含函数，无法用 JSON 配置，需要直接编写扩展代码（参考官方示例
`examples/extensions/custom-provider-anthropic/`）：

- `oauth`：OAuth/SSO 登录（`/login` 支持）
- `streamSimple`：非标准 API 的自定义流式实现

> 模型列表已内置自动拉取（`fetchModels`），无需再手写 `refreshModels` 回调。

---

*完整字段定义见 pi 文档 Custom Providers：<https://pi.dev/docs/latest/custom-provider>*
