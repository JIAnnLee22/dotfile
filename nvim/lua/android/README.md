# android.nvim — Neovim Android 跳转插件

为纯 Neovim（无 Android Studio）提供两类跳转，补足 `jdtls` / JetBrains 官方 `kotlin-lsp` 不覆盖的能力：

1. **SDK 源码跳转**：在 Kotlin/Java 中对平台类（如 `android.view.View`）按 `gd`，打开 `$SDK/sources/android-XX/.../*.java`。AndroidX 是 Gradle 依赖，不在平台 SDK 中。
2. **XML ↔ 代码资源跳转**：`@string/@color/@drawable/@layout/@id/@mipmap/@xml/@style` 与 `R.layout.xxx / R.string.xxx` 互跳，`AndroidManifest.xml` 的 `@string/@mipmap/@style`、`tools:context=".MainActivity"`、自定义 `<com.example.View>`、`<TextView>` 等 widget 标签跳 SDK/项目源码。

SDK 与 XML 资源导航不依赖语言服务器；依赖 JAR 的源码解包使用 `unzip`。自动从 `local.properties` / `$ANDROID_HOME` / `$ANDROID_SDK_ROOT` / `~/Android/Sdk` 解析 SDK，从 `app/build.gradle.kts` 的 `compileSdk { version = release(36) { minorApiLevel = 1 } }` 解析 `compileSdk` 并选最匹配的 `sources/android-36.1`。

## 安装

本插件已放在 `dotfile/nvim/lua/android/`，`init.lua` 已加入：

```lua
require("android").setup()
```

可选配置：

```lua
require("android").setup({
  keymaps = true,
  override_gd = true,   -- gd = 智能跳转，gD = 直接请求 LSP 定义
  jump_key = "gd",
  sdk_key = "<leader>as",
  res_key = "<leader>ar",
})
-- 全局覆盖 SDK 目录（否则自动探测）:
-- vim.g.android_sdk_dir = "/opt/android-sdk"
-- vim.g.android_compile_sdk = "36.1" -- Gradle 构建脚本间接设置 compileSdk 时可覆盖
```

## 按键与命令

| 按键/命令 | 作用 |
|-----------|------|
| `gd` | 优先 Android 资源/XML 标签；Java/Kotlin 优先请求 LSP，找不到定义时按显式 import 或全限定名打开 SDK 源码 |
| `gf` | 资源/XML 标签/显式 SDK 类，其他按 Neovim 原来的文件路径打开 |
| `gD` / `<leader>gd` | 直接请求 LSP，并解析 SDK 和依赖的源码位置 |
| `<leader>as` | 光标词跳 SDK 源码 |
| `<leader>ar` | 光标处资源跳文件 |
| `:AndroidGoto` | 同 `gd` 智能 |
| `:AndroidSdk [FQN]` | 跳 SDK，空参则取光标词 |
| `:AndroidRes <type> <name>` | `:AndroidRes layout activity_main` / `:AndroidRes string app_name` |
| `:AndroidInfo` | 打印 `root / sdk_dir / compileSdk / sources / res dirs` |

## 跳转规则

- **Kotlin/Java**：
  - `R.layout.foo` / `R.string.foo` / `R.drawable.foo` / `R.id.foo` → `res/layout*/foo.xml` / `values/*.xml` / `drawable*/foo.*` / 含 `@+id/foo` 的 layout
  - `@layout/foo` 字符串（少见）亦可
  - `binding.fooBar` → `snake_case` 找 `id/foo_bar` 的 layout/ids.xml
  - `gd` 可按显式 import（含 Kotlin `as` 别名）、全限定名或 LSP 返回的 `android.jar` 位置打开真实 SDK 源码，不按简单类名抢占项目定义。
  - `<leader>as` / `:AndroidSdk` 还可主动按简名查找 SDK 类。
- **XML**：
  - `@string/app_name` → `values/strings.xml` 并光标定到 `name="app_name"`
  - `@color/black` → `values/colors.xml`
  - `@mipmap/ic_launcher` → `mipmap-*/ic_launcher.*`
  - `@xml/backup_rules` → `xml/backup_rules.xml`
  - `@style/Theme.RomoteControl` → 任意 `values/*.xml` 中 `name="Theme.RomoteControl"`
  - `<TextView>` → `android.widget.TextView` SDK
  - `<com.jiannlee22.romotecontrol.SomeView>` → 项目 `app/src/main/java/.../SomeView.kt` 优先，次 SDK，次 `rg class SomeView`
  - `tools:context=".MainActivity"` / `android:name=".MainActivity"` 的 `".Foo"` 前缀用 `AndroidManifest`/`namespace` 补全包名后跳项目文件
  - `settingsActivity="com.jiannlee22.romotecontrol.MainActivity"` 的 FQN 同上

## SDK 解析细节

1. SDK 目录优先级：`vim.g.android_sdk_dir` > `local.properties:sdk.dir` > `$ANDROID_HOME` / `$ANDROID_SDK_ROOT` > `~/Android/Sdk` 等常见位置。
2. 优先读取当前 Gradle 模块的 `compileSdk`，支持 `release(36)` 加 `minorApiLevel = 1`。先匹配准确的源码版本，再匹配同主 API（比如 `37` → `37.0`）；知道 API 时不会跳到其他主版本。
3. Gradle JAR（包括 AndroidX 的 `transformed/.../jars/classes.jar`）会尝试打开缓存中的同版本 `*-sources.jar`。Compose 等采用不带版本号的 `*-release.aar` 时，先比对原始 AAR 中的 `classes.jar` 确认版本。Kotlin 标准库还会查找 `commonMain`、`jvmMain` 等目录中的声明。jdtls 的 `jdt://` 先尝试 SDK 源码，再请求 `java/classFileContents`。从字节码位置回查源码时，重载可能定位到同文件中的第一个声明。

## 依赖

- Neovim 0.11+（`vim.lsp.enable` / `vim.fs.find`）
- `rg` 强烈建议（无则部分回落到 `readfile` 仍可工作）
- 可写 SDK 用 `sdkmanager --install "sources;android-36"`（把 `36` 替换为项目 API）。本仓库的 NixOS SDK 是只读的，通过 `modules/programs/gui.nix` 的 `androidenv` 安装 `sources`。
- Gradle 依赖源码跳转需要对应的 `*-sources.jar`；没有源码包时不会伪造或反编译代码
- `unzip`（当前 NixOS CLI 配置已提供）

## 调试

```
:AndroidInfo
:checkhealth vim.lsp
:lua print(vim.lsp.get_clients({ bufnr = 0 })[1] and vim.lsp.get_clients({ bufnr = 0 })[1].name)
:lua print(require("android.sdk").find_sdk_source("android.view.View"))
:lua print(require("android.resources").find_resource_file("string","app_name"))
```

先确认 Kotlin buffer 已由 `kotlin_lsp` attach；若 LSP 未 attach，补全、悬浮和项目代码跳转不能由 Android 导航模块替代。`AndroidInfo` 应显示有效的 project root、SDK 和 sources 目录。

`init.lua` 中 `require("android").setup()` 注册 Java/Kotlin/XML 的 `gd`；通用 LSP 映射不会覆盖它。

## 局限 / TODO

- `kotlin_lsp` 对 Compose 的 `stringResource` 等合成访问暂只支持 `R.string` 形式；纯字符串常量不追踪。
- `R` 引用若跨 module（`:library:res`）仅搜索一级模块的 `src/*/res`，未走 `gradle` 的 `sourceSets` 完整解析。
- SDK 搜索对 Kotlin 源码 `.kt` 仅尝试同名 `.kt`，framework 几乎全是 `.java`，故一般够用。
