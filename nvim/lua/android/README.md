# android.nvim — Neovim Android 跳转插件

为纯 Neovim（无 Android Studio）提供两类跳转，补足 `jdtls` / `kotlin-language-server` 不覆盖的能力：

1. **SDK 源码跳转**：在 Kotlin/Java 中对 `android.*` / `androidx.*` / `java.*` 类名按 `gd` 直接跳到 `$SDK/sources/android-XX/.../*.java`。
2. **XML ↔ 代码资源跳转**：`@string/@color/@drawable/@layout/@id/@mipmap/@xml/@style` 与 `R.layout.xxx / R.string.xxx` 互跳，`AndroidManifest.xml` 的 `@string/@mipmap/@style`、`tools:context=".MainActivity"`、自定义 `<com.example.View>`、`<TextView>` 等 widget 标签跳 SDK/项目源码。

零外部依赖（除 `rg` 可选提速），自动从 `local.properties` / `$ANDROID_HOME` / `$ANDROID_SDK_ROOT` / `~/Android/Sdk` 解析 SDK，从 `app/build.gradle.kts` 的 `compileSdk { version = release(36) { minorApiLevel = 1 } }` 解析 `compileSdk` 并选最匹配的 `sources/android-36.1`。

## 安装

本插件已放在 `dotfile/nvim/lua/android/`，`init.lua` 已加入：

```lua
require("android").setup()
```

可选配置：

```lua
require("android").setup({
  keymaps = true,
  override_gd = true,   -- gd = 智能跳转, gD = 原生 LSP definition
  jump_key = "gd",
  sdk_key = "<leader>as",
  res_key = "<leader>ar",
})
-- 全局覆盖 SDK 目录（否则自动探测）:
-- vim.g.android_sdk_dir = "/opt/android-sdk"
```

## 按键与命令

| 按键/命令 | 作用 |
|-----------|------|
| `gd` (在 kotlin/java/xml) | 智能跳转：优先资源/`@`/`R.`，其次 XML tag/自定义 View，再 SDK 源码，最后回落 `vim.lsp.buf.definition()` |
| `gf` | 同上，但走 `gf` 语义 |
| `gD` / `<leader>gd` | 原生 LSP definition |
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
  - 大写开头的 `View`, `Activity`, `TextView` 等 → 通过 `import` 推断 FQN → `COMMON_PREFIXES` 启发 → `rg` 全量搜索兜底 → `sources` 文件
  - `<cWORD>` 含 `.` 的 FQN 直接映射 `a.b.C -> a/b/C.java`
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

1. `get_sdk_dir` 优先级：`vim.g.android_sdk_dir` > `$ANDROID_HOME` > `$ANDROID_SDK_ROOT` > `local.properties:sdk.dir` > `~/Android/Sdk` > `~/Android/sdk` > `~/Library/Android/sdk`。
2. `get_compile_sdk` 正则同时捕获 `minorApiLevel`，`36 + 1 → "36.1"`。
3. `get_sources_root` 只认含 `android/` 子目录的有效 `sources/android-*`，`android-36` 这种空壳（仅 `.installer`）会被跳过，自动选 `android-36.1`。
4. `sdk.find_sdk_source` 先 `import` 表 → `COMMON_PREFIXES` 探测 → `XML_TAG_MAP` → `rg "class Foo"`。

## 依赖

- Neovim 0.11+（`vim.lsp.enable` / `vim.fs.find`）
- `rg` 强烈建议（无则部分回落到 `readfile` 仍可工作）
- 已安装 SDK `sources`（`sdkmanager --install "sources;android-36"`）

## 调试

```
:AndroidInfo
:lua print(require("android.sdk").find_sdk_source("android.view.View"))
:lua print(require("android.resources").find_resource_file("string","app_name"))
```

`init.lua` 中 `require("android").setup()` 已在 `require("lsp")` 之后，保证 `LspAttach` 之后覆盖 `gd`。

## 局限 / TODO

- `kotlin_language_server` / `kotlin_lsp` 对 Compose 的 `stringResource` 等合成访问暂只支持 `R.string` 形式；纯字符串常量不追踪。
- `R` 引用若跨 module（`:library:res`）仅搜索 `app/src/*/res` 与 `*/src/main/res`，未走 `gradle` 的 `sourceSets` 完整解析。
- SDK 搜索对 Kotlin 源码 `.kt` 仅尝试同名 `.kt`，framework 几乎全是 `.java`，故一般够用。
