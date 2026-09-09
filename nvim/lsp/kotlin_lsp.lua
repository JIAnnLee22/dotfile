---@brief JetBrains 官方 Kotlin LSP（Nix 提供 kotlin-lsp 命令）
--- Android Gradle 支持仍为上游实验性功能。EAP 构建过期时需要更新 Nix 包。
--- 更新与验证步骤见 nixos-config/docs/kotlin-lsp.md。
---@type vim.lsp.Config
return {
  filetypes = { 'kotlin' },
  cmd = { 'kotlin-lsp', '--stdio' },
  -- The official server is a Gradle/Android workspace server. Do not start it
  -- for an isolated Kotlin file, where it cannot resolve project dependencies.
  workspace_required = true,
  root_markers = {
    'settings.gradle', -- Gradle (multi-project)
    'settings.gradle.kts',
    'gradlew', -- 优先识别 Android 项目根
    'pom.xml',
    'build.gradle',
    'build.gradle.kts',
    'workspace.json',
  },
  -- JetBrains LSP 自带 jbr，无需额外 init_options；若需调优可在 before_init 注入
}
