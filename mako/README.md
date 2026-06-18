# Mako 配置

现代美观的 Wayland 通知配置。

## 安装

```bash
# 创建配置目录
mkdir -p ~/.config/mako

# 软链接配置文件
ln -sf ~/dotfile/mako/config ~/.config/mako/config

# 重启 mako
pkill mako && mako &
```

## 主题变体

本目录包含多个主题变体：

- `config` - 主配置（Catppuccin Mocha 深色主题）
- `config.catppuccin-latte` - Catppuccin Latte 浅色主题
- `config.amoled` - 纯黑 OLED 主题

切换主题：
```bash
# 使用浅色主题
ln -sf ~/dotfile/mako/config.catppuccin-latte ~/.config/mako/config

# 使用 OLED 主题
ln -sf ~/dotfile/mako/config.amoled ~/.config/mako/config

# 重启 mako
pkill mako && mako &
```

## 特性

- ✨ 圆角设计（20px 圆角）
- 🎨 半透明背景 + 模糊效果（需要 compositor 支持）
- ⚡ 按紧急程度分色（低/普通/高）
- 🎵 特殊应用自定义样式（Spotify、Firefox 等）
- 📱 现代字体栈（Inter + 中文字体）
- ⏱️ 智能超时设置

## 测试通知

```bash
# 运行测试脚本
./test.sh

# 或手动测试
notify-send "Hello" "测试通知"
notify-send -u critical "紧急" "高优先级通知"
```

## 自定义

编辑配置文件后重启 mako：
```bash
pkill mako && mako &
```

### 常用选项

```ini
# 调整位置（top-left, top-center, top-right, bottom-left, bottom-center, bottom-right）
anchor=top-right

# 调整大小
width=350
height=100

# 调整透明度（0-1）
background-color=rgba(30, 30, 46, 0.85)

# 调整圆角
border-radius=20

# 调整边距
margin=20
padding=20
```