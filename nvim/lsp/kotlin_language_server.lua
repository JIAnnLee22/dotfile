-- fwcd kotlin-language-server (旧版，用于非 Android 纯 Kotlin 项目)
-- 注意：Android 项目推荐用 kotlin_lsp (intellij-server)，此 server 对 AGP 9 + Kotlin 2.3 支持不完整
-- 保留此配置仅作备用，若同时启用 kotlin_lsp 会双开，注意 lua/lsp.lua 中只启用其一
local root_files = {
  'settings.gradle',
  'settings.gradle.kts',
  'build.xml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
}

---@type vim.lsp.Config
return {
  filetypes = { 'kotlin' },
  root_markers = root_files,
  cmd = { 'kotlin-language-server' },
  -- 修复：之前在此处 vim.fs.root(expand('%:p:h')) 在 init 阶段就求值，导致非项目目录启动时 storagePath 错误
  -- 改为按 workspace 动态计算，不在加载期读取当前 buffer
  init_options = {
    -- 使用 nvim cache 统一缓存，避免污染项目根；若需 per-project 可改用 before_init 注入 root_dir
    storagePath = vim.fn.stdpath('cache') .. '/kotlin-language-server',
  },
  -- 按需：若希望缓存落在项目根，取消下面注释 (会为每个项目创建独立 DB)
  -- before_init = function(init, config)
  --   if config.root_dir then
  --     init.init_options = init.init_options or {}
  --     init.init_options.storagePath = config.root_dir
  --   end
  -- end,
}
