# Neovim 开发环境

Neovim 0.11+，使用原生 LSP。此 NixOS 仓库的 `home/lsp-servers.nix` 提供 Rust/C/Android 所需的语言服务器与 Rust 工具链。更新 NixOS 配置后重新打开 Neovim。

| 语言 | `gd` 跳转 | 项目要求 |
|---|---|---|
| Rust | 项目、Cargo 依赖和 Rust 标准库源码 | 从含 `Cargo.toml` 或 `rust-project.json` 的项目打开文件。Nix 自带标准库源码；若用 rustup，从项目工具链环境启动 Neovim，并运行 `rustup component add rust-src`。 |
| C/C++ | 源文件、头文件、当前编译命令可见的库及 NDK 头文件 | 生成 `compile_commands.json`。clangd 可发现项目下的 `build/compile_commands.json`；其他目录见下文。 |
| Android | Kotlin / Java 定义、Android SDK 源码、XML 资源 | Kotlin 用 JetBrains 官方 `kotlin-lsp`，Java 用 `jdtls`（JDK 21+）。语义跳转需要 Gradle 导入成功，并安装项目 `compileSdk` 对应的 SDK 源码。 |

- `gD`：直接走语言服务器定义；Android SDK 和依赖归档仍会转换为可读源码。
- `gr` / `gi` / `K`：引用、实现、悬浮文档；`Ctrl-o` 返回跳转前的位置。
- `:LspCapabilitiesInfo` 看补全配置，`:checkhealth vim.lsp` 看服务和项目根。

## C/C++ 与 Android NDK

CMake 项目用 `cmake -S . -B build -DCMAKE_EXPORT_COMPILE_COMMANDS=ON`；Meson 项目的 `meson setup build` 会生成编译数据库。使用项目的依赖环境（例如 `nix develop`）生成数据库并启动 Neovim，否则语言服务可能找不到系统头文件。非默认构建目录可以在项目 `.clangd` 配置，例如：

```yaml
CompileFlags:
  CompilationDatabase: out/debug
```

Android NDK 的 C/C++ 项目，先通过 Gradle / CMake 生成相应 ABI 的 `.cxx/.../compile_commands.json`，再将 `CompilationDatabase` 指向**包含该文件的目录**。不要把宿主编译数据库用于 Android 交叉编译。

## Android SDK

`:AndroidInfo` 查看本文件所属模块的 `compileSdk` 和源码目录，`:AndroidSdk android.view.View` 可直接打开 framework 源码。在 Java/Kotlin 的 `import android.view.View` 上按 `gd`，即使 Gradle 导入没完成，也能跳到已安装的 SDK 源码。AndroidX 不属于平台 SDK；跳它需要 Gradle 导入成功及对应依赖源码。更多说明见 [Android 跳转](lua/android/README.md)。
