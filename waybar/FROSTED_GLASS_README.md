# Waybar Frosted Glass Effect - 毛玻璃效果优化

## 配置概览

### 1. Waybar CSS (`style.css`)

**背景效果:**
- 主背景: `rgba(245, 240, 232, 0.35)` + `backdrop-filter: blur(12px)`
- 添加白色边框: `1px solid rgba(255, 255, 255, 0.2)` 增强玻璃质感
- 添加微妙阴影: `box-shadow: 0 4px 30px rgba(0, 0, 0, 0.05)`

**模块样式:**
- 背景: `rgba(255, 255, 255, 0.15)` 半透明白色
- Hover时: `rgba(255, 255, 255, 0.3)` 更亮
- 圆角: `8px`
- 平滑过渡动画

**工作区按钮:**
- 活动状态: `rgba(60, 110, 92, 0.2)` 半透明绿色
- Hover: `rgba(255, 255, 255, 0.2)`
- 紧急状态: `rgba(204, 51, 34, 0.15)` 半透明红色

**任务栏按钮:**
- 活动状态: `rgba(60, 110, 92, 0.15)`
- Hover: `rgba(255, 255, 255, 0.2)`

**Tooltip & Menu:**
- 背景: `rgba(245, 240, 232, 0.85)` + `backdrop-filter: blur(16px)`
- 更强的模糊效果
- 白色边框增强层次感
- 更大的阴影

### 2. Mango 窗口管理器 (`config.conf`)

```
blur_params_num_passes = 3    # 模糊次数 (2 -> 3)
blur_params_radius = 12       # 模糊半径 (9 -> 12)
blur_params_noise = 0.04      # 噪点纹理 (0.02 -> 0.04)
blur_params_brightness = 0.85 # 亮度 (0.9 -> 0.85)
blur_params_contrast = 0.95   # 对比度 (0.9 -> 0.95)
blur_params_saturation = 1.2  # 饱和度 (保持不变)
```

### 3. Hyprland (`hyprland.conf`)

```ini
decoration {
    blur {
        enabled = true         # 启用模糊 (false -> true)
        size = 6               # 模糊大小
        passes = 3             # 模糊次数
        noise = 0.02           # 噪点
        contrast = 0.9         # 对比度
        brightness = 0.9       # 亮度
        saturation = 1.2       # 饱和度
    }
}
```

## 应用更改

```bash
# 重新启动 waybar
~/.config/waybar/restart.sh

# 或手动操作
pkill waybar && waybar &
```

## 效果说明

- **毛玻璃效果**: 半透明背景 + 高斯模糊
- **层次感**: 白色边框 + 微妙阴影
- **交互反馈**: Hover时背景变亮
- **平滑过渡**: 所有状态变化都有动画

## 调整建议

如果效果太强/太弱，可以调整:

1. **waybar 背景透明度**: 修改 `rgba()` 中的 alpha 值 (0.0-1.0)
2. **模糊强度**: 修改 `backdrop-filter: blur()` 的像素值
3. **mango 模糊参数**: 调整 `blur_params_*` 值

## 兼容性

- ✅ MangoWM (原生支持)
- ✅ Hyprland (启用 blur 后支持)
- ⚠️ Sway (需要配置 blur)
- ❌ X11 (不支持 backdrop-filter)