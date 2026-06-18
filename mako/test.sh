#!/bin/bash
# Mako 通知测试脚本

echo "🎨 测试 Mako 通知配置"
echo "=========================="

# 普通通知
echo "1/5: 发送普通通知..."
notify-send "Hello!" "这是一个普通通知" -i dialog-information
sleep 2

# 低优先级通知
echo "2/5: 发送低优先级通知..."
notify-send -u low "低优先级" "这是一条低优先级消息" -i dialog-information
sleep 2

# 高优先级通知
echo "3/5: 发送高优先级通知..."
notify-send -u critical "紧急警告" "这是一条高优先级消息！" -i dialog-warning
sleep 2

# 带进度条的通知
echo "4/5: 发送带进度条的通知..."
notify-send "下载中" "正在下载文件..." -h int:value:75 -i drive-harddisk
sleep 2

# 长文本通知
echo "5/5: 发送长文本通知..."
notify-send "长文本测试" "这是一条包含较长内容的通知消息，用于测试文本换行和截断效果。Mako 会自动处理长文本的显示。" -i text-x-preview
sleep 2

echo ""
echo "✅ 测试完成！"
echo ""
echo "💡 提示："
echo "  - 按 Escape 关闭当前通知"
echo "  - 按 Ctrl+Shift+. 关闭所有通知"
echo "  - 编辑 ~/.config/mako/config 自定义样式"