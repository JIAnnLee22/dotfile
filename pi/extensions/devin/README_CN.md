# 配置 Pi 使用 Devin AI

我已经为您创建了一个 Devin AI 提供者扩展，类似于现有的 Windsurf 扩展。

## ✅ 已完成的配置

1. **创建了 Devin 扩展目录和文件**：
   - 路径：`/home/jiannlee22/dotfile/pi/extensions/devin/`
   - 包含文件：`index.ts`、`package.json`、文档文件

2. **更新了 Pi 配置**：
   - 在 `~/.config/pi/settings.json` 中添加了 `extensions` 字段
   - 设置 Devin 为默认提供者和默认模型
   - 扩展路径：`~/.config/pi/extensions/devin`

## 🔑 配置 API 密钥

### 获取 Devin API 密钥

访问 [Devin AI](https://devin.ai) 并登录您的账户，获取 API 密钥。

### 配置 API 密钥

将您的 Devin API 密钥添加到 `~/.config/pi/auth.json`：

```json
{
  "devin": {
    "type": "api_key",
    "key": "your-devin-api-key"
  }
}
```

**注意**：`auth.json` 文件中已经添加了 `devin` 配置的占位符，您只需要将 `your-devin-api-key` 替换为您的实际 API 密钥。

## 🚀 使用 Devin 模型

由于已将 Devin 设置为默认模型，启动 Pi 后会自动使用 Devin：

```bash
# 直接启动 Pi
pi

# 或者指定扩展路径（如果未在settings.json中配置）
pi -e ~/.config/pi/extensions/devin
```

## 🧪 测试配置

1. **列出可用模型**：
   ```bash
   pi --list-models | grep devin
   ```

2. **启动 Pi 并测试**：
   ```bash
   pi
   # Pi 应该会自动使用 devin/devin-1 模型
   ```

## 🔧 故障排除

### 模型未显示
1. 检查 API 密钥是否正确配置在 `auth.json` 中
2. 检查扩展是否已加载：
   ```bash
   DEBUG=pi:* pi 2>&1 | grep -i devin
   ```

### 连接错误
1. 检查网络连接
2. 确保可以从您的网络访问 Devin 的 API（默认端点：`https://api.devin.ai`）

## 📚 参考文档

- 详细文档：`/home/jiannlee22/dotfile/pi/extensions/devin/README.md`
- 配置指南：`/home/jiannlee22/dotfile/pi/extensions/devin/SETUP.md`
- 快速开始：`/home/jiannlee22/dotfile/pi/extensions/devin/QUICKSTART.md`

## 💡 提示

- Devin 已被设置为默认提供者和默认模型，启动 Pi 后会自动使用
- 如果需要切换到其他模型，可以使用 `/model` 命令
- 如果需要更改默认模型，编辑 `~/.config/pi/settings.json` 文件