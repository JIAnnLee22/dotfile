# 快速开始：配置 Pi 使用 Devin AI

## 1. 获取 API 密钥

访问 [Devin AI](https://devin.ai) 并登录您的账户，获取 API 密钥。

## 2. 配置 API 密钥

编辑 `~/.config/pi/auth.json` 文件，将 `your-devin-api-key` 替换为您的实际 API 密钥：

```json
{
  "devin": {
    "type": "api_key",
    "key": "your-devin-api-key"
  }
}
```

## 3. 启动 Pi

由于已将 Devin 设置为默认模型，直接启动 Pi 即可：

```bash
pi
```

## 4. 验证配置

启动后，Pi 应该会自动使用 `devin/devin-1` 模型。您可以通过以下方式验证：

```bash
# 列出可用模型
pi --list-models | grep devin
```

## 故障排除

如果模型未显示，检查：

1. API 密钥是否正确配置在 `auth.json` 中
2. 扩展是否已加载：
   ```bash
   DEBUG=pi:* pi 2>&1 | grep -i devin
   ```

## 更多信息

- 详细文档：`/home/jiannlee22/dotfile/pi/extensions/devin/README_CN.md`
- 配置指南：`/home/jiannlee22/dotfile/pi/extensions/devin/SETUP.md`