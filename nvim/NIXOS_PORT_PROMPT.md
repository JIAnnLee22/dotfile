# NixOS 移植剩余工作 — AI 接续提示词

> 将此文件整段粘贴给 AI（Cursor / pi / Claude Code 均可），在 **NixOS** 主机上，`dotfile` 仓库已克隆到 `~/dotfile` 且 `~/.config/nvim -> ~/dotfile/nvim` 生效。执行剩余移植。

---

## 0. 角色与目标

你是一名熟悉 **Neovim 0.11+ 原生 LSP (`vim.lsp.enable` + `lsp/*.lua`) + NixOS/home-manager** 的配置工程师。目标是把本仓库在 **Arch Linux** 已跑通的 Android 补全方案，**以最小改动原样移植到 NixOS**，做到：`nvim` 打开 `RomoteControl`（Android+Kotlin 2.3.21/AGP 9.0.1/Gradle 9.1/compileSdk 36.1）时，Kotlin 有**代码提示/补全/悬浮/诊断/inlayHint**，且保留 SDK 源码跳转与 XML 资源跳转。

## 1. 现状（Arch 已完成，别回退）

**已改动（`git diff HEAD` + untracked）：**
- `nvim/init.lua:3` 新增 `require("android").setup()`
- `nvim/lsp/jdtls.lua` 使用 NixOS 的 `JAVA_HOME`/PATH 校验可选 Java 21，并为每个 Gradle 根生成独立的哈希 workspace；无有效用户 JVM 时交给 Nix jdtls wrapper 使用自带 Java 21
- `nvim/lsp/kotlin_lsp.lua` 使用 JetBrains 官方 `kotlin-lsp --stdio`，通过 `root_markers` 识别 Gradle/Android 项目，禁止孤立 Kotlin 文件启动服务
- `nvim/lua/lsp.lua` 重写：`completeopt=menu,menuone,noselect,popup,fuzzy`；`pcall(packadd blink.cmp) → blink.get_lsp_capabilities → blink.setup{keymap preset default, completion.menu auto_show, signature, sources=lsp/path/snippets/buffer, fuzzy prefer_rust}` 失败回落原生 `make_client_capabilities + snippetSupport`；`inject_caps` 注入 `lua_ls/tsgo/clangd/jdtls/kotlin_lsp`；`enable{lua_ls,tsgo,clangd,jdtls,kotlin_lsp}`（**仅启 `kotlin_lsp`**）；`diagnostic` + `LspAttach` 分流 `blink`/`vim.lsp.completion`、启用 `inlay_hint`、映射 `K/gD/gr/gi/<leader>rn/ca/e/[d/]d`，命令 `LspCapabilitiesInfo`
- `nvim/lua/android/{init,util,sdk,resources,xml}.lua + README.md` 新增：SDK 源码跳转（`@ANDROID_HOME/$ANDROID_SDK_ROOT/local.properties: sdk.dir → ~/Android/Sdk` + `compileSdk release(36)+minorApiLevel→36.1 → sources/android-36.1` 有效性过滤）+ XML↔Kotlin 资源跳转（`R.layout / @string/@mipmap / <TextView> / <com.foo.Bar> / tools:context=".MainActivity"`），`gd` 智能覆盖、`gf` 增强、`:AndroidGoto/Sdk/Res/Info`
- `pi/models-store.json` 为 `pi` 自动生成，**忽略不移植**

**文件树（`~/dotfile/nvim`）：**
```
init.lua
lsp/{clangd,jdtls,kotlin_lsp,lua_ls,tsgo}.lua
lua/{lsp,android/{init,util,sdk,resources,xml,README.md},options,autocommands,...}.lua
```
`~/.config/nvim -> ~/dotfile/nvim`，验证 `nvim --headless -c "qa"` exit 0 且 `completeopt=menu,menuone,noselect,popup,fuzzy`、`_enabled_configs` 含 `kotlin_lsp`。

## 2. 在 NixOS 上要完成的剩余工作

**必须做（按序）：**
1. **声明 LSP 二进制**：`extraPackages`（或 `environment.systemPackages`）提供 `kotlin-lsp`（`intellij-server` 自带 jbr）、`jdt-language-server`、`lua-language-server`、`clangd`、`ripgrep`；`tsgo` 若无包则保留失败容错。**禁止硬编码 `/usr/bin|/usr/sbin|/usr/lib/jvm`**。
2. **修正 `lsp/jdtls.lua` 的 JVM 运行时**：不再硬编码 `/usr/lib/jvm/*`；优先校验 `vim.g.java_home`/`JAVA_HOME` 和 PATH 中的 Java 21，找不到时不传 `--java-executable`，交给 Nix jdtls wrapper 使用自带 Java 21。`JAVA_HOME` 仍用于 Gradle 项目导入。
3. **声明 Java**：`RomoteControl` 需 `jdk21`（jdtls 硬要求），`jdk17/jdk11` 可选留作回落；`gradle 9.1` 用 `jdk21/26` 均可，优先 `jdk21` 稳定。
4. **blink.cmp**：Arch 版 `pack/core/opt/blink.cmp` 预编译 `target/release/libblink_cmp_fuzzy.so`。NixOS 改用 `pkgs.vimPlugins.blink-cmp`（`home-manager.programs.neovim.plugins`）或保留 `packadd` 但确保 `fuzzy.implementation = "prefer_rust"` 在缺 `cargo` 时回落 `lua`。`lua/lsp.lua` 已兼容：`pcall(packadd)` 失败走原生分支，发版前需 `nvim --headless -c "lua require('blink.cmp').get_lsp_capabilities()"` 自检。
5. **Android SDK**：NixOS 无 `/home/.../Android/Sdk` 固定位。`android/util.lua` 已支持 `vim.g.android_sdk_dir` / `$ANDROID_HOME` / `local.properties` 三级回落，**在 NixOS 需显式设其一**：`home.sessionVariables.ANDROID_SDK_ROOT = "/home/<user>/Android/Sdk"` 或 `androidenv` 暴露，或在 `flake.nix` 写 `local.properties`。`sources/android-36.1` 需 `sdkmanager --install "sources;android-36"` 预装，空壳 `android-36` 已被过滤。
6. **home-manager 封装**：若用户用 `flake.nix + home-manager`，提供 `xdg.configFile."nvim".source = ./dotfile/nvim`（`recursive=true`）示例，保持 `~/.config/nvim` 符号链语义；或 `programs.neovim.extraLuaConfig = ''require("android").setup()''` 等价。**勿复制 `pi/models-store.json`**。

**可选/勿做：**
- 不引入 `mason.nvim`（已装但未启用，保持惰性）；
- 不添加或启用旧的 `kotlin-language-server` 配置；
- 不改 `android/` 五文件逻辑，仅同步。

## 3. 约束

- Nix 表达式中 `cmd` 禁止写死 Arch 绝对路径，统一用 `lib.getExe` 或 `PATH` 注入。
- `completeopt` 必须含 `menu,menuone,popup`，否则单候选不弹。
- `kotlin_lsp` 是唯一 Kotlin LSP；非 Gradle 的孤立 Kotlin 文件不自动启动服务。
- 保留 `~/.config/nvim -> ~/dotfile/nvim` 结构，`git status` 仅 `nvim/` 相关为脏。

## 4. 验收（在 NixOS 上逐条跑通）

```bash
nvim --headless -c "lua print(vim.o.completeopt)" -c qa          # → menu,menuone,noselect,popup,fuzzy
nvim --headless -c "lua print(vim.inspect(vim.lsp._enabled_configs))" -c qa  # 含 kotlin_lsp，无 kotlin_language_server
nvim --headless -c "lua vim.cmd.packadd('blink.cmp'); print(require('blink.cmp').get_lsp_capabilities and 'blink:ok')" -c qa
# 打开项目：
nvim ~/AndroidStudioProjects/RomoteControl/app/src/main/java/com/jiannlee22/romotecontrol/MainActivity.kt
# 期望：输入 `View.` / `Intent(` 自动弹 blink 菜单；:LspInfo 见 kotlin_lsp attached；:AndroidInfo 见 sources/android-36.1；:LspCapabilitiesInfo 见 blink.cmp；gd 在 View 上跳 sources，@string 跳 values/strings.xml；~/.local/state/nvim/lsp.log 无 "requires at least Java 21"
```

## 5. 输出

- 更新 `nvim/lsp/jdtls.lua` 的 Nix 适配分支（如 `if vim.fn.has('nvim-0.11')...` 或 `os.getenv('NIX_STORE')` 特判亦可）；
- 新增/更新 `flake.nix` / `home.nix` 片段（`extraPackages` + `sessionVariables` + `xdg.configFile`）并 `nix flake check`；
- `README` 或 `NIXOS.md` 追加移植说明。

> 粘贴本提示词后，AI 应先 `ctx_batch_execute` 探查 `git diff` 与 `nvim/` 树，再按 §2 逐项改写并跑 §4 验收，最后 `git status` 仅 `nvim/` 变更。
