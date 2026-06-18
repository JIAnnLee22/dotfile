#!/bin/bash
# Mako 配置安装脚本

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAKO_CONFIG_DIR="$HOME/.config/mako"
MAKO_CONFIG="$MAKO_CONFIG_DIR/config"

echo "📦 安装 Mako 配置"
echo "=================="

# 创建配置目录
mkdir -p "$MAKO_CONFIG_DIR"

# 备份现有配置
if [ -f "$MAKO_CONFIG" ] && [ ! -L "$MAKO_CONFIG" ]; then
    echo "⚠️  备份现有配置到 $MAKO_CONFIG.backup"
    cp "$MAKO_CONFIG" "$MAKO_CONFIG.backup"
fi

# 创建软链接
echo "🔗 创建软链接..."
ln -sf "$SCRIPT_DIR/config" "$MAKO_CONFIG"

echo ""
echo "✅ 安装完成！"
echo ""
echo "🎨 可用主题："
echo "  - 默认 (Catppuccin Mocha): $SCRIPT_DIR/config"
echo "  - 浅色 (Catppuccin Latte): $SCRIPT_DIR/config.catppuccin-latte"
echo "  - OLED (纯黑):            $SCRIPT_DIR/config.amoled"
echo ""
echo "🔄 切换主题："
echo "  ln -sf $SCRIPT_DIR/config.catppuccin-latte $MAKO_CONFIG"
echo "  pkill mako && mako &"
echo ""
echo "🧪 测试通知："
echo "  $SCRIPT_DIR/test.sh"