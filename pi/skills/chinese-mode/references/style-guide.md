# 中文编码风格指南

本指南定义了在中文模式下编写代码时的规范和最佳实践。

## 一、代码注释规范

### 1. 文件头注释

每个源文件应包含描述性注释：

```typescript
/**
 * 用户认证模块
 * 
 * 功能：
 * - 用户登录验证
 * - Token 生成和管理
 * - 权限检查
 * 
 * @author 开发团队
 * @version 1.0.0
 */
```

### 2. 函数注释

所有公开函数必须包含注释：

```typescript
/**
 * 计算两个日期之间的天数差
 * 
 * @param startDate 开始日期
 * @param endDate 结束日期
 * @returns 天数差（正数表示 endDate 在后）
 * 
 * @example
 * const days = calculateDaysDiff('2024-01-01', '2024-01-10');
 * // 返回 9
 */
function calculateDaysDiff(startDate: string, endDate: string): number {
  // 实现逻辑...
}
```

### 3. 行内注释

解释复杂逻辑：

```typescript
// 使用位运算检查权限（比逐个检查更高效）
if (userPermissions & ADMIN_PERMISSION) {
  // 允许访问
  return true;
}
```

### 4. TODO 和 FIXME

```typescript
// TODO: 实现缓存机制以提高性能
const data = await fetchDataFromDB();

// FIXME: 这里有内存泄漏问题，需要修复
const largeArray = processHugeData();
```

## 二、变量和函数命名

### 1. 变量命名（保持英文）

```typescript
// ✅ 正确：使用英文命名
const userName = '张三';
const isActive = true;
const itemCount = 10;

// ❌ 错误：不要使用拼音或中文
const yongHuMing = '张三';  // 拼音
const 用户名 = '张三';      // 中文
```

### 2. 函数命名（保持英文）

```typescript
// ✅ 正确
function getUserInfo() { }
function calculateTotalPrice() { }
function isValidEmail() { }

// ❌ 错误
function huoQuYongHuXinXi() { }
function jiSuanZongJia() { }
```

### 3. 常量命名

```typescript
// ✅ 正确：全大写加下划线
const MAX_RETRY_COUNT = 3;
const DEFAULT_TIMEOUT = 5000;
const API_BASE_URL = 'https://api.example.com';
```

## 三、日志输出规范

### 1. 使用中文日志

```typescript
// ✅ 正确
console.log('用户登录成功:', userId);
console.error('数据库连接失败:', error);
console.warn('警告：配置文件未找到，使用默认配置');

// ❌ 错误
console.log('User logged in:', userId);
console.error('Database connection failed:', error);
```

### 2. 结构化日志

```typescript
// 使用中文键名
logger.info('订单创建成功', {
  订单号: order.id,
  金额: order.amount,
  用户: order.userId,
});
```

## 四、错误处理规范

### 1. 错误信息使用中文

```typescript
try {
  await connectToDatabase();
} catch (error) {
  throw new Error(`数据库连接失败: ${error.message}`);
}
```

### 2. 自定义错误类

```typescript
/**
 * 用户验证错误
 */
class ValidationError extends Error {
  constructor(field: string, message: string) {
    super(`验证错误 - ${field}: ${message}`);
    this.name = 'ValidationError';
  }
}
```

## 五、文档规范

### 1. README 使用中文

```markdown
# 项目名称

## 简介

这是一个用于...的项目。

## 安装

```bash
npm install project-name
```

## 使用方法

```typescript
import { something } from 'project-name';

// 使用示例
something();
```

## 功能特性

- ✅ 功能一
- ✅ 功能二
- ✅ 功能三
```

### 2. API 文档

```typescript
/**
 * 获取用户信息
 * 
 * @description 根据用户 ID 获取用户的详细信息
 * @param {string} userId - 用户唯一标识
 * @returns {Promise<User>} 用户信息对象
 * @throws {UserNotFoundError} 用户不存在时抛出
 * 
 * @example
 * const user = await getUser('12345');
 * console.log(user.name); // 输出: 张三
 */
```

## 六、Git 提交规范

### 1. 提交信息格式

```
<类型>: <简短描述>

<详细描述>

<关联问题>
```

### 2. 类型说明

| 类型 | 说明 |
|------|------|
| feat | 新功能 |
| fix | 修复 bug |
| docs | 文档更新 |
| style | 代码格式调整 |
| refactor | 重构代码 |
| test | 添加测试 |
| chore | 构建/工具变动 |

### 3. 示例

```
feat: 添加用户注册功能

- 实现邮箱验证
- 添加密码强度检查
- 发送欢迎邮件

Closes #123
```

```
fix: 修复登录超时问题

- 增加超时重试机制
- 优化错误处理

Fixes #456
```

## 七、配置文件注释

### JSON 配置

```json
{
  // 数据库配置
  "database": {
    "host": "localhost",  // 数据库主机
    "port": 5432,         // 数据库端口
    "name": "myapp"       // 数据库名称
  },
  
  // 服务器配置
  "server": {
    "port": 3000,         // 监听端口
    "timeout": 5000       // 超时时间（毫秒）
  }
}
```

### YAML 配置

```yaml
# 数据库配置
database:
  host: localhost    # 数据库主机
  port: 5432         # 数据库端口
  name: myapp        # 数据库名称

# 服务器配置
server:
  port: 3000         # 监听端口
  timeout: 5000      # 超时时间（毫秒）
```

## 八、测试用例命名

```typescript
describe('用户服务', () => {
  describe('createUser', () => {
    it('应该成功创建新用户', async () => {
      // 测试逻辑
    });

    it('应该在邮箱已存在时抛出错误', async () => {
      // 测试逻辑
    });
  });
});
```

## 九、注意事项

1. **保持一致性** - 整个项目应保持统一的注释风格
2. **不要过度注释** - 简单代码不需要详细注释
3. **注释要准确** - 注释应描述代码的实际行为
4. **及时更新注释** - 代码修改后要同步更新注释
5. **避免注释代码** - 不要提交被注释掉的代码

## 十、工具推荐

- **ESLint** - 代码规范检查
- **Prettier** - 代码格式化
- **TypeDoc** - TypeScript 文档生成
- **Commitlint** - Git 提交信息规范检查
