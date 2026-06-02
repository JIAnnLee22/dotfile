# Chinese Mode Extension (中文模式扩展)

自动强制 Pi 编码代理使用中文进行思考和输出。

## 功能特性

- ✅ **强制中文思考** - AI 内部推理和分析使用中文
- ✅ **中文对话输出** - 所有回复使用中文
- ✅ **中文代码注释** - 代码注释使用中文
- ✅ **中文 Git 提交** - 提交信息使用中文
- ✅ **中文文档** - 生成中文技术文档

## 配置选项

### 启用/禁用

在 `settings.json` 中配置：

```json
{
  "chinese": true
}
```

或使用命令行参数：

```bash
# 启用中文模式（默认）
pi

# 禁用中文模式
pi --no-chinese
```

### 快捷键

| 命令 | 功能 |
|------|------|
| `/chinese` | 显示中文模式状态 |

## 工作原理

1. **自动注入** - 扩展在每次对话前自动注入中文语言指令
2. **上下文管理** - 智能管理对话上下文，确保中文指令持续生效
3. **无缝集成** - 与 Pi 的其他扩展和 Skill 兼容

## 中文输出规范

### 代码注释

```typescript
/**
 * 用户认证模块
 * 处理用户的登录、登出和权限验证
 */
export class AuthService {
  /**
   * 验证用户凭证
   * @param credentials 用户登录信息
   * @returns 验证结果
   */
  async validate(credentials: LoginCredentials): Promise<boolean> {
    // 检查用户名和密码
    const user = await this.findUser(credentials.username);
    if (!user) {
      // 用户不存在
      return false;
    }
    // 验证密码
    return this.comparePassword(credentials.password, user.password);
  }
}
```

### Git 提交信息

```
feat: 实现用户注册功能

- 添加邮箱验证
- 实现密码加密
- 发送欢迎邮件

Closes #123
```

### 错误信息

```
错误：数据库连接失败
原因：网络超时
解决方案：请检查网络连接后重试
```

## 特殊场景

### 1. 变量命名

变量名、函数名保持英文，注释使用中文：

```typescript
// 用户年龄
const userAge = 25;

// 计算总价
function calculateTotalPrice(items: Item[]): number {
  // 遍历所有商品并累加价格
  return items.reduce((sum, item) => sum + item.price, 0);
}
```

### 2. 技术术语

首次出现时可以中英对照：

```
应用程序接口（API）
模型上下文协议（MCP）
大语言模型（LLM）
```

### 3. 错误堆栈

系统错误信息保持英文原样：

```
Error: Cannot find module './utils'
    at Function.Module._resolveFilename (internal/modules/cjs/loader.js:815:15)
```

## 与其他扩展的兼容性

- **plan-mode** - 可同时启用，计划内容使用中文
- **code-annotations** - 注释规范兼容
- **其他 Skill** - 中文模式优先级更高

## 故障排除

### 中文模式未生效

1. 检查扩展是否已加载：查看启动信息
2. 确认配置正确：`settings.json` 中 `"chinese": true`
3. 重启 Pi 会话

### 想临时禁用

在对话中说：
```
暂时禁用中文模式
```

或启动时使用：
```bash
pi --no-chinese
```

## 许可

MIT License
