---@brief JetBrains 官方 Kotlin LSP (intellij-server)
--- 基于 IntelliJ 的 Kotlin 插件，Android + Kotlin 2.3 + Gradle 9 推荐用此 server
--- 取代 fwcd/kotlin-language-server (后者已停更，对 AGP 9 支持差)
---@type vim.lsp.Config
return {
  filetypes = { 'kotlin' },
  cmd = { 'intellij-server', '--stdio' },
  root_markers = {
    'settings.gradle', -- Gradle (multi-project)
    'settings.gradle.kts',
    'gradlew', -- 优先识别 Android 项目根
    '.git',
    'pom.xml',
    'build.gradle',
    'build.gradle.kts',
    'workspace.json',
  },
  -- JetBrains LSP 自带 jbr，无需额外 init_options；若需调优可在 before_init 注入
}
