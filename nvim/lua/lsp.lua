-- lsp: 统一启用 + 补全 + 诊断
-- 修复：1) completeopt 缺 menuone/popup 2) kotlin_language_server storagePath 启动期求值 3) jdtls 需要 java>=21 4) Android 项目推荐 kotlin_lsp

-- 补全选项：menuone 单候选也弹菜单，popup 显示文档，noselect 不自动选中
vim.o.completeopt = 'menu,menuone,noselect,popup,fuzzy'

-- 尝试启用 blink.cmp（已装于 pack/core/opt/blink.cmp），优先于原生 vim.lsp.completion
local blink_ok, blink = pcall(function()
  vim.cmd.packadd('blink.cmp')
  return require('blink.cmp')
end)

local capabilities = nil
if blink_ok then
  capabilities = blink.get_lsp_capabilities(nil, true)
  -- blink.cmp 默认配置（按需可在 lua/blink.lua 中覆盖）
  blink.setup({
    keymap = { preset = 'default' },
    appearance = { nerd_font_variant = 'mono' },
    completion = {
      documentation = { auto_show = false, auto_show_delay_ms = 400 },
      ghost_text = { enabled = false },
      menu = { auto_show = true },
    },
    signature = { enabled = true },
    sources = { default = { 'lsp', 'path', 'snippets', 'buffer' } },
    fuzzy = { implementation = 'prefer_rust' },
  })
else
  -- 回落：若 blink 不可用，确保原生补全的 capabilities 仍包含 snippet 等
  capabilities = vim.lsp.protocol.make_client_capabilities()
  capabilities.textDocument.completion.completionItem.snippetSupport = true
  capabilities.textDocument.completion.completionItem.resolveSupport = {
    properties = { 'documentation', 'detail', 'additionalTextEdits' },
  }
end

-- 将 capabilities 注入所有启用的 server（nvim 0.11+ 的 vim.lsp.config）
local function inject_caps(name)
  local ok, cfg = pcall(vim.lsp.config, name)
  if ok and cfg and capabilities then
    vim.lsp.config(name, { capabilities = capabilities })
  elseif capabilities then
    -- 若 config 尚未加载，先设全局再由 enable 时合并
    pcall(vim.lsp.config, name, { capabilities = capabilities })
  end
end

for _, srv in ipairs({ 'lua_ls', 'tsgo', 'clangd', 'jdtls', 'kotlin_lsp' }) do
  inject_caps(srv)
end
-- 可选：保留 kotlin_language_server 供纯 Kotlin 非 Android 项目手动启用
-- inject_caps('kotlin_language_server')

-- 启用 servers：Android 项目用 kotlin_lsp (intellij-server)，jdtls 仅对 java 生效
-- 注意：kotlin_language_server 与 kotlin_lsp 同 filetype=kotlin 会双开，故默认只启 kotlin_lsp
vim.lsp.enable({ 'lua_ls', 'tsgo', 'clangd', 'jdtls', 'kotlin_lsp' })

vim.diagnostic.config({
  virtual_text = true,
  underline = true,
  update_in_insert = false,
  severity_sort = true,
  float = { border = 'rounded', source = true },
})

-- 通用 LspAttach：补全、悬浮、诊断、inlayHint
vim.api.nvim_create_autocmd('LspAttach', {
  callback = function(ev)
    local client = vim.lsp.get_client_by_id(ev.data.client_id)
    if not client then return end
    local bufnr = ev.buf

    -- 原生补全：仅在 blink 未接管时启用 autotrigger
    if not blink_ok and client:supports_method('textDocument/completion') then
      pcall(vim.lsp.completion.enable, true, client.id, bufnr, { autotrigger = true })
    end

    -- inlay hints (若 server 支持)
    if client:supports_method('textDocument/inlayHint') then
      pcall(vim.lsp.inlay_hint.enable, true, { bufnr = bufnr })
    end

    -- 基础键位（不覆盖 android 的 gd/gf，android 插件会用 buffer-local 覆盖）
    local map = function(mode, lhs, rhs, desc)
      vim.keymap.set(mode, lhs, rhs, { buffer = bufnr, silent = true, desc = desc })
    end
    map('n', 'K', vim.lsp.buf.hover, 'LSP hover')
    map('n', 'gD', vim.lsp.buf.definition, 'LSP definition')
    map('n', 'gr', vim.lsp.buf.references, 'LSP references')
    map('n', 'gi', vim.lsp.buf.implementation, 'LSP implementation')
    map('n', '<leader>rn', vim.lsp.buf.rename, 'LSP rename')
    map({ 'n', 'v' }, '<leader>ca', vim.lsp.buf.code_action, 'LSP code action')
    map('n', '<leader>e', vim.diagnostic.open_float, 'Diagnostic float')
    map('n', '[d', function() vim.diagnostic.jump({ count = -1, float = true }) end, 'Prev diagnostic')
    map('n', ']d', function() vim.diagnostic.jump({ count = 1, float = true }) end, 'Next diagnostic')

    -- 手动触发补全：C-Space (blink 已有映射，此处仅为原生回落)
    if not blink_ok then
      map('i', '<C-Space>', '<C-x><C-o>', 'Trigger completion')
    end
  end,
})

-- 若用户手动 :packadd blink.cmp 后，需重启或执行此命令重算
vim.api.nvim_create_user_command('LspCapabilitiesInfo', function()
  local caps = capabilities and 'blink.cmp' or 'native'
  vim.notify('LSP capabilities source: ' .. caps .. '\nServers: lua_ls, tsgo, clangd, jdtls(+java21), kotlin_lsp(intellij-server)', vim.log.levels.INFO)
end, { desc = 'Show LSP completion source' })
