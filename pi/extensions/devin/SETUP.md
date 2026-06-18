# 配置 Pi 使用 Devin AI

## 快速配置步骤

### 1. 获取 Devin API 密钥

访问 [Devin AI](https://devin.ai) 并登录您的账户，获取 API 密钥。

### 2. 配置 API 密钥

编辑 `~/.config/pi/auth.json` 文件，添加 Devin API 密钥：

```json
{
  "devin": {
    "type": "api_key",
    "key": "your-devin-api-key"
  }
}
```

**注意**：文件中已经添加了 `devin` 配置的占位符，您只需要将 `your-devin-api-key` 替换为您的实际 API 密钥。

### 3. 验证配置

Pi 已配置为使用 Devin 作为默认模型。启动 Pi 后会自动使用：

```bash
# 直接启动 Pi
pi

# 或者指定扩展路径（如果未在settings.json中配置）
pi -e ~/.config/pi/extensions/devin
```

### 4. 测试配置

1. 列出可用模型：
   ```bash
   pi --list-models | grep devin
   ```

2. 启动 Pi 并测试：
   ```bash
   pi
   # Pi 应该会自动使用 devin/devin-1 模型
   ```

## 故障排除

### 模型未显示

1. 检查 API 密钥是否正确配置在 `auth.json` 中
2. 检查扩展是否已加载：
   ```bash
   DEBUG=pi:* pi 2>&1 | grep -i devin
   ```

### 连接错误

1. 检查网络连接
2. 确保可以从您的网络访问 Devin 的 API（默认端点：`https://api.devin.ai`）

## 参考

- [Devin API 文档](https://devin.ai/docs)
- [Pi 自定义提供者文档](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/custom-provider.md)